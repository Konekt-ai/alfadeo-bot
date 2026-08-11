// Detección de intención del mensaje del cliente.
//
// Por qué existe: en la conversación real que se compartió (minuta 39) nadie
// contesta con el número del menú. Escriben "buenas tardes, tiene ondansetron
// 8mg?" y esperan respuesta. El bot tiene que entender eso en cualquier punto
// del flujo, sin obligar a navegar un árbol de opciones.
//
// Las tres preguntas frecuentes de la minuta 2 tienen intención propia:
//   EXISTENCIA · PRECIO · ENTREGA
import { normalizar } from '../utils/texto.js';

export const INTENCION = {
  EXISTENCIA: 'existencia',
  PRECIO: 'precio',
  ENTREGA: 'entrega',
  FACTURA: 'factura',
  ASESOR: 'asesor',
  HORARIO: 'horario',
  UBICACION: 'ubicacion',
  MENU: 'menu',
  SALUDO: 'saludo',
  QUEJA: 'queja',
};

// El orden importa: la primera que coincide gana. Las más específicas van
// primero para que "cuándo llega mi pedido" no se lea como "cuánto cuesta".
const REGLAS = [
  [INTENCION.QUEJA, /\b(queja|reclam\w*|inconform\w*|molest\w*|pesimo|mal servicio|no me han|sigo esperando|ya no llego)\b/],

  [INTENCION.ENTREGA, /\b(cuando (me )?(lo |la |los |las )?(entregan|llega|mandan|env[ií]an|surten)|tiempo de entrega|cuanto tarda|cuanto se tarda|para cuando|en cuanto llega|d[ií]as de entrega|fecha de entrega|paqueteria|dhl|guia|rastreo)\b/],

  [INTENCION.PRECIO, /\b(cuanto cuesta|cuanto vale|cuanto sale|que precio|precio|costo|cotiza\w*|presupuesto|lista de precios|tarifa)\b/],

  [INTENCION.FACTURA, /\b(factura\w*|cfdi|rfc|razon social|complemento de pago|timbrad\w*|datos fiscales)\b/],

  [INTENCION.EXISTENCIA, /\b(tienen?|tienes|manejan?|manejas|hay|disponible|disponibilidad|existencia|en stock|stock|cuentan con)\b/],

  [INTENCION.ASESOR, /\b(asesor|persona|humano|agente|vendedor|ejecutivo|hablar con|comunicarme|llamar|telefono|me marcan|marcarme)\b/],

  [INTENCION.HORARIO, /\b(horario|a que hora|abren|cierran|estan abiertos|atienden)\b/],

  [INTENCION.UBICACION, /\b(donde estan|ubicacion|direccion|sucursal|domicilio|como llego)\b/],

  [INTENCION.MENU, /^(menu|inicio|opciones|empezar|start|regresar|volver)\b/],

  [INTENCION.SALUDO, /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|hey|saludos|holi)\b/],
];

/**
 * Devuelve TODAS las intenciones detectadas, en orden de prioridad.
 * Un mismo mensaje suele traer varias: "hola, tienen ondansetron y cuánto cuesta"
 * es saludo + existencia + precio.
 *
 * @param {string} texto
 * @returns {string[]}
 */
export function detectarIntenciones(texto) {
  const t = normalizar(texto);
  if (!t) return [];
  return REGLAS.filter(([, re]) => re.test(t)).map(([intencion]) => intencion);
}

/**
 * Intención principal (la de mayor prioridad).
 * @param {string} texto
 * @returns {string|null}
 */
export function detectarIntencion(texto) {
  return detectarIntenciones(texto)[0] ?? null;
}

/**
 * ¿El mensaje exige que intervenga una persona sí o sí?
 * Licitaciones, concursos y quejas nunca las contesta el bot.
 * @param {string} texto
 */
export function requiereHumano(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  return /\b(licitacion|concurso|adjudicacion|convocatoria|queja|reclam\w*|inconform\w*|demanda|abogad\w*|devolucion|producto en mal estado|caduc\w* vencid\w*)\b/.test(t);
}

/**
 * ¿El mensaje parece traer el nombre de un producto?
 * Se usa para decidir si vale la pena pegarle al catálogo. Evita buscar
 * "gracias" o "ok" contra la base.
 *
 * @param {string} texto
 * @param {string} consultaLimpia - resultado de limpiarConsulta()
 */
export function pareceProducto(texto, consultaLimpia) {
  const t = (consultaLimpia || '').trim();
  if (t.length < 3) return false;

  // Puras cortesías: no son producto.
  if (/^(gracias|muchas gracias|ok|okay|va|listo|perfecto|de acuerdo|bien|si|no|adios|hasta luego|bye)$/.test(normalizar(t))) {
    return false;
  }
  // Al menos una palabra de 4+ letras (los nombres de fármaco son largos).
  return /[a-z]{4,}/.test(normalizar(t));
}
