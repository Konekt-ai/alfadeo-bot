// Captura de datos fiscales (minuta 1 y 3).
//
// Minuta 1: la pregunta "¿requiere factura?" va AL FINAL del flujo, porque en
// la vida real es cuando el cliente la pide — no al inicio.
//
// Minuta 3: la mayoría de lo que venden son medicamentos de uso humano, que en
// México son *tasa 0%* de IVA. Ojo: tasa 0% NO es lo mismo que "exento" —
// con tasa 0 sí se acredita el IVA de las compras. El bot no calcula impuestos;
// sólo se lo aclara al cliente para que no se sorprenda al ver la factura.
import { extraerRFC, extraerCP, extraerCorreo, titulo } from '../utils/texto.js';

// Usos de CFDI que aplican a este giro. G01 es el normal para quien revende.
export const USOS_CFDI = {
  G01: 'Adquisición de mercancías',
  G03: 'Gastos en general',
  I08: 'Otra maquinaria y equipo',
  S01: 'Sin efectos fiscales',
};

/**
 * Intenta sacar todos los datos fiscales de un solo mensaje.
 * Muchos clientes pegan su "constancia" completa de un jalón; sería absurdo
 * pedirles campo por campo lo que ya mandaron.
 *
 * @param {string} texto
 * @returns {{razon_social?: string, rfc?: string, cp?: string, correo?: string, uso_cfdi?: string}}
 */
export function extraerDatosFiscales(texto) {
  const datos = {};
  const t = texto || '';

  const rfc = extraerRFC(t);
  if (rfc) datos.rfc = rfc;

  const correo = extraerCorreo(t);
  if (correo) datos.correo = correo;

  // El CP se busca DESPUÉS de quitar el RFC, que también trae 6 dígitos juntos.
  const sinRfc = rfc ? t.replace(new RegExp(rfc, 'i'), ' ') : t;
  const cp = extraerCP(sinRfc);
  if (cp) datos.cp = cp;

  const uso = t.toUpperCase().match(/\b(G01|G03|I08|S01|D\d{2}|P01)\b/);
  if (uso) datos.uso_cfdi = uso[1];

  // Razón social: la línea más larga que no sea el RFC, el correo ni el CP.
  const candidatas = t
    .split(/[\n;|]+/)
    .map((l) => l.replace(/^\s*(raz[oó]n\s*social|nombre|empresa|cliente)\s*:?/i, '').trim())
    .filter((l) => l.length >= 4)
    .filter((l) => !(rfc && l.toUpperCase().includes(rfc)))
    .filter((l) => !(correo && l.includes(correo)))
    .filter((l) => !/^\d+$/.test(l));

  if (candidatas.length > 0) {
    datos.razon_social = candidatas.sort((a, b) => b.length - a.length)[0];
  }

  return datos;
}

/**
 * ¿Ya tenemos lo mínimo indispensable para timbrar?
 * Razón social, RFC, CP y correo. El uso de CFDI tiene default razonable.
 * @param {object} datos
 */
export function datosFiscalesCompletos(datos = {}) {
  return Boolean(datos.razon_social && datos.rfc && datos.cp && datos.correo);
}

/**
 * Devuelve el siguiente dato fiscal que falta pedir, con su pregunta.
 * @param {object} datos
 * @returns {{campo: string, pregunta: string}|null}
 */
export function siguienteDatoFiscal(datos = {}) {
  if (!datos.razon_social) {
    return {
      campo: 'razon_social',
      pregunta: '🧾 ¿Cuál es tu *Razón Social*? (el nombre fiscal exacto, como viene en tu constancia)',
    };
  }
  if (!datos.rfc) {
    return {
      campo: 'rfc',
      pregunta: '🧾 ¿Cuál es tu *RFC*?',
    };
  }
  if (!datos.cp) {
    return {
      campo: 'cp',
      pregunta: '🧾 ¿Cuál es tu *Código Postal fiscal*? (5 dígitos)',
    };
  }
  if (!datos.correo) {
    return {
      campo: 'correo',
      pregunta: '🧾 ¿A qué *correo* te enviamos el PDF y el XML?',
    };
  }
  return null;
}

/**
 * Valida y normaliza el valor capturado para un campo fiscal.
 * @param {string} campo
 * @param {string} texto
 * @returns {{ok: boolean, valor?: string, error?: string}}
 */
export function validarDatoFiscal(campo, texto) {
  const t = (texto || '').trim();

  switch (campo) {
    case 'razon_social': {
      if (t.length < 3) return { ok: false, error: 'Necesito la razón social completa.' };
      return { ok: true, valor: t.toUpperCase() };
    }
    case 'rfc': {
      const rfc = extraerRFC(t);
      if (!rfc) {
        return {
          ok: false,
          error: 'Ese RFC no tiene el formato correcto. Debe ser de 12 dígitos (empresa) o 13 (persona física).',
        };
      }
      return { ok: true, valor: rfc };
    }
    case 'cp': {
      const cp = extraerCP(t);
      if (!cp) return { ok: false, error: 'El código postal debe ser de 5 dígitos.' };
      return { ok: true, valor: cp };
    }
    case 'correo': {
      const correo = extraerCorreo(t);
      if (!correo) return { ok: false, error: 'Ese correo no parece válido. ¿Me lo confirmas?' };
      return { ok: true, valor: correo.toLowerCase() };
    }
    default:
      return { ok: true, valor: t };
  }
}

/**
 * Resumen legible de los datos fiscales, para confirmar con el cliente.
 * @param {object} d
 */
export function resumenFiscal(d = {}) {
  return [
    '🧾 *Datos de facturación:*',
    `• Razón social: ${d.razon_social ?? '—'}`,
    `• RFC: ${d.rfc ?? '—'}`,
    `• CP fiscal: ${d.cp ?? '—'}`,
    `• Uso de CFDI: ${d.uso_cfdi ?? 'G01'} (${USOS_CFDI[d.uso_cfdi ?? 'G01'] ?? 'Adquisición de mercancías'})`,
    `• Correo: ${d.correo ?? '—'}`,
  ].join('\n');
}

/**
 * Aviso de IVA que acompaña la confirmación de factura (minuta 3).
 * @param {Array<object>} productos - filas del catálogo ya identificadas
 * @returns {string}
 */
export function avisoIVA(productos = []) {
  const conIVA = productos.filter((p) => Number(p?.tasa_iva ?? 0) > 0);

  if (productos.length > 0 && conIVA.length === 0) {
    return '_Estos productos son *tasa 0% de IVA*, así que tu factura no lleva IVA._';
  }
  if (conIVA.length > 0 && conIVA.length < productos.length) {
    return '_Ojo: la mayoría son *tasa 0% de IVA*, pero algún producto de tu pedido sí causa IVA. El asesor te lo desglosa._';
  }
  if (conIVA.length > 0) {
    return '_Estos productos sí causan IVA (16%). El asesor te lo desglosa en la cotización._';
  }
  return '_La mayoría de los medicamentos son *tasa 0% de IVA*._';
}

/**
 * Normaliza el nombre de la persona/empresa para guardar en `clientes`.
 * @param {string} s
 */
export function normalizarNombre(s) {
  return titulo((s || '').trim());
}
