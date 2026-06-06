// Máquina de estados de la solicitud de abastecimiento.
// El avance se guarda en `conversaciones.paso` y los datos parciales en
// `conversaciones.contexto` (jsonb). Cada mensaje (in/out) se registra en `mensajes`.
import { supabase, registrarMensaje } from '../lib/supabase.js';
import { sendText, markRead } from '../lib/whatsapp.js';
import { logger } from '../utils/logger.js';
import { FAQ, respuestaInfo } from './faq.js';
import {
  upsertCliente,
  crearSolicitudConItems,
  normalizarTipoCliente,
  normalizarUrgencia,
} from '../services/solicitudes.js';
import {
  evaluarEscalamiento,
  esProductoControlado,
  notificarEquipo,
  detectarIntencionSensible,
} from '../services/escalamiento.js';

// Duración de la ventana de servicio de WhatsApp (24 horas en ms).
const VENTANA_MS = 24 * 60 * 60 * 1000;

// Pasos de la máquina de estados.
const PASO = {
  INICIO: 'inicio',
  MENU: 'menu',
  INFO: 'info',
  CAP_NOMBRE: 'cap_nombre',
  CAP_EMPRESA: 'cap_empresa',
  CAP_TIPO: 'cap_tipo',
  CAP_CIUDAD: 'cap_ciudad',
  CAP_PRODUCTO: 'cap_producto',
  CAP_CANTIDAD: 'cap_cantidad',
  CAP_URGENCIA: 'cap_urgencia',
  CAP_CONTACTO: 'cap_contacto',
  CONFIRMAR: 'confirmar',
  FIN: 'fin',
};

// ===================== Persistencia de la conversación =====================

/**
 * Obtiene la conversación por wa_id (o null si no existe).
 * @param {string} wa_id
 */
async function obtenerConversacion(wa_id) {
  const { data, error } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('wa_id', wa_id)
    .maybeSingle();
  if (error) {
    logger.warn('obtenerConversacion falló:', error.message);
    return null;
  }
  return data;
}

/**
 * Guarda (upsert) el estado de la conversación.
 * @param {string} wa_id
 * @param {string} paso
 * @param {object} contexto
 * @param {string|null} cliente_id
 */
async function guardarConversacion(wa_id, paso, contexto, cliente_id = null) {
  const ahora = new Date();
  const expira = new Date(ahora.getTime() + VENTANA_MS);

  const fila = {
    wa_id,
    paso,
    contexto: contexto ?? {},
    ultima_actividad: ahora.toISOString(),
    ventana_servicio_expira: expira.toISOString(),
  };
  if (cliente_id) fila.cliente_id = cliente_id;

  const { error } = await supabase
    .from('conversaciones')
    .upsert(fila, { onConflict: 'wa_id' });
  if (error) logger.warn('guardarConversacion falló:', error.message);
}

// ===================== Utilidades de parseo =====================

/** Extrae el primer número entero de un texto (cantidad). */
function extraerCantidad(texto) {
  const m = (texto || '').replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/** Detecta confirmación afirmativa. */
function esAfirmativo(texto) {
  return /^(s[ií]|si|confirmo|confirmar|ok|correcto|de acuerdo|adelante|1)\b/i.test(
    (texto || '').trim()
  );
}

/** Detecta negación. */
function esNegativo(texto) {
  return /^(no|cancelar|cancela|2|corregir|editar)\b/i.test((texto || '').trim());
}

/** ¿El usuario quiere volver al menú? */
function pideMenu(texto) {
  return /^(menu|menú|inicio|hola|empezar|start)\b/i.test((texto || '').trim());
}

// ===================== Envío + registro =====================

/**
 * Envía un texto al usuario y registra el saliente en `mensajes`.
 * @param {string} wa_id
 * @param {string} texto
 */
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

// ===================== Manejador principal =====================

/**
 * Procesa un mensaje entrante y avanza la máquina de estados.
 * Pensado para invocarse de forma asíncrona (el webhook ya respondió 200).
 *
 * @param {{wa_id: string, texto: string, messageId?: string, nombrePerfil?: string, tipo?: string, raw?: object}} inbound
 */
export async function manejarMensaje(inbound) {
  const { wa_id, texto } = inbound;

  // 1) Registrar el mensaje entrante (siempre, pase lo que pase después).
  await registrarMensaje({
    wa_id,
    direccion: 'in',
    tipo: inbound.tipo ?? 'text',
    cuerpo: texto,
    payload: inbound.raw ?? null,
  });

  // Marcar como leído (no crítico).
  markRead(inbound.messageId);

  // 2) Recuperar estado y evaluar la ventana de 24h.
  const conv = await obtenerConversacion(wa_id);
  let paso = conv?.paso ?? PASO.INICIO;
  let contexto = conv?.contexto ?? {};
  const cliente_id = conv?.cliente_id ?? null;

  // Si la última actividad fue hace más de 24h (o no hay conversación), reiniciamos.
  const ventanaVencida =
    !conv?.ultima_actividad ||
    Date.now() - new Date(conv.ultima_actividad).getTime() > VENTANA_MS;
  if (ventanaVencida) {
    paso = PASO.INICIO;
    contexto = {};
  }

  // Guardamos el perfil de WhatsApp como dato de apoyo.
  if (inbound.nombrePerfil && !contexto.nombrePerfil) {
    contexto.nombrePerfil = inbound.nombrePerfil;
  }

  // 3) Atajos globales: volver al menú en cualquier momento.
  if (pideMenu(texto) && paso !== PASO.INICIO) {
    paso = PASO.MENU;
    await responder(wa_id, `${FAQ.bienvenida}\n\n${FAQ.menu}`);
    await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
    return;
  }

  // 4) Detección temprana de intención sensible (precio exacto, licitación, queja)
  //    en cualquier paso de captura: se marca para escalar al final.
  if (detectarIntencionSensible(texto)) {
    contexto.intencionSensible = true;
    contexto.textoSensible = texto;
  }

  try {
    await procesarPaso({ wa_id, texto, paso, contexto, cliente_id });
  } catch (err) {
    logger.error(`manejarMensaje error (wa_id=${wa_id}):`, err?.message ?? err);
    // Intentamos no dejar al usuario sin respuesta.
    await responder(
      wa_id,
      'Tuvimos un detalle técnico procesando tu mensaje. Escribe *menú* para reintentar.'
    );
  }
}

/**
 * Núcleo de la transición de estados.
 */
async function procesarPaso({ wa_id, texto, paso, contexto, cliente_id }) {
  switch (paso) {
    case PASO.INICIO: {
      await responder(wa_id, `${FAQ.bienvenida}\n\n${FAQ.menu}`);
      await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
      return;
    }

    case PASO.MENU: {
      const opcion = (texto || '').trim();
      if (/^1/.test(opcion) || /abastec|solicit|pedido|cotiz/i.test(opcion)) {
        await responder(
          wa_id,
          'Perfecto, vamos a registrar tu solicitud. 📝\n\n¿Cuál es tu *nombre*?'
        );
        await guardarConversacion(wa_id, PASO.CAP_NOMBRE, contexto, cliente_id);
        return;
      }
      if (/^2/.test(opcion) || /informaci|info/i.test(opcion)) {
        await responder(wa_id, FAQ.infoMenu);
        await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
        return;
      }
      if (/^3/.test(opcion) || /persona|humano|asesor|agente/i.test(opcion)) {
        await escalarConContacto(wa_id, contexto, cliente_id, ['solicitud de hablar con una persona']);
        return;
      }
      // No reconocido: re-mostramos el menú.
      await responder(wa_id, `${FAQ.noEntendido}\n\n${FAQ.menu}`);
      await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
      return;
    }

    case PASO.INFO: {
      const resp = respuestaInfo(texto);
      if (resp) {
        await responder(wa_id, `${resp}\n\nEscribe *menú* para volver al inicio.`);
        // Permanecemos en INFO por si quiere otra opción.
        await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
      } else {
        await responder(wa_id, `${FAQ.noEntendido}\n\n${FAQ.infoMenu}`);
        await guardarConversacion(wa_id, PASO.INFO, contexto, cliente_id);
      }
      return;
    }

    case PASO.CAP_NOMBRE: {
      contexto.nombre = texto;
      await responder(wa_id, `Gracias, ${texto}. ¿Cuál es tu *empresa o institución*?`);
      await guardarConversacion(wa_id, PASO.CAP_EMPRESA, contexto, cliente_id);
      return;
    }

    case PASO.CAP_EMPRESA: {
      contexto.empresa = texto;
      await responder(
        wa_id,
        '¿Qué *tipo de cliente* eres?\n' +
          '(hospital, clínica, farmacia, gobierno, distribuidor, médico u otro)'
      );
      await guardarConversacion(wa_id, PASO.CAP_TIPO, contexto, cliente_id);
      return;
    }

    case PASO.CAP_TIPO: {
      contexto.tipo = normalizarTipoCliente(texto);
      contexto.tipoTexto = texto;
      await responder(wa_id, '¿En qué *ciudad y estado* requieres la entrega?');
      await guardarConversacion(wa_id, PASO.CAP_CIUDAD, contexto, cliente_id);
      return;
    }

    case PASO.CAP_CIUDAD: {
      contexto.ciudad = texto;
      await responder(
        wa_id,
        '¿Qué *producto o insumo* necesitas? Describe lo más claro posible (nombre, presentación, etc.).'
      );
      await guardarConversacion(wa_id, PASO.CAP_PRODUCTO, contexto, cliente_id);
      return;
    }

    case PASO.CAP_PRODUCTO: {
      contexto.producto = texto;
      await responder(wa_id, '¿Qué *cantidad* necesitas? (indica un número)');
      await guardarConversacion(wa_id, PASO.CAP_CANTIDAD, contexto, cliente_id);
      return;
    }

    case PASO.CAP_CANTIDAD: {
      const cant = extraerCantidad(texto);
      contexto.cantidad = cant; // puede ser null si no se entiende
      contexto.cantidadTexto = texto;
      await responder(
        wa_id,
        '¿Qué *urgencia* tiene? (normal, urgente o programada)'
      );
      await guardarConversacion(wa_id, PASO.CAP_URGENCIA, contexto, cliente_id);
      return;
    }

    case PASO.CAP_URGENCIA: {
      contexto.urgencia = normalizarUrgencia(texto);
      contexto.urgenciaTexto = texto;
      await responder(
        wa_id,
        'Por último, déjanos un *correo y/o teléfono* de contacto.'
      );
      await guardarConversacion(wa_id, PASO.CAP_CONTACTO, contexto, cliente_id);
      return;
    }

    case PASO.CAP_CONTACTO: {
      contexto.contacto = texto;
      // Intentamos separar correo del resto.
      const correo = (texto.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] ?? null;
      contexto.correo = correo;
      await responder(wa_id, construirResumen(contexto));
      await guardarConversacion(wa_id, PASO.CONFIRMAR, contexto, cliente_id);
      return;
    }

    case PASO.CONFIRMAR: {
      if (esAfirmativo(texto)) {
        await finalizarSolicitud(wa_id, contexto, cliente_id);
        return;
      }
      if (esNegativo(texto)) {
        await responder(
          wa_id,
          'Sin problema, empecemos de nuevo. ¿Cuál es tu *nombre*?'
        );
        // Conservamos nombrePerfil pero limpiamos lo demás.
        const limpio = { nombrePerfil: contexto.nombrePerfil };
        await guardarConversacion(wa_id, PASO.CAP_NOMBRE, limpio, cliente_id);
        return;
      }
      await responder(
        wa_id,
        'Responde *sí* para confirmar o *no* para corregir.'
      );
      await guardarConversacion(wa_id, PASO.CONFIRMAR, contexto, cliente_id);
      return;
    }

    case PASO.FIN:
    default: {
      // Conversación terminada o estado desconocido: ofrecemos el menú.
      await responder(wa_id, `${FAQ.bienvenida}\n\n${FAQ.menu}`);
      await guardarConversacion(wa_id, PASO.MENU, contexto, cliente_id);
      return;
    }
  }
}

// ===================== Resumen y cierre =====================

/** Construye el resumen para confirmar con el usuario. */
function construirResumen(c = {}) {
  return (
    '📋 *Revisa tu solicitud:*\n\n' +
    `• Nombre: ${c.nombre ?? '—'}\n` +
    `• Empresa: ${c.empresa ?? '—'}\n` +
    `• Tipo: ${c.tipo ?? '—'}\n` +
    `• Ciudad de entrega: ${c.ciudad ?? '—'}\n` +
    `• Producto: ${c.producto ?? '—'}\n` +
    `• Cantidad: ${c.cantidad ?? c.cantidadTexto ?? '—'}\n` +
    `• Urgencia: ${c.urgencia ?? '—'}\n` +
    `• Contacto: ${c.contacto ?? '—'}\n\n` +
    'Responde *sí* para registrar o *no* para corregir.\n' +
    '_Disponibilidad y precio siempre sujetos a confirmación._'
  );
}

/**
 * Crea cliente + solicitud + items, evalúa escalamiento y notifica al equipo.
 */
async function finalizarSolicitud(wa_id, contexto, cliente_id) {
  // 1) Detectar datos incompletos para la regla de escalamiento.
  const datosIncompletos =
    !contexto.nombre ||
    !contexto.empresa ||
    !contexto.producto ||
    contexto.cantidad == null;

  // 2) ¿El producto está marcado como controlado?
  const productoControlado = await esProductoControlado(contexto.producto);

  // 3) Evaluar escalamiento.
  const { escala, motivos } = evaluarEscalamiento({
    tipo: contexto.tipo,
    urgencia: contexto.urgencia,
    cantidad: contexto.cantidad,
    productoControlado,
    datosIncompletos,
    textoUsuario: contexto.textoSensible || '',
  });

  // 4) Upsert del cliente.
  const cliente = await upsertCliente({
    telefono_wa: wa_id,
    nombre: contexto.nombre,
    empresa: contexto.empresa,
    tipo: contexto.tipo,
    ciudad: contexto.ciudad,
    correo: contexto.correo,
  });

  if (!cliente) {
    await responder(
      wa_id,
      'No pudimos registrar tu solicitud en este momento. Un asesor te contactará. Gracias.'
    );
    // Igual notificamos al equipo para no perder el lead.
    await notificarEquipo({
      folio: '(sin folio: falló alta de cliente)',
      cliente: contexto.nombre,
      empresa: contexto.empresa,
      tipo: contexto.tipo,
      producto: contexto.producto,
      cantidad: contexto.cantidad,
      urgencia: contexto.urgencia,
      canal: 'whatsapp',
      motivos: ['error al crear cliente'],
    });
    await guardarConversacion(wa_id, PASO.FIN, contexto, cliente_id);
    return;
  }

  // 5) Crear solicitud + items.
  const notas = construirNotas(contexto, motivos);
  const creada = await crearSolicitudConItems({
    cliente_id: cliente.id,
    ciudad_entrega: contexto.ciudad,
    urgencia: contexto.urgencia ?? 'normal',
    requiere_humano: escala,
    notas,
    items: [
      {
        descripcion_libre: contexto.producto,
        cantidad: contexto.cantidad,
        unidad: null,
        nota: contexto.contacto ? `Contacto: ${contexto.contacto}` : null,
      },
    ],
  });

  if (!creada) {
    await responder(
      wa_id,
      'No pudimos registrar tu solicitud en este momento. Un asesor te contactará. Gracias.'
    );
    await guardarConversacion(wa_id, PASO.FIN, contexto, cliente.id);
    return;
  }

  // 6) Confirmar al usuario con el folio (sin precios ni existencias).
  let respuesta = `✅ *Folio:* ${creada.folio}\n\n${FAQ.sujetoConfirmacion}`;
  if (escala) {
    respuesta += `\n\n${FAQ.escalado}`;
  }
  await responder(wa_id, respuesta);

  // 7) Notificar al equipo interno (siempre que se crea una solicitud).
  await notificarEquipo({
    folio: creada.folio,
    cliente: contexto.nombre,
    empresa: contexto.empresa,
    tipo: contexto.tipo,
    producto: contexto.producto,
    cantidad: contexto.cantidad,
    urgencia: contexto.urgencia,
    canal: 'whatsapp',
    motivos: escala ? motivos : [],
  });

  // 8) Cerrar la conversación.
  await guardarConversacion(wa_id, PASO.FIN, contexto, cliente.id);
}

/**
 * Camino de escalamiento directo (opción 3 del menú): marca requiere_humano,
 * registra una solicitud mínima si hay datos, y notifica al equipo.
 */
async function escalarConContacto(wa_id, contexto, cliente_id, motivos) {
  await responder(wa_id, FAQ.escalado);

  // Upsert de cliente con lo que tengamos (puede ser sólo el teléfono).
  const cliente = await upsertCliente({
    telefono_wa: wa_id,
    nombre: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    tipo: contexto.tipo,
    ciudad: contexto.ciudad,
    correo: contexto.correo,
  });

  // Creamos una solicitud marcada como requiere_humano para dejar rastro.
  let folio = '(sin folio)';
  if (cliente) {
    const creada = await crearSolicitudConItems({
      cliente_id: cliente.id,
      ciudad_entrega: contexto.ciudad,
      urgencia: contexto.urgencia ?? 'normal',
      requiere_humano: true,
      notas: `Escalamiento directo. ${motivos.join('; ')}`,
      items: contexto.producto
        ? [{ descripcion_libre: contexto.producto, cantidad: contexto.cantidad }]
        : [],
    });
    if (creada) folio = creada.folio;
  }

  await notificarEquipo({
    folio,
    cliente: contexto.nombre ?? contexto.nombrePerfil,
    empresa: contexto.empresa,
    tipo: contexto.tipo,
    producto: contexto.producto,
    cantidad: contexto.cantidad,
    urgencia: contexto.urgencia,
    canal: 'whatsapp',
    motivos,
  });

  await guardarConversacion(wa_id, PASO.FIN, contexto, cliente?.id ?? cliente_id);
}

/** Arma el campo notas de la solicitud con contexto útil para el asesor. */
function construirNotas(c, motivos) {
  const partes = [];
  if (c.contacto) partes.push(`Contacto: ${c.contacto}`);
  if (c.tipoTexto) partes.push(`Tipo (texto): ${c.tipoTexto}`);
  if (c.urgenciaTexto) partes.push(`Urgencia (texto): ${c.urgenciaTexto}`);
  if (c.cantidadTexto) partes.push(`Cantidad (texto): ${c.cantidadTexto}`);
  if (Array.isArray(motivos) && motivos.length) partes.push(`Escalado por: ${motivos.join(', ')}`);
  return partes.join(' | ') || null;
}
