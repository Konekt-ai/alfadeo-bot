// Reglas de escalamiento a una persona.
//
// La notificación al equipo vive ahora en `services/ruteo.js`, porque desde la
// reunión (minuta 15) ya no se avisa a "el equipo" en bloque: cada solicitud se
// rutea al asesor de la plaza que le toca.
import { env } from '../config/env.js';

/**
 * Evalúa si una solicitud debe atenderla una persona.
 * Basta con que se cumpla UNA condición.
 *
 * @param {object} ctx
 * @param {string} [ctx.tipo]        - tipo de cliente
 * @param {string} [ctx.urgencia]    - 'normal' | 'urgente' | 'programada'
 * @param {number} [ctx.cantidad]    - piezas totales del pedido
 * @param {boolean}[ctx.productoControlado]
 * @param {boolean}[ctx.datosIncompletos]
 * @returns {{escala: boolean, motivos: string[]}}
 */
export function evaluarEscalamiento(ctx = {}) {
  const motivos = [];

  if (ctx.urgencia === 'urgente') {
    motivos.push('pedido urgente');
  }

  // Gobierno y hospitales suelen implicar licitación, convenio o crédito.
  if (ctx.tipo === 'gobierno' || ctx.tipo === 'hospital') {
    motivos.push(`cliente de tipo ${ctx.tipo}`);
  }

  if (typeof ctx.cantidad === 'number' && ctx.cantidad >= env.ESCALA_CANTIDAD_UMBRAL) {
    motivos.push(`volumen alto (${ctx.cantidad} pz)`);
  }

  if (ctx.productoControlado) {
    motivos.push('producto controlado');
  }

  if (ctx.datosIncompletos) {
    motivos.push('datos incompletos');
  }

  return { escala: motivos.length > 0, motivos };
}
