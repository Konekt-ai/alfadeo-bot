// Acceso a PostgreSQL. La base vive en la MISMA computadora que el bot:
// no hay nube de por medio y nada sale a internet.
//
// Sustituye a la capa de Supabase. La forma de las consultas cambia -- SQL
// en vez del constructor de consultas -- pero la forma de la RESPUESTA se
// mantiene a propósito:
//
//     const { data, error } = await sql('select ...', [param])
//
// Así los servicios siguen decidiendo igual que antes si degradan o abortan,
// y un fallo de base no cambia el comportamiento del flujo.
//
// El gemelo de este archivo es src/lib/db.ts en el repo del panel. Si tocas
// uno, mira el otro.

import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool, types } = pg;

// --------------------------------------------------------------- tipos ---
// node-postgres devuelve numeric/int8 como STRING para no perder precisión.
// Aquí los numeric son piezas y cantidades: caben de sobra en un double y el
// código los trata como números (sumarDisponibilidad hace aritmética directa).
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

// Las fechas (date) se dejan como texto 'YYYY-MM-DD'. Si se convirtieran a
// Date, la zona horaria le restaría un día: una caducidad de 2027-12-01 se
// leería como 30 de noviembre. Además agruparLotes las compara con `<`, y
// entre cadenas 'YYYY-MM-DD' esa comparación ya es cronológica.
types.setTypeParser(types.builtins.DATE, (v) => v);

// ----------------------------------------------------------------- pool ---
// El pool se crea en la PRIMERA consulta, no al importar el módulo. Importa:
// las pruebas importan catalogo.js y ruteo.js -- que cuelgan de este archivo --
// y deben correr sin base y sin .env. Si el pool se creara al importar,
// `npm test` exigiría PostgreSQL levantado.
let pool = null;

function obtenerPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta DATABASE_URL en .env. Debe apuntar a la base local, por ejemplo: ' +
        'postgresql://bot:CONTRASENA@localhost:5433/alfadeo'
    );
  }

  pool = new Pool({
    connectionString: url,
    // Bajo a propósito: el bot atiende webhooks de uno en uno y comparte la
    // computadora con el panel, que tiene su propio pool de 10.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // La computadora del mostrador se suspende y despierta. Sin keepAlive,
    // el primer webhook tras despertar se encuentra un socket muerto.
    keepAlive: true,
  });

  // Sin este manejador, un corte de conexión inactiva mata el proceso entero
  // de Node y el supervisor tiene que levantarlo de nuevo.
  pool.on('error', (e) => logger.error('[db] error en conexión inactiva:', e.message));

  return pool;
}

// ------------------------------------------------------------ consultas ---

/**
 * Consulta que NO lanza. Devuelve `{ data, error }` para que quien llama
 * decida si degrada o aborta. Es la forma normal de leer.
 *
 * @param {string} texto - SQL con marcadores $1, $2...
 * @param {unknown[]} [params]
 * @returns {Promise<{data: object[], error: {message: string}|null}>}
 */
export async function sql(texto, params = []) {
  try {
    const r = await obtenerPool().query(texto, params);
    return { data: r.rows, error: null };
  } catch (e) {
    return { data: [], error: { message: mensajeDeError(e) } };
  }
}

/**
 * Una sola fila, o null. Equivale al .maybeSingle() de Supabase: que no haya
 * fila NO es un error.
 *
 * @returns {Promise<{data: object|null, error: {message: string}|null}>}
 */
export async function uno(texto, params = []) {
  const r = await sql(texto, params);
  return { data: r.data[0] ?? null, error: r.error };
}

/**
 * Consulta que SÍ lanza. Para dentro de transacciones y scripts, donde el
 * error se atrapa arriba.
 *
 * @returns {Promise<object[]>}
 */
export async function qx(texto, params = []) {
  const r = await obtenerPool().query(texto, params);
  return r.rows;
}

/**
 * Varias sentencias en UNA transacción: si algo truena no queda nada a medias.
 *
 * Lo usa crearSolicitudConItems. Antes, con Supabase, no había forma de hacer
 * esto en una sola operación: si fallaban los items quedaba una solicitud sin
 * renglones, ya notificada al asesor.
 *
 * @param {(ejecutar: (texto: string, params?: unknown[]) => Promise<object[]>) => Promise<any>} fn
 */
export async function enTransaccion(fn) {
  const cliente = await obtenerPool().connect();
  try {
    await cliente.query('begin');
    const resultado = await fn(async (texto, params = []) => {
      const r = await cliente.query(texto, params);
      return r.rows;
    });
    await cliente.query('commit');
    return resultado;
  } catch (e) {
    await cliente.query('rollback').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * Cierra el pool. Sólo lo necesitan los scripts, para que el proceso termine
 * en vez de quedarse colgado esperando conexiones inactivas. El servidor no
 * lo llama: vive hasta que lo maten.
 */
export async function cerrarPool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

// ---------------------------------------------------------------- errores -

function mensajeDeError(e) {
  const codigo = e?.code;

  if (codigo === 'ECONNREFUSED' || codigo === 'ENOTFOUND') {
    return 'No se pudo conectar a la base de datos. ¿Está arriba el servicio de PostgreSQL en localhost:5433?';
  }
  if (codigo === '42P01' || codigo === '42883') {
    return `${e.message} — falta correr las migraciones de la base (se hacen desde el repo del panel).`;
  }
  if (codigo === '28P01') {
    return 'Contraseña incorrecta al conectar a la base. Revisa DATABASE_URL en .env.';
  }
  if (codigo === '3D000') {
    return 'La base de datos no existe todavía.';
  }
  if (codigo === '42501') {
    return `${e.message} — al rol del bot le faltan permisos. Ver sql/rol-bot.sql.`;
  }
  return e?.message ?? String(e);
}

// ------------------------------------------------------------- mensajes ---

/**
 * Registra un mensaje en la tabla `mensajes` (log de toda la conversación).
 * Pensado para fallar en silencio: el logging nunca debe romper el flujo.
 *
 * @param {object} m
 * @param {string} m.wa_id - número del contacto
 * @param {'in'|'out'} m.direccion - entrante ('in') o saliente ('out')
 * @param {string} [m.tipo] - tipo de mensaje (text, interactive, etc.)
 * @param {string} [m.cuerpo] - texto del mensaje
 * @param {object} [m.payload] - payload crudo opcional (jsonb)
 */
export async function registrarMensaje(m) {
  // El payload va serializado y con cast explícito: si se pasara el objeto tal
  // cual, un `null` acabaría guardado como el JSON `null` en vez de un NULL de
  // SQL, y las consultas del panel que filtran `payload is null` no lo verían.
  const { error } = await sql(
    `insert into mensajes (wa_id, direccion, tipo, cuerpo, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      m.wa_id,
      m.direccion,
      m.tipo ?? 'text',
      m.cuerpo ?? null,
      m.payload == null ? null : JSON.stringify(m.payload),
    ]
  );

  // No relanzamos: sólo dejamos rastro.
  if (error) logger.error(`[registrarMensaje] no se pudo guardar: ${error.message}`);
}
