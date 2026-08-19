// Catálogo de productos: búsqueda por nombre y disponibilidad por sucursal.
//
// Minuta relacionada:
//   17 · mostrar nombre comercial, genérico, miligramos y presentación
//   18 · misma concentración con distinta presentación = producto distinto
//   19 · la búsqueda es por NOMBRE, no por código de barras
//   20 · el cliente usa el nombre COMERCIAL antes que el genérico
//   28 · decir en qué plaza (Guadalajara / Monterrey) hay disponibilidad
//
// El ranking vive en la función `buscar_productos` de Postgres para que el
// panel y el bot ordenen exactamente igual.
import { sql } from '../lib/db.js';
import { logger } from '../utils/logger.js';
import { normalizar, recortar } from '../utils/texto.js';
import { env } from '../config/env.js';

// Palabras que la gente escribe alrededor del producto y que sólo estorban
// al buscar ("tienes paracetamol?" -> "paracetamol").
const RUIDO = [
  'tienen', 'tiene', 'tienes', 'hay', 'manejan', 'maneja', 'manejas',
  'necesito', 'necesitamos', 'ocupo', 'quiero', 'busco', 'buscamos',
  'me das', 'cotizar', 'cotizame', 'cotización', 'cotizacion', 'precio de',
  'precio', 'costo', 'cuanto cuesta', 'existencia', 'disponible',
  'disponibilidad', 'medicamento', 'producto', 'por favor', 'porfavor',
  'buenos dias', 'buenas tardes', 'buenas noches', 'hola', 'buen dia',
  'me puedes decir', 'me confirmas', 'informacion', 'info de',
];

/**
 * Limpia la frase del usuario para dejar sólo lo que parece nombre de producto.
 * @param {string} texto
 * @returns {string}
 */
export function limpiarConsulta(texto) {
  let t = normalizar(texto);
  // Fuera signos de pregunta y puntuación de sobra.
  t = t.replace(/[¿?¡!.,;:]/g, ' ');
  for (const palabra of RUIDO) {
    t = t.replace(new RegExp(`\\b${palabra}\\b`, 'g'), ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// Score a partir del cual la coincidencia es literal (el texto del cliente
// aparece tal cual en el nombre) y no una aproximación por parecido.
const UMBRAL_LITERAL = 0.8;

/**
 * Une filas que son el MISMO producto en distinto lote.
 * En el catálogo cada lote es una fila de `productos` (minuta 23), pero al
 * cliente mostrarle "XANIBA C/120" tres veces le parece un error del sistema.
 * Las existencias de todos los lotes se suman por plaza.
 *
 * @param {Array<object>} filas
 * @returns {Array<object>}
 */
export function agruparLotes(filas) {
  const mapa = new Map();

  for (const p of filas) {
    // Lo que el cliente ve es lo que define si son "el mismo producto".
    const clave = [
      p.nombre_comercial, p.nombre_generico, p.concentracion,
      p.forma_farmaceutica, p.presentacion, p.laboratorio,
    ].map((v) => (v ?? '').toUpperCase().trim()).join('|');

    const previo = mapa.get(clave);

    if (!previo) {
      // El primero gana: el RPC ya viene ordenado por score.
      mapa.set(clave, { ...p, lotes: p.lote ? [p.lote] : [] });
      continue;
    }

    previo.disponibilidad = sumarDisponibilidad(previo.disponibilidad, p.disponibilidad);
    if (p.lote) previo.lotes.push(p.lote);
    // De cara a surtir, la caducidad relevante es la más próxima.
    if (p.caducidad && (!previo.caducidad || p.caducidad < previo.caducidad)) {
      previo.caducidad = p.caducidad;
    }
  }

  return [...mapa.values()];
}

/** Suma las existencias de dos listas de disponibilidad, plaza por plaza. */
function sumarDisponibilidad(a = [], b = []) {
  const porPlaza = new Map();
  for (const d of [...(a ?? []), ...(b ?? [])]) {
    const previo = porPlaza.get(d.sucursal);
    if (previo) previo.existencia = Number(previo.existencia ?? 0) + Number(d.existencia ?? 0);
    else porPlaza.set(d.sucursal, { ...d, existencia: Number(d.existencia ?? 0) });
  }
  return [...porPlaza.values()];
}

/**
 * Busca productos por nombre. Devuelve [] si la consulta es demasiado corta
 * para ser útil (el RPC exige 3 caracteres).
 *
 * @param {string} consulta - texto libre del cliente
 * @param {number} [limite]
 * @returns {Promise<Array<object>>}
 */
export async function buscarProductos(consulta, limite = 5) {
  const q = limpiarConsulta(consulta);
  if (q.length < 3) return [];

  // Se piden más filas de las que se van a mostrar porque varias colapsan
  // al agrupar los lotes del mismo producto.
  // El ORDER BY va explícito. Con supabase.rpc el orden interno de la función
  // llegaba tal cual; un `select * from f(...)` no lo garantiza, y agruparLotes
  // depende de que la primera fila de cada grupo sea la de mejor score.
  //
  // El desempate por nombre no es adorno: es el mismo que trae la función por
  // dentro (`order by b.score desc, b.nombre asc`). Sin él, dos productos con
  // idéntico score podrían salir en distinto orden en cada consulta, y el
  // cliente vería la lista de opciones cambiar entre un mensaje y el siguiente.
  const { data, error } = await sql(
    'select * from buscar_productos($1, $2) order by score desc, nombre asc',
    [q, limite * 5]
  );

  if (error) {
    logger.error('buscar_productos falló:', error.message);
    return [];
  }

  let filas = Array.isArray(data) ? data : [];

  // Si hubo coincidencias literales, las aproximadas sólo estorban. Pedir
  // "capecitabina" y que salga "gemcitabina" no es un resultado útil: son
  // oncológicos distintos y el parecido es sólo ortográfico. Lo difuso queda
  // como red de seguridad para errores de dedo, no como sugerencia.
  const literales = filas.filter((p) => Number(p.score) >= UMBRAL_LITERAL);
  if (literales.length > 0) filas = literales;

  return agruparLotes(filas).slice(0, limite);
}

/**
 * ¿Hay existencia propia en alguna sucursal?
 * @param {object} producto - fila devuelta por buscar_productos
 */
export function hayExistencia(producto) {
  const disp = producto?.disponibilidad;
  return Array.isArray(disp) && disp.some((d) => Number(d.existencia) > 0);
}

/**
 * Nombre legible del producto con los 4 campos que pidió el cliente (minuta 17).
 * Ej: "VYLKOR (Ondansetrón) 8 mg · TAB · C/10"
 * @param {object} p
 */
export function nombreProducto(p) {
  if (!p) return '—';

  const partes = [];
  if (p.nombre_comercial) partes.push(p.nombre_comercial);
  if (p.nombre_generico && p.nombre_generico !== p.nombre_comercial) {
    partes.push(p.nombre_comercial ? `(${p.nombre_generico})` : p.nombre_generico);
  }

  const cola = [p.concentracion, p.forma_farmaceutica, p.presentacion].filter(Boolean);
  const cabeza = partes.join(' ') || p.nombre || '—';
  return cola.length ? `${cabeza} ${cola.join(' · ')}` : cabeza;
}

/**
 * Ficha detallada del producto para el chat, campo por campo.
 * Se usa cuando ya se identificó UN producto: al cliente le sirve confirmar
 * que es exactamente el que pidió (minuta 18: misma dosis, distinta presentación).
 * @param {object} p
 */
export function fichaProducto(p) {
  const lineas = [];
  if (p.nombre_comercial) lineas.push(`*Comercial:* ${p.nombre_comercial}`);
  if (p.nombre_generico) lineas.push(`*Genérico:* ${p.nombre_generico}`);
  if (p.concentracion) lineas.push(`*Miligramos:* ${p.concentracion}`);
  if (p.forma_farmaceutica) lineas.push(`*Forma:* ${p.forma_farmaceutica}`);
  if (p.presentacion) lineas.push(`*Presentación:* ${p.presentacion}`);
  if (p.laboratorio) lineas.push(`*Laboratorio:* ${p.laboratorio}`);
  return lineas.join('\n');
}

/**
 * Texto de disponibilidad por plaza, SIN revelar piezas (minuta 28).
 * Devuelve null si no hay existencia en ninguna sucursal.
 * @param {object} p
 */
export function disponibilidadTexto(p) {
  const disp = (p?.disponibilidad ?? []).filter((d) => Number(d.existencia) > 0);
  if (disp.length === 0) return null;

  const plazas = disp.map((d) => {
    const ciudad = d.ciudad || d.sucursal;
    // El kill-switch BOT_DA_CANTIDADES está apagado por defecto a propósito.
    return env.BOT_DA_CANTIDADES ? `${ciudad} (${Number(d.existencia)} pz)` : ciudad;
  });

  if (plazas.length === 1) return plazas[0];
  return `${plazas.slice(0, -1).join(', ')} y ${plazas[plazas.length - 1]}`;
}

/**
 * Claves de sucursal donde hay existencia, matriz primero.
 * @param {object} p
 * @returns {string[]} ej. ['GDL', 'MTY']
 */
export function sucursalesConStock(p) {
  return (p?.disponibilidad ?? [])
    .filter((d) => Number(d.existencia) > 0)
    .map((d) => d.sucursal)
    .filter(Boolean);
}

/**
 * Arma la lista numerada para que el cliente elija cuando hay varias
 * coincidencias. Es el caso normal: el mismo genérico existe en varias
 * marcas y presentaciones (minuta 18).
 *
 * @param {Array<object>} productos
 * @returns {string}
 */
export function listaOpciones(productos) {
  return productos
    .map((p, i) => {
      const stock = hayExistencia(p) ? '✅' : '⏳';
      return `*${i + 1}.* ${stock} ${recortar(nombreProducto(p), 90)}`;
    })
    .join('\n');
}

/**
 * ¿El producto causa IVA? (minuta 3)
 * Los medicamentos de uso humano son tasa 0%.
 * @param {object} p
 */
export function causaIVA(p) {
  return Number(p?.tasa_iva ?? 0) > 0;
}
