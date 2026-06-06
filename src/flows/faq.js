// Respuestas de información (texto fijo y configurable).
// Edita estos textos sin tocar la lógica del bot.
// REGLA CRÍTICA: nunca incluir precios, existencias ni tiempos de entrega.

export const FAQ = {
  // Texto del menú principal (se reutiliza en bienvenida y al volver al menú).
  menu:
    '¿En qué te puedo ayudar? Responde con el número:\n\n' +
    '1️⃣ Solicitar abastecimiento\n' +
    '2️⃣ Información (quiénes somos, categorías, horario y ubicación)\n' +
    '3️⃣ Hablar con una persona',

  bienvenida:
    '¡Hola! 👋 Bienvenido a *ALFA-DEO*, distribuidora farmacéutica B2B.\n' +
    'Soy el asistente de abastecimiento.',

  // Submenú de información (opción 2). Se muestra antes de las respuestas específicas.
  infoMenu:
    'ℹ️ *Información ALFA-DEO* — elige una opción:\n\n' +
    'a) Quiénes somos\n' +
    'b) Categorías que manejamos\n' +
    'c) Horario de atención\n' +
    'd) Ubicación\n\n' +
    'O escribe *menú* para volver al inicio.',

  quienesSomos:
    '*ALFA-DEO* es una distribuidora farmacéutica B2B. Atendemos a hospitales, ' +
    'clínicas, farmacias, dependencias de gobierno, distribuidores y profesionales ' +
    'de la salud, con un servicio de abastecimiento confiable y trato directo.',

  categorias:
    'Manejamos diversas *categorías* de insumos y medicamentos para el sector salud ' +
    '(medicamento de patente y genérico, material de curación, insumos de laboratorio, ' +
    'entre otras). Indícanos el producto que necesitas y un asesor te confirma disponibilidad.\n\n' +
    '_Disponibilidad y precio siempre sujetos a confirmación._',

  horario:
    '🕘 *Horario de atención:* lunes a viernes de 9:00 a 18:00 h y sábados de 9:00 a 13:00 h (hora del centro de México).',

  ubicacion:
    '📍 Estamos en *Zapopan, Jalisco, México*. Para coordinar entregas o visitas, ' +
    'un asesor te dará los detalles según tu solicitud.',

  // Leyenda obligatoria que acompaña cualquier registro de solicitud.
  sujetoConfirmacion:
    'Tu solicitud quedó registrada. Un asesor la revisará y te confirmará disponibilidad y precio. _(sujeto a confirmación)_',

  // Mensaje cuando el usuario pide precio/existencia/tiempo de entrega directamente.
  noPrecios:
    'Con gusto lo gestionamos. Por política, *no damos precio, existencia ni tiempo de entrega de forma automática*: ' +
    'todo queda *sujeto a confirmación* de un asesor. Registremos tu solicitud y te contactamos.',

  // Mensaje al escalar a una persona.
  escalado:
    '✅ Listo. Un asesor del equipo de *ALFA-DEO* te contactará personalmente lo antes posible.',

  // Mensaje cuando no se entiende la entrada.
  noEntendido:
    'No te entendí 🤔. Escribe *menú* para ver las opciones disponibles.',
};

/**
 * Resuelve la respuesta del submenú de información (opción 2).
 * @param {string} texto - entrada del usuario (ya en minúsculas idealmente)
 * @returns {string|null} respuesta o null si no coincide con ninguna opción
 */
export function respuestaInfo(texto) {
  const t = (texto || '').trim().toLowerCase();
  if (['a', 'quienes somos', 'quiénes somos', '1'].includes(t)) return FAQ.quienesSomos;
  if (['b', 'categorias', 'categorías', '2'].includes(t)) return FAQ.categorias;
  if (['c', 'horario', '3'].includes(t)) return FAQ.horario;
  if (['d', 'ubicacion', 'ubicación', '4'].includes(t)) return FAQ.ubicacion;
  return null;
}
