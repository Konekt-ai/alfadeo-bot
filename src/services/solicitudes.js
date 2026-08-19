// Servicio de solicitudes: upsert de cliente, creación de solicitud e items.
// Trabaja contra el esquema YA existente en la base local (localhost:5433).
import { uno, enTransaccion } from '../lib/db.js';
import { logger } from '../utils/logger.js';

// Columnas que el bot puede escribir en `clientes`. Es una lista cerrada a
// propósito: el upsert arma su SQL con los nombres de columna presentes, y
// esos nombres NO pueden venir de datos de entrada. Los valores siempre van
// parametrizados; los identificadores, sólo de esta lista.
const COLUMNAS_CLIENTE = [
  'telefono_wa', 'nombre', 'empresa', 'tipo', 'ciudad', 'correo', 'direccion',
  'puesto', 'rfc', 'telefono', 'especificacion',
  // Datos fiscales (minuta 1).
  'razon_social', 'regimen_fiscal', 'uso_cfdi', 'cp_fiscal',
  'correo_facturacion', 'requiere_factura', 'sucursal_id',
];

// Tipos de cliente válidos (enum en la BD). Se usa para normalizar la entrada.
const TIPOS_CLIENTE = [
  'hospital',
  'clinica',
  'farmacia',
  'gobierno',
  'distribuidor',
  'medico',
  'otro',
];

/**
 * Normaliza el texto libre del usuario a un valor del enum `tipo`.
 * @param {string} texto
 * @returns {string} uno de TIPOS_CLIENTE (por defecto 'otro')
 */
export function normalizarTipoCliente(texto) {
  const t = (texto || '').trim().toLowerCase();
  // Coincidencias por palabra clave / acentos.
  if (/hospital/.test(t)) return 'hospital';
  if (/cl[ií]nica/.test(t)) return 'clinica';
  if (/farmacia/.test(t)) return 'farmacia';
  if (/gobierno|p[uú]blic|dependencia|secretar[ií]a/.test(t)) return 'gobierno';
  if (/distribuidor|mayorista/.test(t)) return 'distribuidor';
  if (/m[eé]dico|doctor|consultorio/.test(t)) return 'medico';
  // Coincidencia exacta por si escriben el valor del enum.
  if (TIPOS_CLIENTE.includes(t)) return t;
  return 'otro';
}

/**
 * Normaliza la urgencia a un valor del enum `urgencia`.
 * @param {string} texto
 * @returns {string} 'normal' | 'urgente' | 'programada'
 */
export function normalizarUrgencia(texto) {
  const t = (texto || '').trim().toLowerCase();
  if (/urgent|inmediat|ya|hoy|emergenc/.test(t)) return 'urgente';
  if (/program|despu[eé]s|fecha|calendar|futur/.test(t)) return 'programada';
  return 'normal';
}

/**
 * Busca un cliente por su número de WhatsApp.
 * Sirve para saber si es cliente nuevo (minuta 6: a los nuevos hay que
 * comunicarles los tiempos de entrega desde el inicio) y para no volver a
 * pedirle datos que ya nos dio.
 *
 * @param {string} telefono_wa
 * @returns {Promise<object|null>}
 */
export async function obtenerCliente(telefono_wa) {
  const { data, error } = await uno(
    'select * from clientes where telefono_wa = $1',
    [telefono_wa]
  );

  if (error) {
    logger.warn('obtenerCliente falló:', error.message);
    return null;
  }
  return data;
}

/**
 * Arma el INSERT ... ON CONFLICT del upsert de cliente.
 *
 * Está separado y es puro para poder probarlo sin base de datos: es la única
 * consulta del bot cuyo conjunto de columnas se decide en tiempo de ejecución,
 * y por lo tanto la única donde un descuido rompe el SQL.
 *
 * Sólo se escriben las columnas que traen valor. Eso es lo que evita pisar con
 * null datos que el cliente ya nos había dado en un mensaje anterior.
 *
 * @param {Record<string, unknown>} fila
 * @returns {{texto: string, valores: unknown[]}}
 */
export function construirUpsertCliente(fila) {
  const presentes = COLUMNAS_CLIENTE.filter(
    (c) => fila[c] !== undefined && fila[c] !== null && fila[c] !== ''
  );

  const marcadores = presentes.map((_, i) => `$${i + 1}`);
  const valores = presentes.map((c) => fila[c]);

  const asignaciones = presentes
    .filter((c) => c !== 'telefono_wa')
    .map((c) => `${c} = excluded.${c}`);

  // Si sólo llegó el teléfono no hay nada que actualizar, pero el DO UPDATE
  // necesita asignar algo para que el RETURNING devuelva la fila.
  if (asignaciones.length === 0) asignaciones.push('telefono_wa = excluded.telefono_wa');

  const texto =
    `insert into clientes (${presentes.join(', ')})\n` +
    `     values (${marcadores.join(', ')})\n` +
    `     on conflict (telefono_wa) do update set ${asignaciones.join(', ')}\n` +
    `     returning *`;

  return { texto, valores };
}

/**
 * Upsert de cliente por telefono_wa. Si ya existe, actualiza datos no vacíos.
 * @param {object} datos
 * @param {string} datos.telefono_wa
 * @param {string} [datos.nombre]
 * @param {string} [datos.empresa]
 * @param {string} [datos.tipo]
 * @param {string} [datos.ciudad]
 * @param {string} [datos.correo]
 * @param {string} [datos.direccion]       dirección de la empresa
 * @param {string} [datos.puesto]          cargo del contacto
 * @param {string} [datos.rfc]
 * @param {string} [datos.telefono]        teléfono (distinto al WhatsApp)
 * @param {string} [datos.especificacion]  especificación del cliente
 * @returns {Promise<object|null>} fila del cliente o null si falla
 */
export async function upsertCliente(datos) {
  const fila = {
    telefono_wa: datos.telefono_wa,
    nombre: datos.nombre ?? null,
    empresa: datos.empresa ?? null,
    tipo: datos.tipo ?? 'otro',
    ciudad: datos.ciudad ?? null,
    correo: datos.correo ?? null,
    direccion: datos.direccion ?? null,
    puesto: datos.puesto ?? null,
    rfc: datos.rfc ?? null,
    telefono: datos.telefono ?? null,
    especificacion: datos.especificacion ?? null,
    // Datos fiscales (minuta 1): se guardan en el cliente para no volver a
    // pedírselos en el siguiente pedido.
    razon_social: datos.razon_social ?? null,
    regimen_fiscal: datos.regimen_fiscal ?? null,
    uso_cfdi: datos.uso_cfdi ?? null,
    cp_fiscal: datos.cp_fiscal ?? null,
    correo_facturacion: datos.correo_facturacion ?? null,
    requiere_factura: datos.requiere_factura ?? null,
    sucursal_id: datos.sucursal_id ?? null,
  };

  const { texto, valores } = construirUpsertCliente(fila);
  const { data, error } = await uno(texto, valores);

  if (error) {
    logger.error('upsertCliente falló:', error.message);
    return null;
  }
  return data;
}

/**
 * Crea una solicitud y sus items en una operación.
 * @param {object} params
 * @param {string} params.cliente_id
 * @param {string} params.ciudad_entrega
 * @param {string} params.urgencia - 'normal' | 'urgente' | 'programada'
 * @param {boolean} params.requiere_humano
 * @param {string} [params.notas]
 * @param {string} [params.direccion_entrega]
 * @param {string} [params.tiempo_entrega]       plazo requerido
 * @param {string} [params.vigencia_cotizacion]
 * @param {string} [params.nivel_urgencia]       texto crudo del nivel de urgencia
 * @param {Array<{descripcion_libre: string, cantidad: number, unidad?: string, producto_id?: string, nota?: string, categoria?: string, marca?: string, presentacion?: string}>} params.items
 * @returns {Promise<{solicitud: object, folio: string}|null>}
 */
export async function crearSolicitudConItems(params) {
  // Todo en UNA transacción. Antes, con Supabase, la solicitud y sus renglones
  // eran dos operaciones sueltas: si fallaban los renglones quedaba una
  // solicitud vacía que igual se le notificaba al asesor, y él veía un pedido
  // sin nada que cotizar. Ahora, o entra completa o no entra.
  try {
    return await enTransaccion(async (ejecutar) => {
      // NO enviamos `folio`: en la BD es columna identidad (GENERATED ALWAYS),
      // la asigna Postgres. Lo leemos de vuelta con RETURNING.
      const filas = await ejecutar(
        `insert into solicitudes (
           cliente_id, canal, estado, urgencia, ciudad_entrega, requiere_humano,
           notas, direccion_entrega, tiempo_entrega, vigencia_cotizacion,
           nivel_urgencia, requiere_factura, datos_fiscales, sucursal_id
         ) values (
           $1, 'whatsapp', 'nueva', $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11::jsonb, $12
         )
         returning *`,
        [
          params.cliente_id,
          params.urgencia ?? 'normal',
          params.ciudad_entrega ?? null,
          !!params.requiere_humano,
          params.notas ?? null,
          params.direccion_entrega ?? null,
          params.tiempo_entrega ?? null,
          params.vigencia_cotizacion ?? null,
          params.nivel_urgencia ?? null,
          // Minuta 1: se pregunta al final del flujo y se guarda con la solicitud.
          params.requiere_factura ?? null,
          params.datos_fiscales == null ? null : JSON.stringify(params.datos_fiscales),
          // Minuta 15 y 28: plaza que atiende la solicitud.
          params.sucursal_id ?? null,
        ]
      );

      const solicitud = filas[0];

      // Un INSERT por renglón: son un puñado y van contra localhost, así que
      // el costo es nulo y se lee mucho mejor que armar el VALUES a mano.
      for (const it of params.items ?? []) {
        await ejecutar(
          `insert into solicitud_items (
             solicitud_id, producto_id, descripcion_libre, cantidad, unidad,
             nota, categoria, marca, presentacion
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            solicitud.id,
            it.producto_id ?? null,
            it.descripcion_libre ?? null,
            it.cantidad ?? null,
            it.unidad ?? null,
            it.nota ?? null,
            it.categoria ?? null,
            it.marca ?? null,
            it.presentacion ?? null,
          ]
        );
      }

      // El folio definitivo es el que asignó la base de datos.
      return { solicitud, folio: solicitud.folio };
    });
  } catch (e) {
    logger.error('crearSolicitudConItems falló:', e?.message ?? e);
    return null;
  }
}
