// Capa de integración con la WhatsApp Cloud API oficial de Meta (Graph API).
// Usa fetch nativo de Node 20+. No se usa ninguna librería no oficial.
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// URL base del endpoint de mensajes para nuestro número.
function urlMensajes() {
  return `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/**
 * Verifica el handshake de Meta para el webhook (GET /webhook).
 * Devuelve el challenge (string) si es válido, o null si no lo es.
 *
 * @param {object} query - req.query de Express
 * @returns {string|null}
 */
export function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return challenge ?? '';
  }
  return null;
}

/**
 * Extrae los mensajes de texto entrantes del payload del webhook de Meta.
 * El payload de Meta es anidado: entry[] -> changes[] -> value -> messages[].
 * Sólo nos interesan los mensajes de tipo 'text' para este bot.
 *
 * @param {object} body - req.body del POST /webhook
 * @returns {Array<{wa_id: string, texto: string, messageId: string, nombrePerfil: string, tipo: string, raw: object}>}
 */
export function parseInbound(body) {
  const resultado = [];

  if (!body || body.object !== 'whatsapp_business_account') {
    return resultado;
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;

      // Mapa de wa_id -> nombre de perfil (viene en value.contacts[]).
      const contactos = Array.isArray(value.contacts) ? value.contacts : [];
      const nombrePorWaId = {};
      for (const c of contactos) {
        if (c?.wa_id) nombrePorWaId[c.wa_id] = c?.profile?.name ?? '';
      }

      const mensajes = Array.isArray(value.messages) ? value.messages : [];
      for (const m of mensajes) {
        const wa_id = m.from;
        const tipo = m.type;

        // Normalizamos el texto según el tipo de mensaje.
        // Para botones/listas interactivas extraemos el título seleccionado.
        let texto = '';
        let replyId = null;
        if (tipo === 'text') {
          texto = m.text?.body ?? '';
        } else if (tipo === 'interactive') {
          const boton = m.interactive?.button_reply;
          const lista = m.interactive?.list_reply;
          texto = boton?.title ?? lista?.title ?? boton?.id ?? lista?.id ?? '';
          replyId = boton?.id ?? lista?.id ?? null;
        } else if (tipo === 'button') {
          texto = m.button?.text ?? '';
          replyId = m.button?.payload ?? null;
        }

        resultado.push({
          wa_id,
          texto: (texto || '').trim(),
          // Id del botón/opción pulsada: más confiable que el título visible.
          replyId,
          messageId: m.id,
          nombrePerfil: nombrePorWaId[wa_id] ?? '',
          tipo,
          raw: m,
        });
      }
    }
  }

  return resultado;
}

/**
 * Envía un mensaje de texto libre por la Cloud API.
 * Sólo funciona dentro de la ventana de servicio de 24h del destinatario.
 * Fuera de la ventana hay que usar plantillas aprobadas. // TODO: plantillas
 *
 * @param {string} to - número destino en formato internacional sin '+' (ej. 5213312345678)
 * @param {string} body - cuerpo del mensaje
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
export async function sendText(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: false,
      body,
    },
  };

  try {
    const resp = await fetch(urlMensajes(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      logger.error(`sendText falló (${resp.status}) hacia ${to}:`, JSON.stringify(data));
      return { ok: false, status: resp.status, data };
    }

    logger.debug(`sendText OK hacia ${to}`);
    return { ok: true, status: resp.status, data };
  } catch (err) {
    logger.error(`sendText excepción hacia ${to}:`, err?.message ?? err);
    return { ok: false, status: 0, data: { error: String(err?.message ?? err) } };
  }
}

/**
 * Envía un mensaje con botones de respuesta rápida (máximo 3, límite de Meta).
 * Se usa para las preguntas de sí/no como "¿requieres factura?" (minuta 1):
 * es más rápido y menos ambiguo que pedir que escriban.
 *
 * Si el envío falla (por ejemplo si el número no soporta interactivos),
 * cae automáticamente a texto plano para no romper la conversación.
 *
 * @param {string} to
 * @param {string} cuerpo - texto de la pregunta
 * @param {Array<{id: string, titulo: string}>} botones - máx 3, título de 20 caracteres
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
export async function sendButtons(to, cuerpo, botones) {
  const lista = (botones ?? []).slice(0, 3).map((b) => ({
    type: 'reply',
    reply: { id: b.id, title: b.titulo.slice(0, 20) },
  }));

  if (lista.length === 0) return sendText(to, cuerpo);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      // El cuerpo de un interactivo admite 1024 caracteres.
      body: { text: cuerpo.slice(0, 1024) },
      action: { buttons: lista },
    },
  };

  try {
    const resp = await fetch(urlMensajes(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      logger.warn(
        `sendButtons falló (${resp.status}) hacia ${to}; se reintenta como texto.`
      );
      return sendText(to, cuerpo);
    }
    return { ok: true, status: resp.status, data };
  } catch (err) {
    logger.warn(`sendButtons excepción hacia ${to}; se reintenta como texto:`, err?.message ?? err);
    return sendText(to, cuerpo);
  }
}

/**
 * Marca un mensaje entrante como leído (palomitas azules). Opcional, mejora UX.
 * No es crítico: si falla, no rompe el flujo.
 *
 * @param {string} messageId
 */
export async function markRead(messageId) {
  if (!messageId) return;
  try {
    await fetch(urlMensajes(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    logger.debug('markRead falló (no crítico):', err?.message ?? err);
  }
}
