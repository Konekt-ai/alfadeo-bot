// Carga y valida las variables de entorno.
// En local lee de .env (vía dotenv); en Railway las variables ya están inyectadas.
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

// Helper: lee una variable obligatoria; si falta, la registra como faltante.
const faltantes = [];
function requerida(nombre) {
  const valor = process.env[nombre];
  if (!valor || valor.trim() === '') {
    faltantes.push(nombre);
    return '';
  }
  return valor.trim();
}

// Helper: variable opcional con valor por defecto.
function opcional(nombre, porDefecto) {
  const valor = process.env[nombre];
  return valor && valor.trim() !== '' ? valor.trim() : porDefecto;
}

// Helper: booleano tolerante ("true", "1", "si", "sí").
function booleana(nombre, porDefecto) {
  const valor = process.env[nombre];
  if (!valor || valor.trim() === '') return porDefecto;
  return /^(1|true|si|sí|yes|on)$/i.test(valor.trim());
}

/**
 * Parsea el ruteo de asesores por sucursal (minuta 15).
 * Formato: "GDL:5213312345678,MTY:5218112345678"
 * @returns {Record<string, string>} { GDL: '5213...', MTY: '5218...' }
 */
function parsearRuteo(valor) {
  const mapa = {};
  for (const par of (valor || '').split(',')) {
    const [clave, numero] = par.split(':').map((s) => (s ?? '').trim());
    if (clave && numero) mapa[clave.toUpperCase()] = numero.replace(/\D/g, '');
  }
  return mapa;
}

export const env = {
  // ===== WhatsApp Cloud API =====
  WHATSAPP_TOKEN: requerida('WHATSAPP_TOKEN'),
  WHATSAPP_PHONE_NUMBER_ID: requerida('WHATSAPP_PHONE_NUMBER_ID'),
  WHATSAPP_VERIFY_TOKEN: requerida('WHATSAPP_VERIFY_TOKEN'),
  GRAPH_API_VERSION: opcional('GRAPH_API_VERSION', 'v21.0'),

  // ===== Supabase =====
  SUPABASE_URL: requerida('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requerida('SUPABASE_SERVICE_ROLE_KEY'),

  // ===== Equipo interno =====
  // Respaldo: recibe TODAS las solicitudes, sin importar la plaza.
  INTERNAL_NOTIFY_NUMBERS: opcional('INTERNAL_NOTIFY_NUMBERS', '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),

  // Ruteo por sucursal (minuta 15). Si está vacío se cae a INTERNAL_NOTIFY_NUMBERS.
  RUTEO_ASESORES: parsearRuteo(opcional('RUTEO_ASESORES', '')),
  SUCURSAL_DEFAULT: opcional('SUCURSAL_DEFAULT', 'GDL').toUpperCase(),

  // ===== Qué puede contestar el bot solo =====
  // Existencia: sí/no real consultando inventario, SIN revelar piezas (minuta 2).
  BOT_DA_EXISTENCIA: booleana('BOT_DA_EXISTENCIA', true),
  // Piezas exactas: apagado a propósito, expondría el nivel de inventario.
  BOT_DA_CANTIDADES: booleana('BOT_DA_CANTIDADES', false),
  // Precio: siempre lo confirma un asesor (el precio B2B depende de cliente y volumen).
  BOT_DA_PRECIOS: booleana('BOT_DA_PRECIOS', false),

  // ===== Logística / tiempos de entrega (minuta 5, 6) =====
  PAQUETERIA: opcional('PAQUETERIA', 'DHL'),
  // Hora (0-23) después de la cual el pedido ya sale al día siguiente.
  ENTREGA_HORA_CORTE: Number(opcional('ENTREGA_HORA_CORTE', '15')),
  // Días hábiles extra cuando el producto hay que pedirlo a proveedor.
  ENTREGA_DIAS_PROVEEDOR: Number(opcional('ENTREGA_DIAS_PROVEEDOR', '2')),
  ZONA_HORARIA: opcional('ZONA_HORARIA', 'America/Mexico_City'),

  // ===== Reglas de negocio =====
  ESCALA_CANTIDAD_UMBRAL: Number(opcional('ESCALA_CANTIDAD_UMBRAL', '500')),

  // ===== Servidor =====
  PORT: Number(opcional('PORT', '3000')),
};

// Validación al arranque: si faltan variables críticas, avisamos fuerte.
// No tiramos el proceso en producción para que /health siga respondiendo,
// pero dejamos un log de ERROR muy visible.
export function validarEntorno() {
  let ok = true;

  if (faltantes.length > 0) {
    logger.error(
      `Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. ` +
        'Configúralas en .env (local) o en Railway (producción).'
    );
    ok = false;
  }

  const numericas = [
    ['ESCALA_CANTIDAD_UMBRAL', env.ESCALA_CANTIDAD_UMBRAL],
    ['ENTREGA_HORA_CORTE', env.ENTREGA_HORA_CORTE],
    ['ENTREGA_DIAS_PROVEEDOR', env.ENTREGA_DIAS_PROVEEDOR],
  ];
  for (const [nombre, valor] of numericas) {
    if (Number.isNaN(valor)) {
      logger.error(`${nombre} no es un número válido.`);
      ok = false;
    }
  }

  if (env.ENTREGA_HORA_CORTE < 0 || env.ENTREGA_HORA_CORTE > 23) {
    logger.error('ENTREGA_HORA_CORTE debe estar entre 0 y 23.');
    ok = false;
  }

  if (Object.keys(env.RUTEO_ASESORES).length === 0) {
    logger.warn(
      'RUTEO_ASESORES sin configurar: todas las solicitudes se notificarán a ' +
        'INTERNAL_NOTIFY_NUMBERS sin distinguir plaza (minuta 15).'
    );
  }

  if (ok) logger.info('Variables de entorno cargadas correctamente.');
  return ok;
}
