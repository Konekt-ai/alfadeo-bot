// Reglas de escalamiento a humano + notificación al equipo interno.
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sendText } from '../lib/whatsapp.js';
import { registrarMensaje, supabase } from '../lib/supabase.js';

/**
 * Evalúa si una solicitud debe escalarse a una persona.
 * Reglas (basta con que se cumpla UNA):
 *  - urgencia === 'urgente'
 *  - tipo de cliente 'gobierno' u 'hospital'
 *  - cantidad >= ESCALA_CANTIDAD_UMBRAL
 *  - producto marcado como controlado
 *  - datos incompletos
 *  - el usuario pide precio exacto, menciona licitación, o se queja
 *
 * @param {object} ctx - contexto acumulado de la conversación
 * @param {string} [ctx.tipo]
 * @param {string} [ctx.urgencia]
 * @param {number} [ctx.cantidad]
 * @param {boolean} [ctx.productoControlado]
 * @param {boolean} [ctx.datosIncompletos]
 * @param {string} [ctx.textoUsuario] - último texto libre relevante del usuario
 * @returns {{escala: boolean, motivos: string[]}}
 */
export function evaluarEscalamiento(ctx = {}) {
  const motivos = [];

  if (ctx.urgencia === 'urgente') motivos.push('urgencia urgente');
  if (ctx.tipo === 'gobierno' || ctx.tipo === 'hospital') {
    motivos.push(`tipo de cliente ${ctx.tipo}`);
  }
  if (typeof ctx.cantidad === 'number' && ctx.cantidad >= env.ESCALA_CANTIDAD_UMBRAL) {
    motivos.push(`cantidad >= ${env.ESCALA_CANTIDAD_UMBRAL}`);
  }
  if (ctx.productoControlado) motivos.push('producto controlado');
  if (ctx.datosIncompletos) motivos.push('datos incompletos');

  if (detectarIntencionSensible(ctx.textoUsuario)) {
    motivos.push('solicitud de precio exacto / licitación / queja');
  }

  return { escala: motivos.length > 0, motivos };
}

/**
 * Detecta intenciones que obligan a intervención humana en el texto libre.
 * @param {string} texto
 * @returns {boolean}
 */
export function detectarIntencionSensible(texto) {
  const t = (texto || '').toLowerCase();
  if (!t) return false;
  const patrones = [
    /precio\s+(exacto|final|cerrado|justo|real)/,
    /cu[aá]nto\s+(cuesta|vale|sale)/,
    /licitaci[oó]n/,
    /concurso|adjudicaci[oó]n/,
    /queja|reclam|inconform|molest|p[eé]simo|mal servicio/,
    /factura\s+ya|urge\s+factura/,
  ];
  return patrones.some((re) => re.test(t));
}

/**
 * Consulta si un producto está marcado como controlado.
 * Hace una búsqueda laxa por clave o nombre (texto libre del cliente).
 * Si no encuentra coincidencia, devuelve false (no asume control).
 *
 * @param {string} textoProducto
 * @returns {Promise<boolean>}
 */
export async function esProductoControlado(textoProducto) {
  const t = (textoProducto || '').trim();
  if (!t) return false;
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, controlado')
      .or(`clave.ilike.%${t}%,nombre.ilike.%${t}%`)
      .eq('controlado', true)
      .limit(1);
    if (error) {
      logger.warn('esProductoControlado consulta falló:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    logger.warn('esProductoControlado excepción:', err?.message ?? err);
    return false;
  }
}

/**
 * Notifica al equipo interno por WhatsApp con el resumen de la solicitud.
 * Función desacoplada: intenta enviar a cada número de INTERNAL_NOTIFY_NUMBERS.
 * Si el envío falla (p. ej. fuera de la ventana de 24h y sin plantilla),
 * registra la notificación en `mensajes` con direccion='out' para no perderla.
 *
 * @param {object} resumen
 * @param {string} resumen.folio
 * @param {string} [resumen.cliente]
 * @param {string} [resumen.empresa]
 * @param {string} [resumen.tipo]
 * @param {string} [resumen.producto]
 * @param {number|string} [resumen.cantidad]
 * @param {string} [resumen.urgencia]
 * @param {string} [resumen.canal]
 * @param {string[]} [resumen.motivos] - motivos de escalamiento, si aplica
 */
export async function notificarEquipo(resumen) {
  const numeros = env.INTERNAL_NOTIFY_NUMBERS;
  const texto = construirResumenInterno(resumen);

  if (!numeros || numeros.length === 0) {
    logger.warn('notificarEquipo: no hay INTERNAL_NOTIFY_NUMBERS configurados.');
    // Aun así dejamos rastro de la notificación que se habría enviado.
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
      // El envío de texto libre a quien no inició conversación requiere plantilla.
      // TODO: plantilla de notificación (para enviar fuera de ventana de 24h).
      logger.warn(
        `notificarEquipo: envío a ${numero} falló (status ${res.status}). ` +
          'Se registra en mensajes como respaldo.'
      );
      await registrarMensaje({
        wa_id: numero,
        direccion: 'out',
        tipo: 'text',
        cuerpo: texto,
        payload: { tipo: 'notificacion_interna', motivo: 'envio_fallido', resumen },
      });
    } else {
      // También guardamos el saliente exitoso para tener el log completo.
      await registrarMensaje({
        wa_id: numero,
        direccion: 'out',
        tipo: 'text',
        cuerpo: texto,
        payload: { tipo: 'notificacion_interna', resumen },
      });
    }
  }
}

/**
 * Construye el texto del resumen interno para el equipo.
 * @param {object} r
 * @returns {string}
 */
function construirResumenInterno(r = {}) {
  const lineas = [
    '🔔 *Nueva solicitud ALFA-DEO*',
    `Folio: ${r.folio ?? '—'}`,
    `Cliente: ${r.cliente ?? '—'}`,
    `Empresa/Institución: ${r.empresa ?? '—'}`,
    `Tipo: ${r.tipo ?? '—'}`,
    `Producto: ${r.producto ?? '—'}`,
    `Cantidad: ${r.cantidad ?? '—'}`,
    `Urgencia: ${r.urgencia ?? '—'}`,
    `Canal: ${r.canal ?? 'whatsapp'}`,
  ];
  if (Array.isArray(r.motivos) && r.motivos.length > 0) {
    lineas.push(`⚠️ Requiere humano: ${r.motivos.join(', ')}`);
  }
  return lineas.join('\n');
}
