// Textos del bot. Se editan aquí sin tocar la lógica.
//
// Criterios de redacción que salieron en la reunión (minuta 13: "textos más
// grandes y más intuitivo"): frases cortas, una idea por línea, negritas en lo
// que importa y nada de párrafos largos — en WhatsApp no se leen.
//
// Las tres preguntas frecuentes de la minuta 2 se responden así:
//   ¿Tienen el medicamento? -> consulta real a inventario (flujo principal)
//   ¿Cuánto cuesta?         -> FAQ.precio (siempre lo confirma un asesor)
//   ¿Cuándo lo entregan?    -> se calcula con el calendario (services/entrega.js)
import { env } from '../config/env.js';

export const FAQ = {
  bienvenida:
    '¡Hola! 👋 Bienvenido a *ALFA-DEO*\n' +
    'Distribuidora farmacéutica.',

  // Menú corto. Tres opciones caben como botones de WhatsApp.
  menu:
    '¿Qué necesitas?\n\n' +
    '1️⃣  *Consultar un producto*\n' +
    '2️⃣  *Información* (horario, envíos, facturación)\n' +
    '3️⃣  *Hablar con un asesor*\n\n' +
    'También puedes escribirme directo el nombre del medicamento. 💊',

  // Se le pide el producto de entrada: es lo primero que pregunta el cliente real.
  pedirProducto:
    '💊 Escríbeme el *nombre del medicamento* que necesitas.\n\n' +
    '_Ejemplos:_\n' +
    '• _Ondansetrón 8 mg_\n' +
    '• _Vylkor_\n' +
    '• _Ácido zoledrónico inyectable_',

  // ---------------------------------------------------------------
  // Minuta 2 · "¿Cuánto cuesta?"
  // ---------------------------------------------------------------
  precio:
    '💲 *Sobre el precio*\n\n' +
    'El precio depende del volumen y de tu tipo de cliente, ' +
    'así que te lo confirma un asesor — normalmente el mismo día.\n\n' +
    'Dime *cuántas piezas* necesitas y lo cotizamos.',

  // Misma idea, para cuando la cantidad YA se capturó y pedirla otra vez sobra.
  precioBreve:
    '💲 El precio te lo confirma un asesor en breve ' +
    '(depende del volumen y de tu tipo de cliente).',

  // ---------------------------------------------------------------
  // Minuta 2 y 5 · "¿Cuándo lo entregan?"
  // ---------------------------------------------------------------
  enviosGeneral:
    `🚚 *Envíos*\n\n` +
    `Enviamos por *${env.PAQUETERIA}* y paquetería privada a toda la República.\n\n` +
    `• Pedido confirmado antes de las *${env.ENTREGA_HORA_CORTE}:00 h* → sale el mismo día\n` +
    `• Entrega normalmente *al día siguiente*\n` +
    `• Si sale *viernes*, llega el *martes* (la paquetería no entrega en fin de semana)\n\n` +
    '_La fecha exacta se confirma al cerrar el pedido._',

  // ---------------------------------------------------------------
  // Minuta 1 y 3 · Facturación
  // ---------------------------------------------------------------
  preguntaFactura:
    '🧾 Última pregunta: *¿requieres factura?*\n\n' +
    'Responde *sí* o *no*.',

  facturaSinIVA:
    '_Nota: la mayoría de los medicamentos son *tasa 0% de IVA*, ' +
    'así que tu factura normalmente no lleva IVA._',

  facturaDatos:
    '🧾 Perfecto. Necesito tus *datos fiscales*.\n\n' +
    'Puedes mandarlos en un solo mensaje o te los pido uno por uno.\n\n' +
    '¿Cuál es tu *Razón Social* (nombre fiscal exacto)?',

  facturaInfo:
    '🧾 *Facturación*\n\n' +
    'Facturamos todos los pedidos. Te pedimos:\n\n' +
    '• Razón Social\n' +
    '• RFC\n' +
    '• Código Postal fiscal\n' +
    '• Uso de CFDI\n' +
    '• Correo para enviarte el PDF y XML\n\n' +
    'La mayoría de los medicamentos son *tasa 0% de IVA*.',

  // ---------------------------------------------------------------
  // Información general
  // ---------------------------------------------------------------
  infoMenu:
    'ℹ️ *Información* — elige una opción:\n\n' +
    '*a)* Envíos y tiempos de entrega\n' +
    '*b)* Facturación\n' +
    '*c)* Horario de atención\n' +
    '*d)* Quiénes somos y qué manejamos\n\n' +
    'O escribe *menú* para volver.',

  quienesSomos:
    '🏥 *ALFA-DEO*\n\n' +
    'Somos distribuidora farmacéutica. Atendemos hospitales, clínicas, ' +
    'farmacias, dependencias de gobierno, distribuidores y médicos.\n\n' +
    'Manejamos medicamento de patente y genérico, oncológicos, ' +
    'material de curación e insumos de laboratorio.\n\n' +
    '📍 *Guadalajara, Jalisco* y *Monterrey, Nuevo León*.',

  horario:
    '🕘 *Horario de atención*\n\n' +
    '• Lunes a viernes: *9:00 a 18:00 h*\n' +
    '• Sábados: *9:00 a 13:00 h*\n\n' +
    '_Hora del centro de México._',

  // ---------------------------------------------------------------
  // Estados del flujo
  // ---------------------------------------------------------------
  sinResultados:
    '🔎 No encontré ese producto en el catálogo con ese nombre.\n\n' +
    'Puede que lo manejemos con otra marca, o lo conseguimos con proveedor.\n\n' +
    'Intenta con el *nombre genérico* (la sustancia), o escribe *asesor* ' +
    'y una persona te ayuda a localizarlo.',

  sinExistencia:
    '⏳ Ese producto *no lo tengo en existencia* en este momento, ' +
    'pero lo conseguimos con proveedor.',

  escalado:
    '✅ Listo. Un asesor de *ALFA-DEO* te contacta personalmente en breve.',

  noEntendido:
    '🤔 No te entendí.\n\n' +
    'Escríbeme el *nombre del medicamento* que buscas, ' +
    'o escribe *menú* para ver las opciones.',

  errorTecnico:
    '⚠️ Tuvimos un detalle técnico procesando tu mensaje.\n' +
    'Escribe *menú* para reintentar, o *asesor* para que te atienda una persona.',

  // Leyenda obligatoria al cerrar una solicitud.
  sujetoConfirmacion:
    'Un asesor confirma *precio y disponibilidad final* en breve.',
};

/**
 * Resuelve el submenú de información.
 * @param {string} textoNormalizado - entrada del usuario ya normalizada
 * @returns {string|null} respuesta, o null si no coincide
 */
export function respuestaInfo(textoNormalizado) {
  const t = (textoNormalizado || '').trim();
  if (['a', '1', 'envios', 'envio', 'entrega', 'entregas'].includes(t)) return FAQ.enviosGeneral;
  if (['b', '2', 'factura', 'facturacion', 'facturas'].includes(t)) return FAQ.facturaInfo;
  if (['c', '3', 'horario', 'horarios'].includes(t)) return FAQ.horario;
  if (['d', '4', 'quienes somos', 'nosotros', 'ubicacion', 'categorias'].includes(t)) {
    return FAQ.quienesSomos;
  }
  return null;
}
