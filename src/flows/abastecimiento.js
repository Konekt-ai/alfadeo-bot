// Flujo conversacional de ALFA-DEO.
//
// Sigue el orden REAL de compra que se documentó en la reunión (minuta 4):
//   1. ¿Tienen existencia?   -> se consulta inventario de verdad (minuta 2)
//   2. ¿Cuánto cuesta?       -> lo confirma un asesor, nunca el bot
//   3. ¿Cuándo entregan?     -> se calcula con el calendario DHL (minuta 5)
//   4. ¿Requiere factura?    -> al final, que es cuando el cliente la pide (minuta 1)
//
// Dos decisiones de diseño que vale la pena tener presentes:
//
//   · El menú es opcional. En la conversación real que se compartió (minuta 39)
//     el cliente escribe "buenas tardes, tiene ondansetron 8mg?" y ya. El bot
//     entiende eso en cualquier paso; el menú sólo es la red de seguridad.
//
//   · Las preguntas frecuentes se contestan SIN perder el paso actual. Si a
//     mitad de la captura preguntan "¿y cuándo llega?", se responde y se
//     retoma donde iba.
import { sql, uno, registrarMensaje } from '../lib/db.js';
import { sendText, sendButtons, markRead } from '../lib/whatsapp.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { FAQ, respuestaInfo } from './faq.js';
import { INTENCION, detectarIntenciones, requiereHumano, pareceProducto } from './intenciones.js';
import {
  normalizar, esAfirmativo, esNegativo, pideMenu, extraerCantidad,
  titulo, recortar,
} from '../utils/texto.js';
import {
  buscarProductos, limpiarConsulta, hayExistencia, nombreProducto,
  fichaProducto, disponibilidadTexto, sucursalesConStock, listaOpciones,
} from '../services/catalogo.js';
import { mensajeEntrega, avisoClienteNuevo, lineaEntregaCorta } from '../services/entrega.js';
import { resolverSucursal, idSucursal, notificarAsesor } from '../services/ruteo.js';
import {
  extraerDatosFiscales, datosFiscalesCompletos, siguienteDatoFiscal,
  validarDatoFiscal, resumenFiscal, avisoIVA,
} from '../services/facturacion.js';
import {
  obtenerCliente, upsertCliente, crearSolicitudConItems,
  normalizarTipoCliente, normalizarUrgencia,
} from '../services/solicitudes.js';
import { evaluarEscalamiento } from '../services/escalamiento.js';

// Ventana de servicio de WhatsApp: 24 horas.
const VENTANA_MS = 24 * 60 * 60 * 1000;

// Máximo de coincidencias que se le muestran al cliente de un jalón.
const MAX_OPCIONES = 5;

const PASO = {
  INICIO: 'inicio',
  MENU: 'menu',
  INFO: 'info',
  PRODUCTO: 'producto',
  ELEGIR: 'elegir',
  CANTIDAD: 'cantidad',
  MAS_PRODUCTOS: 'mas_productos',
  CAP_NOMBRE: 'cap_nombre',
  CAP_EMPRESA: 'cap_empresa',
  CAP_CIUDAD: 'cap_ciudad',
  FACTURA: 'factura',
  FACT_DATO: 'fact_dato',
  CONFIRMAR: 'confirmar',
  FIN: 'fin',
};

// Pasos en los que una intención NO debe dispararse como pregunta frecuente,
// porque el paso ya está esperando justamente esa respuesta.
const PASO_CONSUME = {
  [PASO.FACTURA]: [INTENCION.FACTURA],
  [PASO.FACT_DATO]: [INTENCION.FACTURA],
  [PASO.CAP_CIUDAD]: [INTENCION.UBICACION],
  [PASO.INFO]: [INTENCION.HORARIO, INTENCION.UBICACION, INTENCION.FACTURA, INTENCION.ENTREGA],
};

// "urge", "para hoy", "lo antes posible": marca la solicitud como urgente y
// dispara el escalamiento aunque nunca se pregunte la urgencia explícitamente.
const RE_URGENCIA = /\b(urge|urgent\w*|inmediat\w*|para hoy|emergenc\w*|lo antes posible|asap|ya mismo)\b/;

// ===================== Persistencia de la conversación =====================

async function obtenerConversacion(wa_id) {
  const { data, error } = await uno(
    'select * from conversaciones where wa_id = $1',
    [wa_id]
  );
  if (error) {
    logger.warn('obtenerConversacion falló:', error.message);
    return null;
  }
  return data;
}

async function guardarConversacion(wa_id, paso, contexto, cliente_id = null) {
  const ahora = new Date();

  // El coalesce del cliente_id reproduce lo que antes se hacía en JS quitando
  // la clave del objeto: si en esta llamada no viene cliente_id, NO se pisa el
  // que ya estuviera guardado. Es lo que evita perder el vínculo con el
  // cliente a media conversación.
  const { error } = await sql(
    `insert into conversaciones
       (wa_id, paso, contexto, ultima_actividad, ventana_servicio_expira, cliente_id)
     values ($1, $2, $3::jsonb, $4, $5, $6)
     on conflict (wa_id) do update set
       paso                    = excluded.paso,
       contexto                = excluded.contexto,
       ultima_actividad        = excluded.ultima_actividad,
       ventana_servicio_expira = excluded.ventana_servicio_expira,
       cliente_id              = coalesce(excluded.cliente_id, conversaciones.cliente_id)`,
    [
      wa_id,
      paso,
      JSON.stringify(contexto ?? {}),
      ahora.toISOString(),
      new Date(ahora.getTime() + VENTANA_MS).toISOString(),
      cliente_id || null,
    ]
  );
  if (error) logger.warn('guardarConversacion falló:', error.message);
}

// ===================== Envío + registro =====================

/** Envía texto y lo deja registrado en `mensajes`. */
async function responder(wa_id, texto) {
  const res = await sendText(wa_id, texto);
  await registrarMensaje({
    wa_id,
    direccion: 'out',
    tipo: 'text',
    cuerpo: texto,
    payload: res.ok ? null : { error: res.data },
  });
}

/** Envía una pregunta con botones (cae a texto solo si Meta la rechaza). */
async function responderBotones(wa_id, texto, botones) {
  const res = await sendButtons(wa_id, texto, botones);
  await registrarMensaje({
    wa_id,
    direccion: 'out',
    tipo: 'interactive',
    cuerpo: texto,
    payload: { botones, ok: res.ok },
  });
}

// ===================== Manejador principal =====================

/**
 * Procesa un mensaje entrante y avanza la máquina de estados.
 * Se invoca de forma asíncrona: el webhook ya respondió 200 a Meta.
 *
 * @param {{wa_id: string, texto: string, replyId?: string|null, messageId?: string,
 *          nombrePerfil?: string, tipo?: string, raw?: object}} inbound
 */
export async function manejarMensaje(inbound) {
  const { wa_id, texto } = inbound;

  // 1) Registrar el entrante siempre, pase lo que pase después.
  await registrarMensaje({
    wa_id,
    direccion: 'in',
    tipo: inbound.tipo ?? 'text',
    cuerpo: texto,
    payload: inbound.raw ?? null,
  });

  markRead(inbound.messageId);

  // 2) Estado previo. Si la ventana de 24 h venció, se arranca de cero.
  const conv = await obtenerConversacion(wa_id);
  let paso = conv?.paso ?? PASO.INICIO;
  let contexto = conv?.contexto ?? {};
  let cliente_id = conv?.cliente_id ?? null;

  const ventanaVencida =
    !conv?.ultima_actividad ||
    Date.now() - new Date(conv.ultima_actividad).getTime() > VENTANA_MS;
  if (ventanaVencida) {
    paso = PASO.INICIO;
    contexto = {};
  }

  if (inbound.nombrePerfil && !contexto.nombrePerfil) {
    contexto.nombrePerfil = inbound.nombrePerfil;
  }

  // 3) ¿Ya lo conocemos? Define si hay que darle el aviso de tiempos (minuta 6)
  //    y qué datos ya no hace falta volver a pedirle.
  if (contexto.clienteNuevo === undefined) {
    const cliente = await obtenerCliente(wa_id);
    contexto.clienteNuevo = !cliente;
    if (cliente) {
      cliente_id = cliente.id;
      contexto.nombre ??= cliente.nombre ?? undefined;
      contexto.empresa ??= cliente.empresa ?? undefined;
      contexto.ciudad ??= cliente.ciudad ?? undefined;
      contexto.tipo ??= cliente.tipo ?? undefined;
      // Si ya facturó antes, sus datos fiscales se reutilizan (minuta 1).
      if (cliente.rfc && cliente.razon_social) {
        contexto.fiscalPrevio = {
          razon_social: cliente.razon_social,
          rfc: cliente.rfc,
          cp: cliente.cp_fiscal ?? undefined,
          correo: cliente.correo_facturacion ?? cliente.correo ?? undefined,
          uso_cfdi: cliente.uso_cfdi ?? undefined,
        };
      }
    }
  }

  const intenciones = detectarIntenciones(texto);

  // La urgencia no se pregunta (no está en el flujo de la minuta 4), se detecta.
  if (RE_URGENCIA.test(normalizar(texto))) {
    contexto.urgenciaTexto = texto;
  }

  try {
    // 4) Atajos globales, en orden de prioridad.

    // Si el escalamiento cae en el PRIMER mensaje, el cliente recibiría un
    // "un asesor te contacta" a secas, sin saludo ni acuse de lo que preguntó.
    const primerContacto = paso === PASO.INICIO;

    // Licitaciones, quejas y devoluciones nunca las contesta el bot.
    if (requiereHumano(texto)) {
      await escalar(wa_id, contexto, cliente_id, ['tema que requiere atención personal'], primerContacto);
      return;
    }

    if (intenciones.includes(INTENCION.ASESOR)) {
      await escalar(wa_id, contexto, cliente_id, ['el cliente pidió hablar con una persona'], primerContacto);
      return;
    }

    if (pideMenu(texto) && paso !== PASO.INICIO) {
      await responder(wa_id, FAQ.menu);
      await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
      return;
    }

    // 5) Preguntas frecuentes en línea: se contestan sin perder el paso.
    const consumidas = PASO_CONSUME[paso] ?? [];
    const pendientes = intenciones.filter((i) => !consumidas.includes(i));
    const contestadaEnLinea = await contestarEnLinea({
      wa_id, texto, paso, contexto, cliente_id, intenciones: pendientes,
    });
    if (contestadaEnLinea) return;

    // 6) Máquina de estados.
    await procesarPaso({ wa_id, texto, replyId: inbound.replyId, paso, contexto, cliente_id, intenciones });
  } catch (err) {
    logger.error(`manejarMensaje error (wa_id=${wa_id}):`, err?.message ?? err);
    await responder(wa_id, FAQ.errorTecnico);
  }
}

/**
 * Contesta una pregunta frecuente sin mover el paso actual (minuta 2).
 * Devuelve true si ya respondió y no hay que seguir procesando.
 */
async function contestarEnLinea({ wa_id, texto, paso, contexto, cliente_id, intenciones }) {
  // Sólo aplica a mitad de un flujo ya arrancado; al inicio manda el flujo normal.
  const enCaptura = [
    PASO.CANTIDAD, PASO.MAS_PRODUCTOS, PASO.CAP_NOMBRE, PASO.CAP_EMPRESA,
    PASO.CAP_CIUDAD, PASO.FACTURA, PASO.FACT_DATO, PASO.CONFIRMAR, PASO.ELEGIR,
  ].includes(paso);
  if (!enCaptura) return false;

  const consulta = limpiarConsulta(texto);
  // Si además viene un nombre de producto, no interrumpimos: manda el flujo.
  if (pareceProducto(texto, consulta) && intenciones.includes(INTENCION.EXISTENCIA)) {
    return false;
  }
  // "¿cuánto cuesta 20 piezas?" trae la cantidad que estábamos pidiendo:
  // se deja pasar al flujo para no perderla y volver a preguntar lo mismo.
  if (paso === PASO.CANTIDAD && extraerCantidad(texto)) {
    return false;
  }

  let respuesta = null;

  if (intenciones.includes(INTENCION.PRECIO)) {
    respuesta = FAQ.precio;
  } else if (intenciones.includes(INTENCION.ENTREGA)) {
    respuesta = mensajeEntrega({ enExistencia: itemsEnExistencia(contexto) });
  } else if (intenciones.includes(INTENCION.FACTURA)) {
    respuesta = FAQ.facturaInfo;
  } else if (intenciones.includes(INTENCION.HORARIO)) {
    respuesta = FAQ.horario;
  } else if (intenciones.includes(INTENCION.UBICACION)) {
    respuesta = FAQ.quienesSomos;
  }

  if (!respuesta) return false;

  await responder(wa_id, respuesta);
  // Y se retoma exactamente donde iba.
  await responder(wa_id, preguntaDelPaso(paso, contexto));
  await guardarConversacion(wa_id, paso, contexto, cliente_id);
  return true;
}

/** Reformula la pregunta del paso actual, para retomar tras un desvío. */
function preguntaDelPaso(paso, contexto) {
  switch (paso) {
    case PASO.ELEGIR:
      return 'Volviendo a lo tuyo: responde con el *número* de la opción que necesitas.';
    case PASO.CANTIDAD:
      return `Volviendo a lo tuyo: ¿*cuántas piezas* necesitas de ${recortar(contexto.productoActual?.etiqueta ?? 'este producto', 50)}?`;
    case PASO.MAS_PRODUCTOS:
      return '¿Necesitas *algo más*? Escríbeme el siguiente producto, o *no* para continuar.';
    case PASO.CAP_NOMBRE:
      return 'Volviendo a lo tuyo: ¿cuál es tu *nombre*?';
    case PASO.CAP_EMPRESA:
      return 'Volviendo a lo tuyo: ¿cuál es tu *empresa o institución*?';
    case PASO.CAP_CIUDAD:
      return 'Volviendo a lo tuyo: ¿en qué *ciudad* requieres la entrega?';
    case PASO.FACTURA:
      return FAQ.preguntaFactura;
    case PASO.FACT_DATO:
      return siguienteDatoFiscal(contexto.fiscal ?? {})?.pregunta ?? FAQ.preguntaFactura;
    case PASO.CONFIRMAR:
      return 'Responde *sí* para registrar tu solicitud o *no* para corregir.';
    default:
      return FAQ.pedirProducto;
  }
}

// ===================== Máquina de estados =====================

async function procesarPaso({ wa_id, texto, replyId, paso, contexto, cliente_id, intenciones }) {
  switch (paso) {
    // ---------------------------------------------------------------
    case PASO.INICIO: {
      const saludo = contexto.clienteNuevo
        ? `${FAQ.bienvenida}\n\n${avisoClienteNuevo()}`
        : `¡Hola de nuevo${contexto.nombre ? `, ${titulo(contexto.nombre)}` : ''}! 👋`;

      await responder(wa_id, saludo);

      // Si el primer mensaje YA trae un producto, se busca de una vez.
      // Es lo que pasa en la vida real: "buenas, tiene ondansetron 8mg?"
      const consulta = limpiarConsulta(texto);
      if (pareceProducto(texto, consulta)) {
        await buscarYResponder({ wa_id, texto, contexto, cliente_id });
        return;
      }

      await responder(wa_id, FAQ.pedirProducto);
      await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.MENU: {
      const t = normalizar(texto);

      // Sólo el número pelón cuenta como elección de menú. Si además escribió
      // el producto ("1 ondansetron" o "tienen ondansetron"), manda el producto:
      // preguntarle el nombre otra vez cuando ya lo dio es lo que hace que la
      // gente abandone el chat.
      if (/^[123]$/.test(t)) {
        if (t === '1') {
          await responder(wa_id, FAQ.pedirProducto);
          await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
          return;
        }
        if (t === '2') {
          await responder(wa_id, FAQ.infoMenu);
          await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
          return;
        }
        await escalar(wa_id, contexto, cliente_id, ['el cliente pidió hablar con una persona']);
        return;
      }

      const consulta = limpiarConsulta(texto);
      if (pareceProducto(texto, consulta)) {
        await buscarYResponder({ wa_id, texto, contexto, cliente_id });
        return;
      }

      if (/^1\b/.test(t) || intenciones.includes(INTENCION.EXISTENCIA)) {
        await responder(wa_id, FAQ.pedirProducto);
        await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
        return;
      }
      if (/^2\b/.test(t) || /^info/.test(t)) {
        await responder(wa_id, FAQ.infoMenu);
        await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
        return;
      }
      if (/^3\b/.test(t)) {
        await escalar(wa_id, contexto, cliente_id, ['el cliente pidió hablar con una persona']);
        return;
      }

      await responder(wa_id, `${FAQ.noEntendido}\n\n${FAQ.menu}`);
      await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.INFO: {
      const resp = respuestaInfo(normalizar(texto));
      if (resp) {
        await responder(wa_id, `${resp}\n\n_Escribe *menú* para volver._`);
        await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
        return;
      }

      const consulta = limpiarConsulta(texto);
      if (pareceProducto(texto, consulta)) {
        await buscarYResponder({ wa_id, texto, contexto, cliente_id });
        return;
      }

      await responder(wa_id, `${FAQ.noEntendido}\n\n${FAQ.infoMenu}`);
      await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.PRODUCTO: {
      await buscarYResponder({ wa_id, texto, contexto, cliente_id });
      return;
    }

    // ---------------------------------------------------------------
    case PASO.ELEGIR: {
      const candidatos = contexto.candidatos ?? [];
      const n = extraerCantidad(texto);

      if (n && n >= 1 && n <= candidatos.length) {
        await seleccionarProducto({ wa_id, producto: candidatos[n - 1], contexto, cliente_id });
        return;
      }

      // No eligió número: probablemente escribió otro producto.
      const consulta = limpiarConsulta(texto);
      if (pareceProducto(texto, consulta)) {
        await buscarYResponder({ wa_id, texto, contexto, cliente_id });
        return;
      }

      await responder(
        wa_id,
        `Responde con el *número* de la opción (del 1 al ${candidatos.length}), ` +
          'o escríbeme otro nombre de producto.'
      );
      await guardarConversacion(wa_id, PASO.ELEGIR, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.CANTIDAD: {
      const cantidad = extraerCantidad(texto);
      const actual = contexto.productoActual;

      if (!actual) {
        // Estado inconsistente: se regresa a pedir producto.
        await responder(wa_id, FAQ.pedirProducto);
        await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
        return;
      }

      if (!cantidad || cantidad <= 0) {
        await responder(
          wa_id,
          '¿*Cuántas piezas* necesitas? Respóndeme sólo con el número.\n_Ejemplo: 20_'
        );
        await guardarConversacion(wa_id, PASO.CANTIDAD, contexto, cliente_id);
        return;
      }

      contexto.items = contexto.items ?? [];
      contexto.items.push({ ...actual, cantidad });
      contexto.productoActual = null;
      contexto.candidatos = null;

      // Minuta 2 y 5: en cuanto sabemos qué y cuánto, se dan precio y entrega.
      const partes = [
        `✅ Anotado: *${cantidad} pz* de ${actual.etiqueta}`,
        '',
        FAQ.precioBreve,
        '',
        mensajeEntrega({ enExistencia: actual.enExistencia }),
      ];
      await responder(wa_id, partes.join('\n'));

      await responderBotones(
        wa_id,
        '¿Necesitas *algo más*?',
        [
          { id: 'mas_no', titulo: 'Eso es todo' },
          { id: 'mas_si', titulo: 'Agregar otro' },
        ]
      );
      await guardarConversacion(wa_id, PASO.MAS_PRODUCTOS, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.MAS_PRODUCTOS: {
      if (replyId === 'mas_si' || (esAfirmativo(texto) && normalizar(texto).length < 12)) {
        await responder(wa_id, FAQ.pedirProducto);
        await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
        return;
      }

      if (replyId === 'mas_no' || esNegativo(texto) || /^(eso es todo|ya|nada mas|solo eso|es todo)/.test(normalizar(texto))) {
        await avanzarADatos({ wa_id, contexto, cliente_id });
        return;
      }

      // Escribió directamente otro producto.
      const consulta = limpiarConsulta(texto);
      if (pareceProducto(texto, consulta)) {
        await buscarYResponder({ wa_id, texto, contexto, cliente_id });
        return;
      }

      await responder(wa_id, 'Escríbeme el siguiente producto, o *no* si eso es todo.');
      await guardarConversacion(wa_id, PASO.MAS_PRODUCTOS, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.CAP_NOMBRE: {
      contexto.nombre = texto.trim();
      await responder(
        wa_id,
        `Gracias, ${titulo(contexto.nombre)}. ¿Cuál es tu *empresa o institución*?\n` +
          '_Si eres particular, escribe *particular*._'
      );
      await guardarConversacion(wa_id, PASO.CAP_EMPRESA, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.CAP_EMPRESA: {
      const t = texto.trim();
      contexto.empresa = /^particular$/i.test(t) ? null : t;
      contexto.tipo = normalizarTipoCliente(t);
      await responder(wa_id, '¿En qué *ciudad* requieres la entrega?');
      await guardarConversacion(wa_id, PASO.CAP_CIUDAD, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.CAP_CIUDAD: {
      contexto.ciudad = texto.trim();
      await preguntarFactura({ wa_id, contexto, cliente_id });
      return;
    }

    // ---------------------------------------------------------------
    // Minuta 1 · ¿Requiere factura?
    // ---------------------------------------------------------------
    case PASO.FACTURA: {
      const quiere =
        replyId === 'fact_si' || (replyId !== 'fact_no' && esAfirmativo(texto));
      const noQuiere = replyId === 'fact_no' || esNegativo(texto);

      if (!quiere && !noQuiere) {
        await responderBotones(wa_id, FAQ.preguntaFactura, [
          { id: 'fact_si', titulo: 'Sí, con factura' },
          { id: 'fact_no', titulo: 'No, sin factura' },
        ]);
        await guardarConversacion(wa_id, PASO.FACTURA, contexto, cliente_id);
        return;
      }

      contexto.requiereFactura = quiere;

      if (!quiere) {
        await responder(wa_id, '👍 Perfecto, sin factura.');
        await mostrarResumen({ wa_id, contexto, cliente_id });
        return;
      }

      // Si ya facturó antes, se le ofrecen sus datos guardados.
      if (datosFiscalesCompletos(contexto.fiscalPrevio)) {
        contexto.fiscal = { ...contexto.fiscalPrevio };
        await responder(
          wa_id,
          `🧾 Uso los datos que ya tengo registrados:\n\n${resumenFiscal(contexto.fiscal)}\n\n` +
            '_Si cambió algo, escríbeme el dato correcto; si están bien, seguimos._'
        );
        await mostrarResumen({ wa_id, contexto, cliente_id });
        return;
      }

      contexto.fiscal = contexto.fiscal ?? {};
      await responder(wa_id, `${FAQ.facturaSinIVA}`);
      await pedirSiguienteDatoFiscal({ wa_id, contexto, cliente_id });
      return;
    }

    // ---------------------------------------------------------------
    case PASO.FACT_DATO: {
      contexto.fiscal = contexto.fiscal ?? {};

      // El cliente pudo pegar toda su constancia de un jalón: se aprovecha.
      const detectados = extraerDatosFiscales(texto);
      const campoEsperado = contexto.campoFiscal;

      let capturoAlgo = false;
      for (const [clave, valor] of Object.entries(detectados)) {
        if (!contexto.fiscal[clave] && valor) {
          contexto.fiscal[clave] = clave === 'razon_social' ? String(valor).toUpperCase() : valor;
          capturoAlgo = true;
        }
      }

      // Si no se detectó nada estructurado, se toma como el campo que se pidió.
      if (!contexto.fiscal[campoEsperado]) {
        const r = validarDatoFiscal(campoEsperado, texto);
        if (!r.ok) {
          await responder(wa_id, `⚠️ ${r.error}`);
          await pedirSiguienteDatoFiscal({ wa_id, contexto, cliente_id });
          return;
        }
        contexto.fiscal[campoEsperado] = r.valor;
        capturoAlgo = true;
      }

      if (!capturoAlgo) {
        await responder(wa_id, '⚠️ No pude leer ese dato. ¿Me lo escribes de nuevo?');
      }

      await pedirSiguienteDatoFiscal({ wa_id, contexto, cliente_id });
      return;
    }

    // ---------------------------------------------------------------
    case PASO.CONFIRMAR: {
      if (esAfirmativo(texto) || replyId === 'conf_si') {
        await finalizarSolicitud({ wa_id, contexto, cliente_id });
        return;
      }
      if (esNegativo(texto) || replyId === 'conf_no') {
        await escalar(wa_id, contexto, cliente_id, ['el cliente quiere corregir su solicitud']);
        return;
      }
      await responderBotones(wa_id, 'Responde para continuar:', [
        { id: 'conf_si', titulo: 'Confirmar' },
        { id: 'conf_no', titulo: 'Corregir' },
      ]);
      await guardarConversacion(wa_id, PASO.CONFIRMAR, contexto, cliente_id);
      return;
    }

    // ---------------------------------------------------------------
    case PASO.FIN:
    default: {
      // Conversación cerrada: cualquier mensaje nuevo arranca de cero,
      // pero conservando lo que ya sabemos del cliente.
      const limpio = {
        nombrePerfil: contexto.nombrePerfil,
        clienteNuevo: false,
        nombre: contexto.nombre,
        empresa: contexto.empresa,
        ciudad: contexto.ciudad,
        tipo: contexto.tipo,
        fiscalPrevio: contexto.fiscalPrevio,
      };
      await procesarPaso({
        wa_id, texto, replyId, paso: PASO.INICIO, contexto: limpio, cliente_id, intenciones,
      });
      return;
    }
  }
}

// ===================== Búsqueda de producto (minuta 2, 17-20) =====================

/**
 * Busca lo que pidió el cliente y responde disponibilidad real.
 * Es el corazón de "¿tienen el medicamento?".
 */
async function buscarYResponder({ wa_id, texto, contexto, cliente_id }) {
  const resultados = await buscarProductos(texto, MAX_OPCIONES);

  // --- Nada encontrado ---------------------------------------------------
  if (resultados.length === 0) {
    contexto.intentosFallidos = (contexto.intentosFallidos ?? 0) + 1;

    if (contexto.intentosFallidos >= 2) {
      // A la segunda, mejor una persona que seguir adivinando.
      await responder(
        wa_id,
        'No logro localizar ese producto en el catálogo. ' +
          'Te paso con un asesor para que lo busque contigo. 🙋'
      );
      await escalar(wa_id, contexto, cliente_id, [
        `no se encontró en catálogo: "${recortar(texto, 60)}"`,
      ]);
      return;
    }

    await responder(wa_id, FAQ.sinResultados);
    await guardarConversacion(wa_id, PASO.PRODUCTO, contexto, cliente_id);
    return;
  }

  contexto.intentosFallidos = 0;

  // --- Una sola coincidencia: se toma directo ---------------------------
  if (resultados.length === 1) {
    await seleccionarProducto({ wa_id, producto: resultados[0], contexto, cliente_id });
    return;
  }

  // --- Varias: el cliente elige (minuta 18) -----------------------------
  contexto.candidatos = resultados;
  const conStock = resultados.filter(hayExistencia).length;

  const encabezado =
    conStock > 0
      ? `✅ Sí lo manejamos. Encontré *${resultados.length} opciones*:`
      : `Encontré *${resultados.length} opciones* en el catálogo:`;

  await responder(
    wa_id,
    `${encabezado}\n\n${listaOpciones(resultados)}\n\n` +
      '✅ = en existencia   ⏳ = lo pedimos a proveedor\n\n' +
      'Respóndeme con el *número* de la que necesitas.'
  );
  await guardarConversacion(wa_id, PASO.ELEGIR, contexto, cliente_id);
}

/**
 * Ya identificamos UN producto: se confirma la ficha, se dice si hay existencia
 * y en qué plaza (minuta 28), y se pide la cantidad.
 */
async function seleccionarProducto({ wa_id, producto, contexto, cliente_id }) {
  const enExistencia = hayExistencia(producto);
  const plazas = disponibilidadTexto(producto);

  contexto.productoActual = {
    producto_id: producto.producto_id,
    etiqueta: nombreProducto(producto),
    nombre: producto.nombre,
    enExistencia,
    sucursales: sucursalesConStock(producto),
    tasa_iva: producto.tasa_iva,
    controlado: producto.controlado,
    presentacion: producto.presentacion,
    concentracion: producto.concentracion,
  };
  contexto.candidatos = null;

  const partes = [];

  // Respuesta a "¿tienen el medicamento?" (minuta 2), con plaza (minuta 28).
  if (env.BOT_DA_EXISTENCIA && enExistencia) {
    partes.push(`✅ *Sí lo tenemos disponible* en ${plazas}.`);
  } else if (env.BOT_DA_EXISTENCIA) {
    partes.push(FAQ.sinExistencia);
  } else {
    partes.push('✅ Sí lo manejamos.');
  }

  partes.push('');
  partes.push(fichaProducto(producto)); // los 4 campos de la minuta 17

  if (producto.controlado) {
    partes.push('');
    partes.push('⚠️ _Es producto controlado: requiere receta y validación de un asesor._');
  }

  partes.push('');
  partes.push('¿*Cuántas piezas* necesitas?');

  await responder(wa_id, partes.join('\n'));
  await guardarConversacion(wa_id, PASO.CANTIDAD, contexto, cliente_id);
}

// ===================== Captura de datos y cierre =====================

/** ¿Todo lo pedido está en existencia? Define el tiempo de entrega a comunicar. */
function itemsEnExistencia(contexto) {
  const items = contexto?.items ?? [];
  if (items.length === 0) return contexto?.productoActual?.enExistencia ?? true;
  return items.every((i) => i.enExistencia);
}

/** Tras cerrar los productos, se piden los datos que falten. */
async function avanzarADatos({ wa_id, contexto, cliente_id }) {
  if (!contexto.nombre) {
    await responder(wa_id, 'Perfecto. Para registrar tu solicitud, ¿cuál es tu *nombre*?');
    await guardarConversacion(wa_id, PASO.CAP_NOMBRE, contexto, cliente_id);
    return;
  }
  if (!contexto.empresa && !contexto.tipo) {
    await responder(wa_id, '¿Cuál es tu *empresa o institución*?');
    await guardarConversacion(wa_id, PASO.CAP_EMPRESA, contexto, cliente_id);
    return;
  }
  if (!contexto.ciudad) {
    await responder(wa_id, '¿En qué *ciudad* requieres la entrega?');
    await guardarConversacion(wa_id, PASO.CAP_CIUDAD, contexto, cliente_id);
    return;
  }
  await preguntarFactura({ wa_id, contexto, cliente_id });
}

/** Minuta 1: la pregunta de factura, al final del flujo. */
async function preguntarFactura({ wa_id, contexto, cliente_id }) {
  const aviso = avisoIVA((contexto.items ?? []).map((i) => ({ tasa_iva: i.tasa_iva })));
  await responderBotones(
    wa_id,
    `${FAQ.preguntaFactura}\n\n${aviso}`,
    [
      { id: 'fact_si', titulo: 'Sí, con factura' },
      { id: 'fact_no', titulo: 'No, sin factura' },
    ]
  );
  await guardarConversacion(wa_id, PASO.FACTURA, contexto, cliente_id);
}

/** Pide el siguiente dato fiscal pendiente, o pasa al resumen si ya están todos. */
async function pedirSiguienteDatoFiscal({ wa_id, contexto, cliente_id }) {
  const siguiente = siguienteDatoFiscal(contexto.fiscal ?? {});

  if (!siguiente) {
    await responder(wa_id, `${resumenFiscal(contexto.fiscal)}`);
    await mostrarResumen({ wa_id, contexto, cliente_id });
    return;
  }

  contexto.campoFiscal = siguiente.campo;
  await responder(wa_id, siguiente.pregunta);
  await guardarConversacion(wa_id, PASO.FACT_DATO, contexto, cliente_id);
}

/** Resumen final antes de registrar. */
async function mostrarResumen({ wa_id, contexto, cliente_id }) {
  const items = contexto.items ?? [];
  const lineas = ['📋 *Resumen de tu solicitud*', ''];

  for (const it of items) {
    const stock = it.enExistencia ? '✅' : '⏳';
    lineas.push(`${stock} *${it.cantidad} pz* — ${it.etiqueta}`);
  }

  lineas.push('');
  if (contexto.nombre) lineas.push(`👤 ${titulo(contexto.nombre)}`);
  if (contexto.empresa) lineas.push(`🏢 ${contexto.empresa}`);
  if (contexto.ciudad) lineas.push(`📍 Entrega en ${contexto.ciudad}`);
  lineas.push(contexto.requiereFactura ? '🧾 Con factura' : '🧾 Sin factura');
  lineas.push('');
  lineas.push(lineaEntregaCorta(itemsEnExistencia(contexto)));
  lineas.push('');
  lineas.push(`_${FAQ.sujetoConfirmacion}_`);

  await responder(wa_id, lineas.join('\n'));
  await responderBotones(wa_id, '¿Registro tu solicitud?', [
    { id: 'conf_si', titulo: 'Sí, registrar' },
    { id: 'conf_no', titulo: 'Corregir algo' },
  ]);
  await guardarConversacion(wa_id, PASO.CONFIRMAR, contexto, cliente_id);
}

/**
 * Crea cliente + solicitud + items, decide la plaza que atiende (minuta 15)
 * y notifica al asesor correspondiente.
 */
async function finalizarSolicitud({ wa_id, contexto, cliente_id }) {
  const items = contexto.items ?? [];
  const enExistencia = itemsEnExistencia(contexto);

  // 1) ¿Qué plaza atiende? (minuta 15 y 28)
  const stockGlobal = [...new Set(items.flatMap((i) => i.sucursales ?? []))];
  const { clave: claveSucursal, motivo } = resolverSucursal({
    sucursalesConStock: stockGlobal,
    ciudadEntrega: contexto.ciudad,
  });
  const sucursal_id = await idSucursal(claveSucursal);

  // 2) Reglas de escalamiento.
  // La urgencia se deduce del texto del cliente ("urge", "para hoy"), no se
  // pregunta: el flujo de la minuta 4 no la incluye.
  const urgencia = normalizarUrgencia(contexto.urgenciaTexto ?? '');
  const cantidadTotal = items.reduce((s, i) => s + (Number(i.cantidad) || 0), 0);
  const { escala, motivos } = evaluarEscalamiento({
    tipo: contexto.tipo,
    urgencia,
    cantidad: cantidadTotal,
    productoControlado: items.some((i) => i.controlado),
    datosIncompletos: !contexto.nombre || items.length === 0,
  });

  // 3) Alta/actualización del cliente.
  const fiscal = contexto.fiscal ?? {};
  const cliente = await upsertCliente({
    telefono_wa: wa_id,
    nombre: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    tipo: contexto.tipo ?? 'otro',
    ciudad: contexto.ciudad,
    correo: fiscal.correo ?? null,
    razon_social: fiscal.razon_social,
    rfc: fiscal.rfc,
    cp_fiscal: fiscal.cp,
    uso_cfdi: fiscal.uso_cfdi,
    correo_facturacion: fiscal.correo,
    requiere_factura: contexto.requiereFactura ?? null,
    sucursal_id,
  });

  if (!cliente) {
    await responder(
      wa_id,
      'No pude registrar tu solicitud en este momento, pero ya avisé al equipo. ' +
        'Un asesor te contacta en breve. 🙏'
    );
    await notificarAsesor({
      folio: '(falló el alta del cliente)',
      claveSucursal,
      cliente: contexto.nombre,
      empresa: contexto.empresa,
      telefono: wa_id,
      items: items.map(aItemAviso),
      motivos: ['error al crear cliente en la base'],
    });
    await guardarConversacion(wa_id, PASO.FIN, contexto, cliente_id);
    return;
  }

  // 4) Solicitud + items.
  const creada = await crearSolicitudConItems({
    cliente_id: cliente.id,
    ciudad_entrega: contexto.ciudad,
    urgencia,
    requiere_humano: escala,
    notas: construirNotas(contexto, motivos, claveSucursal, motivo),
    requiere_factura: contexto.requiereFactura ?? null,
    datos_fiscales: contexto.requiereFactura ? fiscal : null,
    sucursal_id,
    items: items.map((it) => ({
      producto_id: it.producto_id ?? null,
      descripcion_libre: it.etiqueta ?? it.nombre,
      cantidad: it.cantidad ?? null,
      presentacion: it.presentacion ?? null,
      nota: it.enExistencia ? 'En existencia al momento de la consulta' : 'Pedir a proveedor',
    })),
  });

  if (!creada) {
    await responder(
      wa_id,
      'No pude registrar tu solicitud en este momento. Un asesor te contacta en breve. 🙏'
    );

    // Al cliente se le acaba de prometer que alguien lo contacta, así que hay
    // que avisarle a alguien de verdad. Antes esta rama no notificaba a nadie:
    // el pedido se perdía en silencio y el cliente se quedaba esperando.
    //
    // Importa más ahora que la solicitud y sus renglones se guardan en una
    // transacción: si algo truena, no queda ni el encabezado en la base, y este
    // aviso por WhatsApp es el ÚNICO rastro que queda del pedido.
    await notificarAsesor({
      folio: 'SIN FOLIO — no se pudo guardar en la base',
      claveSucursal,
      cliente: contexto.nombre ?? contexto.nombrePerfil,
      empresa: contexto.empresa,
      telefono: wa_id,
      tipo: contexto.tipo,
      ciudad: contexto.ciudad,
      items: items.map(aItemAviso),
      requiereFactura: contexto.requiereFactura ?? undefined,
      entrega: lineaEntregaCorta(enExistencia),
      motivos: ['Falló el guardado en la base: capturen este pedido a mano'],
    });

    await guardarConversacion(wa_id, PASO.FIN, contexto, cliente.id);
    return;
  }

  // 5) Confirmación al cliente: folio + tiempo de entrega, sin precios.
  const cierre = [
    `✅ *Solicitud registrada*`,
    `Folio: *${creada.folio}*`,
    '',
    lineaEntregaCorta(enExistencia),
    '',
    FAQ.sujetoConfirmacion,
  ];
  if (contexto.requiereFactura) {
    cierre.push('');
    cierre.push('🧾 Tu factura se emite al confirmar el pedido.');
  }
  await responder(wa_id, cierre.join('\n'));

  // 6) Aviso al asesor de la plaza que toca (minuta 15).
  await notificarAsesor({
    folio: String(creada.folio),
    claveSucursal,
    cliente: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    telefono: wa_id,
    tipo: contexto.tipo,
    ciudad: contexto.ciudad,
    items: items.map(aItemAviso),
    requiereFactura: contexto.requiereFactura ?? undefined,
    entrega: lineaEntregaCorta(enExistencia),
    motivos: escala ? motivos : [],
  });

  await guardarConversacion(wa_id, PASO.FIN, contexto, cliente.id);
}

/**
 * Camino directo a una persona, dejando rastro de la solicitud.
 * @param {boolean} [saludar] - true si es el primer mensaje del cliente
 */
async function escalar(wa_id, contexto, cliente_id, motivos, saludar = false) {
  if (saludar) {
    await responder(wa_id, contexto.clienteNuevo ? FAQ.bienvenida : '¡Hola! 👋');
  }
  await responder(wa_id, FAQ.escalado);

  const items = contexto.items ?? [];
  const stockGlobal = [...new Set(items.flatMap((i) => i.sucursales ?? []))];
  const { clave: claveSucursal } = resolverSucursal({
    sucursalesConStock: stockGlobal,
    ciudadEntrega: contexto.ciudad,
  });
  const sucursal_id = await idSucursal(claveSucursal);

  const cliente = await upsertCliente({
    telefono_wa: wa_id,
    nombre: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    tipo: contexto.tipo,
    ciudad: contexto.ciudad,
    sucursal_id,
  });

  let folio = '(sin folio)';
  if (cliente) {
    const creada = await crearSolicitudConItems({
      cliente_id: cliente.id,
      ciudad_entrega: contexto.ciudad,
      urgencia: 'normal',
      requiere_humano: true,
      notas: `Escalamiento directo. ${motivos.join('; ')}`,
      requiere_factura: contexto.requiereFactura ?? null,
      datos_fiscales: contexto.requiereFactura ? (contexto.fiscal ?? null) : null,
      sucursal_id,
      items: items.map((it) => ({
        producto_id: it.producto_id ?? null,
        descripcion_libre: it.etiqueta ?? it.nombre,
        cantidad: it.cantidad ?? null,
      })),
    });
    if (creada) folio = String(creada.folio);
  }

  await notificarAsesor({
    folio,
    claveSucursal,
    cliente: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    telefono: wa_id,
    tipo: contexto.tipo,
    ciudad: contexto.ciudad,
    items: items.map(aItemAviso),
    requiereFactura: contexto.requiereFactura ?? undefined,
    motivos,
  });

  await guardarConversacion(wa_id, PASO.FIN, contexto, cliente?.id ?? cliente_id);
}

/** Convierte un item del contexto al formato del aviso interno. */
function aItemAviso(it) {
  return {
    descripcion: it.etiqueta ?? it.nombre ?? '—',
    cantidad: it.cantidad ?? null,
    enExistencia: !!it.enExistencia,
  };
}

/** Notas de la solicitud: contexto útil para el asesor que la va a atender. */
function construirNotas(contexto, motivos, claveSucursal, motivoRuteo) {
  const partes = [`Ruteada a ${claveSucursal} (${motivoRuteo})`];
  if (contexto.requiereFactura === true) partes.push('Requiere factura');
  if (contexto.requiereFactura === false) partes.push('Sin factura');
  if (Array.isArray(motivos) && motivos.length) {
    partes.push(`Escalada por: ${motivos.join(', ')}`);
  }
  return partes.join(' | ');
}
