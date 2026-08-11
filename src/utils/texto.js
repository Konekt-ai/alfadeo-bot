// Utilidades de texto compartidas por los flujos.
// Todo lo que compare entrada del usuario debe pasar por `normalizar()`:
// la gente escribe "ondansetrón", "ONDANSETRON" y "ondanseton" indistintamente.

/**
 * Minúsculas, sin acentos, sin espacios de más.
 * @param {string} s
 * @returns {string}
 */
export function normalizar(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita diacríticos
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿El usuario quiere omitir un campo opcional? */
export function esOmitir(texto) {
  return /^(no|ninguna|ninguno|n\/a|na|-|skip|omitir|sin|nel|nop)\b/.test(normalizar(texto));
}

/** Confirmación afirmativa. */
export function esAfirmativo(texto) {
  const t = normalizar(texto);
  return /^(si|s|claro|correcto|confirmo|confirmar|ok|okay|va|dale|adelante|de acuerdo|asi es|afirmativo|por favor|porfa|1)\b/.test(t);
}

/** Negación. */
export function esNegativo(texto) {
  const t = normalizar(texto);
  return /^(no|n|nel|negativo|cancelar|cancela|corregir|editar|2)\b/.test(t);
}

/** ¿Pide volver al menú/inicio? */
export function pideMenu(texto) {
  return /^(menu|inicio|empezar|start|opciones|regresar|volver)\b/.test(normalizar(texto));
}

/** ¿Es sólo un saludo, sin contenido? */
export function esSaludo(texto) {
  const t = normalizar(texto);
  if (t.length > 40) return false;
  return /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|hey|holi|saludos|buen dia)\b/.test(t);
}

/**
 * Extrae el primer entero de un texto ("necesito 20 cajas" -> 20).
 * Ignora separadores de miles.
 */
export function extraerCantidad(texto) {
  const m = (texto || '').replace(/[,\s](?=\d{3}\b)/g, '').match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Extrae el primer correo electrónico del texto. */
export function extraerCorreo(texto) {
  return ((texto || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] ?? null;
}

/**
 * Extrae un RFC mexicano (persona moral: 12, física: 13).
 * No valida el dígito verificador, sólo la forma.
 */
export function extraerRFC(texto) {
  // Ojo: NO se pueden quitar los espacios de todo el texto para "limpiarlo",
  // porque entonces "mi rfc es AFD120315AB9" se vuelve una sola palabra y los
  // límites \b dejan de existir. Se compactan sólo los separadores que estén
  // DENTRO de un candidato a RFC ("AFD-120315-AB9" -> "AFD120315AB9").
  const base = (texto || '').toUpperCase();
  const compactado = base.replace(
    /([A-ZÑ&]{3,4})[\s-]*(\d{6})[\s-]*([A-Z0-9]{3})/g,
    '$1$2$3'
  );
  const m = compactado.match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  return m ? m[1] : null;
}

/** Extrae un código postal de 5 dígitos. */
export function extraerCP(texto) {
  const m = (texto || '').match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

/** Capitaliza para mostrar nombres capturados a mano. */
export function titulo(s) {
  return (s || '')
    .toLowerCase()
    .replace(/(^|\s|["'(])([a-záéíóúñ])/g, (_, p, c) => p + c.toUpperCase());
}

/** Recorta un texto largo para que quepa cómodo en un mensaje de WhatsApp. */
export function recortar(s, max = 60) {
  const t = (s || '').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}
