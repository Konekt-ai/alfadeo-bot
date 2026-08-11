// Cálculo de tiempos de entrega (minuta 5 y 6).
//
// Reglas del negocio, tal cual salieron en la reunión:
//   · Se envía por DHL (o paquetería privada); la entrega es al día siguiente.
//   · PERO si el envío sale un VIERNES, normalmente llega hasta el MARTES.
//   · No hay distribución propia, así que todo depende del calendario hábil.
//
// Todo se calcula en la zona horaria del negocio, no en la del servidor:
// Railway corre en UTC y "hoy" en UTC no siempre es "hoy" en Guadalajara.
import { env } from '../config/env.js';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Descompone un instante en la fecha/hora civil del negocio.
 * @param {Date} [instante]
 * @returns {{anio:number, mes:number, dia:number, hora:number, minuto:number}}
 */
export function partesLocales(instante = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.ZONA_HORARIA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instante);

  const leer = (tipo) => Number(partes.find((p) => p.type === tipo)?.value);
  // Intl puede devolver hora "24" a medianoche en algunos runtimes.
  const hora = leer('hour') % 24;

  return {
    anio: leer('year'),
    mes: leer('month'),
    dia: leer('day'),
    hora,
    minuto: leer('minute'),
  };
}

/**
 * Fecha civil como Date en UTC puro. Sirve para hacer aritmética de días
 * sin que el horario de verano mueva el resultado.
 */
function aCivil({ anio, mes, dia }) {
  return new Date(Date.UTC(anio, mes - 1, dia));
}

/** Suma días a una fecha civil. */
function sumarDias(civil, dias) {
  const d = new Date(civil.getTime());
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

/** Día de la semana de una fecha civil: 0 domingo … 6 sábado. */
function diaSemana(civil) {
  return civil.getUTCDay();
}

/**
 * Devuelve la fecha civil del n-ésimo lunes del mes (para los festivos móviles
 * de la Ley Federal del Trabajo, art. 74).
 */
function nEsimoLunes(anio, mes, n) {
  const primero = new Date(Date.UTC(anio, mes - 1, 1));
  const desplazamiento = (8 - primero.getUTCDay()) % 7; // días hasta el primer lunes
  return new Date(Date.UTC(anio, mes - 1, 1 + desplazamiento + (n - 1) * 7));
}

/**
 * ¿Es día festivo oficial en México? (LFT art. 74)
 * Sólo los obligatorios: son los que realmente paran a las paqueterías.
 * No incluye Jueves/Viernes Santo ni el 12 de diciembre, que no son de ley.
 */
export function esFestivo(civil) {
  const anio = civil.getUTCFullYear();
  const mes = civil.getUTCMonth() + 1;
  const dia = civil.getUTCDate();

  // Fijos.
  if (mes === 1 && dia === 1) return true;   // Año Nuevo
  if (mes === 5 && dia === 1) return true;   // Día del Trabajo
  if (mes === 9 && dia === 16) return true;  // Independencia
  if (mes === 12 && dia === 25) return true; // Navidad

  // Transmisión del Poder Ejecutivo: 1 de octubre cada 6 años desde 2024.
  if (mes === 10 && dia === 1 && (anio - 2024) % 6 === 0 && anio >= 2024) return true;

  // Móviles: primer lunes de febrero, tercer lunes de marzo y de noviembre.
  const esEseLunes = (n) => diaSemana(civil) === 1 && nEsimoLunes(anio, mes, n).getUTCDate() === dia;
  if (mes === 2 && esEseLunes(1)) return true;
  if (mes === 3 && esEseLunes(3)) return true;
  if (mes === 11 && esEseLunes(3)) return true;

  return false;
}

/** ¿Día hábil? Lunes a viernes que no sea festivo. */
export function esHabil(civil) {
  const d = diaSemana(civil);
  return d >= 1 && d <= 5 && !esFestivo(civil);
}

/** Siguiente día hábil estrictamente posterior a `civil`. */
export function siguienteHabil(civil) {
  let d = sumarDias(civil, 1);
  // 14 iteraciones cubren de sobra cualquier puente.
  for (let i = 0; i < 14 && !esHabil(d); i++) d = sumarDias(d, 1);
  return d;
}

/** Formatea una fecha civil como "martes 12 de agosto". */
export function formatearFecha(civil) {
  return `${DIAS[diaSemana(civil)]} ${civil.getUTCDate()} de ${MESES[civil.getUTCMonth()]}`;
}

/**
 * Calcula cuándo sale y cuándo llega un pedido.
 *
 * @param {object} [opciones]
 * @param {Date}   [opciones.instante]   - momento de la consulta (default: ahora)
 * @param {boolean}[opciones.enExistencia] - false si hay que pedirlo a proveedor
 * @returns {{
 *   diaEnvio: Date, diaEntrega: Date,
 *   envioTexto: string, entregaTexto: string,
 *   saleHoy: boolean, envioEnViernes: boolean, desdeProveedor: boolean
 * }}
 */
export function calcularEntrega({ instante = new Date(), enExistencia = true } = {}) {
  const locales = partesLocales(instante);
  const hoy = aCivil(locales);

  // 1) ¿Qué día sale el paquete? Hoy sólo si es hábil y aún no pasa el corte.
  let diaEnvio = hoy;
  if (!esHabil(hoy) || locales.hora >= env.ENTREGA_HORA_CORTE) {
    diaEnvio = siguienteHabil(hoy);
  }

  // 2) Si no hay existencia, primero hay que conseguirlo con el proveedor.
  if (!enExistencia) {
    for (let i = 0; i < Math.max(env.ENTREGA_DIAS_PROVEEDOR, 0); i++) {
      diaEnvio = siguienteHabil(diaEnvio);
    }
  }

  // 3) Tránsito. Regla explícita de la reunión: viernes -> martes.
  const envioEnViernes = diaSemana(diaEnvio) === 5;
  let diaEntrega;
  if (envioEnViernes) {
    diaEntrega = sumarDias(diaEnvio, 4); // viernes + 4 = martes
    // Si ese martes cae festivo, se recorre al siguiente hábil.
    if (!esHabil(diaEntrega)) diaEntrega = siguienteHabil(diaEntrega);
  } else {
    diaEntrega = siguienteHabil(diaEnvio);
  }

  return {
    diaEnvio,
    diaEntrega,
    envioTexto: formatearFecha(diaEnvio),
    entregaTexto: formatearFecha(diaEntrega),
    saleHoy: diaEnvio.getTime() === hoy.getTime(),
    envioEnViernes,
    desdeProveedor: !enExistencia,
  };
}
