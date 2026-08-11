// Mensajes de tiempo de entrega (minuta 5 y 6).
//
// Minuta 6 es explícita: "para los clientes nuevos es muy importante comunicar
// desde el inicio los tiempos estimados de entrega". Por eso el aviso de tiempos
// se manda en el PRIMER mensaje a un número que no conocemos, sin que lo pidan.
import { calcularEntrega } from '../lib/fechas.js';
import { env } from '../config/env.js';

/**
 * Respuesta a "¿cuándo lo entregan?" (minuta 2).
 *
 * @param {object} [opciones]
 * @param {boolean} [opciones.enExistencia] - false si hay que pedirlo a proveedor
 * @param {Date}    [opciones.instante]
 * @returns {string}
 */
export function mensajeEntrega({ enExistencia = true, instante } = {}) {
  const e = calcularEntrega({ instante, enExistencia });

  const lineas = ['🚚 *Tiempo de entrega estimado*', ''];

  if (e.desdeProveedor) {
    lineas.push(
      `Este producto lo pedimos a proveedor, así que sale el *${e.envioTexto}*.`
    );
  } else if (e.saleHoy) {
    lineas.push(
      `Si confirmas hoy antes de las *${env.ENTREGA_HORA_CORTE}:00 h*, sale *hoy mismo*.`
    );
  } else {
    lineas.push(`Sale el *${e.envioTexto}*.`);
  }

  lineas.push(`Llega el *${e.entregaTexto}* por *${env.PAQUETERIA}*.`);

  // La regla del viernes confunde si no se explica; se dice el porqué.
  if (e.envioEnViernes) {
    lineas.push('');
    lineas.push('_Sale viernes y la paquetería no entrega en fin de semana, por eso llega hasta el martes._');
  }

  lineas.push('');
  lineas.push('_Fecha estimada; se confirma al cerrar el pedido._');

  return lineas.join('\n');
}

/**
 * Aviso de tiempos para clientes NUEVOS (minuta 6).
 * Corto a propósito: va pegado al saludo, no debe abrumar.
 * @returns {string}
 */
export function avisoClienteNuevo() {
  return (
    `🚚 Para que lo tengas desde ahorita: enviamos por *${env.PAQUETERIA}* ` +
    `a toda la República.\n` +
    `Pedido confirmado antes de las *${env.ENTREGA_HORA_CORTE}:00 h* normalmente ` +
    `*llega al día siguiente* _(si sale viernes, llega el martes)_.`
  );
}

/**
 * Línea compacta para meter en el cierre de la solicitud.
 * @param {boolean} enExistencia
 * @returns {string}
 */
export function lineaEntregaCorta(enExistencia = true) {
  const e = calcularEntrega({ enExistencia });
  return `🚚 Entrega estimada: *${e.entregaTexto}* (${env.PAQUETERIA}).`;
}
