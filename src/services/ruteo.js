// Ruteo de conversaciones al asesor que corresponde (minuta 15).
//
// La lógica de a quién le toca, en orden:
//   1. Si el producto sólo hay en una plaza, esa plaza atiende.
//   2. Si no, se decide por la ciudad de entrega del cliente.
//   3. Si nada de lo anterior aplica, cae en la sucursal por defecto (GDL,
//      que es matriz y abastece a Monterrey — minuta 9).
//
// Los números viven en la variable RUTEO_ASESORES ("GDL:521...,MTY:521...").
// INTERNAL_NOTIFY_NUMBERS sigue recibiendo todo como respaldo, para que ninguna
// solicitud se pierda si el ruteo está mal configurado.
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { normalizar } from '../utils/texto.js';
import { uno, registrarMensaje } from '../lib/db.js';
import { sendText } from '../lib/whatsapp.js';

// Pistas de texto para mapear lo que escribe el cliente a una plaza.
const PISTAS_PLAZA = [
  ['MTY', /\b(monterrey|mty|nuevo leon|nl|san pedro|garza garcia|apodaca|guadalupe nl|santa catarina|escobedo)\b/],
  ['GDL', /\b(guadalajara|gdl|jalisco|zapopan|tlaquepaque|tonala|tlajomulco|jal)\b/],
];

/**
 * Deduce la plaza a partir de un texto de ciudad/dirección.
 * @param {string} texto
 * @returns {string|null} 'GDL' | 'MTY' | null
 */
export function plazaPorTexto(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  for (const [clave, re] of PISTAS_PLAZA) {
    if (re.test(t)) return clave;
  }
  return null;
}

/**
 * Resuelve qué sucursal atiende esta solicitud.
 *
 * @param {object} params
 * @param {string[]} [params.sucursalesConStock] - claves donde hay existencia
 * @param {string}   [params.ciudadEntrega]
 * @returns {{clave: string, motivo: string}}
 */
export function resolverSucursal({ sucursalesConStock = [], ciudadEntrega = '' } = {}) {
  const porCiudad = plazaPorTexto(ciudadEntrega);

  // 1) Existencia en una sola plaza: no hay nada que decidir.
  if (sucursalesConStock.length === 1) {
    return { clave: sucursalesConStock[0], motivo: 'única plaza con existencia' };
  }

  // 2) Hay existencia en varias: gana la de la ciudad del cliente si coincide.
  if (sucursalesConStock.length > 1 && porCiudad && sucursalesConStock.includes(porCiudad)) {
    return { clave: porCiudad, motivo: 'plaza del cliente con existencia' };
  }

  // 3) Sin existencia propia: manda la ciudad del cliente.
  if (porCiudad) {
    return { clave: porCiudad, motivo: 'ciudad de entrega' };
  }

  return { clave: env.SUCURSAL_DEFAULT, motivo: 'sucursal por defecto' };
}

/**
 * Busca el id de una sucursal por su clave. Devuelve null si no existe
 * (por ejemplo si aún no se corrió la migración).
 * @param {string} clave
 * @returns {Promise<string|null>}
 */
export async function idSucursal(clave) {
  if (!clave) return null;
  const { data, error } = await uno(
    'select id from sucursales where clave = $1',
    [clave.toUpperCase()]
  );

  if (error) {
    logger.warn('idSucursal falló:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Números a los que se notifica esta solicitud: el asesor de la plaza más los
 * números de respaldo, sin repetir.
 * @param {string} claveSucursal
 * @returns {string[]}
 */
export function destinatarios(claveSucursal) {
  const asesor = env.RUTEO_ASESORES[(claveSucursal || '').toUpperCase()];
  const lista = [];
  if (asesor) lista.push(asesor);
  for (const n of env.INTERNAL_NOTIFY_NUMBERS) {
    if (!lista.includes(n)) lista.push(n);
  }
  return lista;
}

/**
 * Notifica la solicitud al asesor que corresponde (minuta 15).
 * Nunca lanza: si el envío falla, deja el aviso registrado en `mensajes`
 * para que no se pierda el lead.
 *
 * @param {object} resumen
 * @param {string} resumen.folio
 * @param {string} resumen.claveSucursal
 * @param {string} [resumen.cliente]
 * @param {string} [resumen.empresa]
 * @param {string} [resumen.telefono]
 * @param {string} [resumen.tipo]
 * @param {Array<{descripcion: string, cantidad: number|null, enExistencia: boolean}>} [resumen.items]
 * @param {string} [resumen.ciudad]
 * @param {string} [resumen.urgencia]
 * @param {boolean}[resumen.requiereFactura]
 * @param {string} [resumen.entrega]
 * @param {string[]}[resumen.motivos]
 */
export async function notificarAsesor(resumen) {
  const texto = construirAviso(resumen);
  const numeros = destinatarios(resumen.claveSucursal);

  if (numeros.length === 0) {
    logger.warn('notificarAsesor: no hay números configurados; se registra el aviso.');
    await registrarMensaje({
      wa_id: 'equipo-interno',
      direccion: 'out',
      tipo: 'text',
      cuerpo: texto,
      payload: { tipo: 'notificacion_interna', motivo: 'sin_numeros', resumen },
    });
    return;
  }

  for (const numero of numeros) {
    const res = await sendText(numero, texto);
    if (!res.ok) {
      // Fuera de la ventana de 24 h Meta exige plantilla aprobada.
      logger.warn(
        `notificarAsesor: envío a ${numero} falló (status ${res.status}). ` +
          'Queda registrado en `mensajes` como respaldo.'
      );
    }
    await registrarMensaje({
      wa_id: numero,
      direccion: 'out',
      tipo: 'text',
      cuerpo: texto,
      payload: {
        tipo: 'notificacion_interna',
        sucursal: resumen.claveSucursal,
        enviado: res.ok,
        resumen,
      },
    });
  }
}

/** Arma el aviso que le llega al asesor. */
function construirAviso(r = {}) {
  const lineas = [
    `🔔 *Nueva solicitud · ${r.claveSucursal ?? '—'}*`,
    `Folio: *${r.folio ?? '—'}*`,
    '',
    `👤 ${r.cliente ?? '—'}${r.empresa ? ` — ${r.empresa}` : ''}`,
  ];

  if (r.tipo) lineas.push(`Tipo: ${r.tipo}`);
  if (r.telefono) lineas.push(`WhatsApp: wa.me/${r.telefono}`);
  if (r.ciudad) lineas.push(`Entrega en: ${r.ciudad}`);

  lineas.push('');
  lineas.push('*Productos:*');
  const items = Array.isArray(r.items) ? r.items : [];
  if (items.length === 0) {
    lineas.push('  (sin detalle)');
  } else {
    for (const it of items) {
      const stock = it.enExistencia ? '✅ en existencia' : '⏳ pedir a proveedor';
      lineas.push(`  • ${it.descripcion} — ${it.cantidad ?? '?'} pz · ${stock}`);
    }
  }

  lineas.push('');
  if (r.urgencia) lineas.push(`Urgencia: ${r.urgencia}`);
  if (r.entrega) lineas.push(r.entrega);
  if (r.requiereFactura === true) lineas.push('🧾 *Requiere factura* (datos en el panel)');
  if (r.requiereFactura === false) lineas.push('🧾 No requiere factura');

  if (Array.isArray(r.motivos) && r.motivos.length > 0) {
    lineas.push('');
    lineas.push(`⚠️ *Atender personalmente:* ${r.motivos.join(', ')}`);
  }

  return lineas.join('\n');
}
