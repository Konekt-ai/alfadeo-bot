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

export const env = {
  // WhatsApp Cloud API
  WHATSAPP_TOKEN: requerida('WHATSAPP_TOKEN'),
  WHATSAPP_PHONE_NUMBER_ID: requerida('WHATSAPP_PHONE_NUMBER_ID'),
  WHATSAPP_VERIFY_TOKEN: requerida('WHATSAPP_VERIFY_TOKEN'),
  GRAPH_API_VERSION: opcional('GRAPH_API_VERSION', 'v21.0'),

  // Supabase
  SUPABASE_URL: requerida('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requerida('SUPABASE_SERVICE_ROLE_KEY'),

  // Equipo interno: lista separada por comas -> array de strings
  INTERNAL_NOTIFY_NUMBERS: opcional('INTERNAL_NOTIFY_NUMBERS', '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),

  // Reglas de negocio
  ESCALA_CANTIDAD_UMBRAL: Number(opcional('ESCALA_CANTIDAD_UMBRAL', '500')),

  // Servidor
  PORT: Number(opcional('PORT', '3000')),
};

// Validación al arranque: si faltan variables críticas, avisamos fuerte.
// No tiramos el proceso en producción para que /health siga respondiendo,
// pero dejamos un log de ERROR muy visible.
export function validarEntorno() {
  if (faltantes.length > 0) {
    logger.error(
      `Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. ` +
        'Configúralas en .env (local) o en Railway (producción).'
    );
    return false;
  }
  if (Number.isNaN(env.ESCALA_CANTIDAD_UMBRAL)) {
    logger.error('ESCALA_CANTIDAD_UMBRAL no es un número válido.');
    return false;
  }
  logger.info('Variables de entorno cargadas correctamente.');
  return true;
}
