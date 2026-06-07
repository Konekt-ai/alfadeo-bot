// Servicio de solicitudes: upsert de cliente, creación de solicitud e items.
// Trabaja contra el esquema YA existente en Supabase.
import { supabase } from '../lib/supabase.js';
import { logger } from '../utils/logger.js';

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
  };

  // Quitamos llaves nulas para no pisar datos previos con null en un upsert.
  Object.keys(fila).forEach((k) => {
    if (fila[k] === null || fila[k] === '') delete fila[k];
  });

  const { data, error } = await supabase
    .from('clientes')
    .upsert(fila, { onConflict: 'telefono_wa' })
    .select()
    .single();

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
  // NO enviamos `folio`: en la BD es una columna identidad (GENERATED ALWAYS),
  // la genera Supabase automáticamente. Lo leemos de vuelta con .select().
  const { data: solicitud, error: errSol } = await supabase
    .from('solicitudes')
    .insert({
      cliente_id: params.cliente_id,
      canal: 'whatsapp',
      estado: 'nueva',
      urgencia: params.urgencia ?? 'normal',
      ciudad_entrega: params.ciudad_entrega ?? null,
      requiere_humano: !!params.requiere_humano,
      notas: params.notas ?? null,
      direccion_entrega: params.direccion_entrega ?? null,
      tiempo_entrega: params.tiempo_entrega ?? null,
      vigencia_cotizacion: params.vigencia_cotizacion ?? null,
      nivel_urgencia: params.nivel_urgencia ?? null,
    })
    .select()
    .single();

  if (errSol) {
    logger.error('crearSolicitud falló:', errSol.message);
    return null;
  }

  // El folio definitivo es el que asignó la base de datos.
  const folio = solicitud.folio;

  const items = (params.items ?? []).map((it) => ({
    solicitud_id: solicitud.id,
    producto_id: it.producto_id ?? null,
    descripcion_libre: it.descripcion_libre ?? null,
    cantidad: it.cantidad ?? null,
    unidad: it.unidad ?? null,
    nota: it.nota ?? null,
    categoria: it.categoria ?? null,
    marca: it.marca ?? null,
    presentacion: it.presentacion ?? null,
  }));

  if (items.length > 0) {
    const { error: errItems } = await supabase.from('solicitud_items').insert(items);
    if (errItems) {
      // La solicitud ya quedó creada; registramos el error de items pero no abortamos.
      logger.error('crearSolicitudItems falló:', errItems.message);
    }
  }

  return { solicitud, folio };
}
