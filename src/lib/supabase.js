// Cliente de Supabase usando la Service Role Key.
// IMPORTANTE: la Service Role Key omite las políticas RLS, por eso este cliente
// vive SOLO en el servidor y nunca se expone al cliente/navegador.
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { env } from '../config/env.js';

export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: { transport: ws },
  }
);

/**
 * Registra un mensaje en la tabla `mensajes` (log de toda la conversación).
 * Pensado para fallar en silencio: el logging nunca debe romper el flujo del bot.
 *
 * @param {object} m
 * @param {string} m.wa_id - número del contacto
 * @param {'in'|'out'} m.direccion - entrante ('in') o saliente ('out')
 * @param {string} [m.tipo] - tipo de mensaje (text, interactive, etc.)
 * @param {string} [m.cuerpo] - texto del mensaje
 * @param {object} [m.payload] - payload crudo opcional (jsonb)
 */
export async function registrarMensaje(m) {
  try {
    const { error } = await supabase.from('mensajes').insert({
      wa_id: m.wa_id,
      direccion: m.direccion,
      tipo: m.tipo ?? 'text',
      cuerpo: m.cuerpo ?? null,
      payload: m.payload ?? null,
    });
    if (error) {
      // No relanzamos: sólo dejamos rastro.
      console.error(`[registrarMensaje] no se pudo guardar: ${error.message}`);
    }
  } catch (err) {
    console.error('[registrarMensaje] excepción:', err?.message ?? err);
  }
}
