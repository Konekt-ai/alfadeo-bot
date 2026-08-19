// Servidor Express del webhook de WhatsApp para ALFA-DEO.
// Monta los endpoints, valida el entorno y escucha en PORT.
import express from 'express';
import { env, validarEntorno } from './config/env.js';
import { logger } from './utils/logger.js';
import { verifyWebhook, firmaValida, parseInbound } from './lib/whatsapp.js';
import { manejarMensaje } from './flows/abastecimiento.js';

const app = express();

// Parser de JSON con límite razonable. Meta envía JSON.
//
// El `verify` guarda el cuerpo CRUDO antes de parsearlo: la firma de Meta se
// calcula sobre esos bytes exactos, y `JSON.stringify(req.body)` no los
// reproduce (cambia espacios y orden de claves).
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.cuerpoCrudo = buf;
    },
  })
);

// ===================== Health check =====================
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// ===================== Verificación del webhook (Meta) =====================
// Meta hace un GET con hub.mode, hub.verify_token y hub.challenge.
app.get('/webhook', (req, res) => {
  const challenge = verifyWebhook(req.query);
  if (challenge !== null) {
    logger.info('Webhook verificado por Meta correctamente.');
    // Debe responderse el challenge en texto plano.
    return res.status(200).type('text/plain').send(challenge);
  }
  logger.warn('Verificación de webhook fallida (token o modo inválido).');
  return res.sendStatus(403);
});

// ===================== Recepción de eventos =====================
// REGLA CRÍTICA: responder 200 de inmediato para que Meta no reintente,
// y procesar los mensajes de forma asíncrona después.
app.post('/webhook', (req, res) => {
  // 0) ¿De verdad viene de Meta? Se comprueba ANTES de responder 200 y antes
  //    de tocar la base: un 403 aquí es la única barrera contra mensajes
  //    inventados por quien descubra la URL pública.
  if (!firmaValida(req.cuerpoCrudo, req.get('x-hub-signature-256'))) {
    logger.warn('POST /webhook con firma inválida: se descarta.');
    return res.sendStatus(403);
  }

  // 1) Responder ya.
  res.sendStatus(200);

  // 2) Procesar en segundo plano, todo dentro de try/catch.
  try {
    const mensajes = parseInbound(req.body);
    if (mensajes.length === 0) {
      // Puede ser un evento de status (entregado/leído) u otro tipo; lo ignoramos.
      logger.debug('POST /webhook sin mensajes de texto procesables.');
      return;
    }

    for (const inbound of mensajes) {
      // No usamos await: cada mensaje se procesa de forma independiente.
      // Los errores internos se capturan dentro de manejarMensaje.
      manejarMensaje(inbound).catch((err) => {
        logger.error('Error procesando mensaje:', err?.message ?? err);
      });
    }
  } catch (err) {
    // Nunca rompemos: el 200 ya se envió.
    logger.error('Error en POST /webhook:', err?.message ?? err);
  }
});

// ===================== Errores del parser =====================
// Un cuerpo que no sea JSON válido hace que express.json lance ANTES de llegar
// a la ruta. Sin este manejador, Express contesta 400 con una página HTML que
// incluye el stack trace, y esa URL es pública: no hay por qué regalar rutas
// internas del servidor a quien mande basura a propósito.
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn('POST con JSON malformado: se descarta.');
    return res.sendStatus(400);
  }
  return next(err);
});

// ===================== Raíz informativa =====================
app.get('/', (_req, res) => {
  res.status(200).send('ALFA-DEO WhatsApp bot — webhook activo.');
});

// ===================== Arranque =====================
const ok = validarEntorno();
if (!ok) {
  logger.warn(
    'El servidor arrancará, pero faltan variables de entorno. ' +
      'El webhook no funcionará correctamente hasta configurarlas.'
  );
}

app.listen(env.PORT, () => {
  logger.info(`Servidor ALFA-DEO escuchando en el puerto ${env.PORT}`);
});
