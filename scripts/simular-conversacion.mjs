// Simula una conversación completa contra la base REAL, sin mandar un solo
// mensaje de WhatsApp. Sirve para ver cómo responde el bot antes de publicar
// un cambio.
//
//     npm run simular
//
// Cómo evita efectos secundarios:
//   · Intercepta fetch hacia graph.facebook.com: nada sale a Meta.
//   · Vacía INTERNAL_NOTIFY_NUMBERS y RUTEO_ASESORES: ningún asesor recibe nada.
//   · Usa un wa_id de prueba y BORRA al final todo lo que haya escrito
//     (conversación, mensajes, cliente, solicitud e items).
//
// Lo único que no se puede deshacer es el consumo de un folio: la columna es
// identidad y su secuencia no retrocede. Es esperado.

// --- 1. Neutralizar destinos ANTES de que se cargue la configuración -------
// dotenv no pisa variables ya definidas, así que esto gana sobre el .env.
process.env.INTERNAL_NOTIFY_NUMBERS = '';
process.env.RUTEO_ASESORES = '';

const WA_PRUEBA = process.env.WA_PRUEBA || '520000000000';

// --- 2. Interceptar la Graph API ------------------------------------------
const fetchReal = globalThis.fetch;
const salientes = [];

globalThis.fetch = async (url, opciones) => {
  const destino = typeof url === 'string' ? url : url?.url ?? '';

  if (!destino.includes('graph.facebook.com')) {
    return fetchReal(url, opciones); // sólo se intercepta a Meta
  }

  const cuerpo = JSON.parse(opciones?.body ?? '{}');

  if (cuerpo.type === 'text') {
    salientes.push({ tipo: 'texto', para: cuerpo.to, texto: cuerpo.text.body });
  } else if (cuerpo.type === 'interactive') {
    salientes.push({
      tipo: 'botones',
      para: cuerpo.to,
      texto: cuerpo.interactive.body.text,
      botones: cuerpo.interactive.action.buttons.map((b) => b.reply.title),
    });
  }

  return new Response(
    JSON.stringify({ messages: [{ id: 'wamid.SIMULADO' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

// --- 3. Cargar el bot ya con el entorno neutralizado ----------------------
const { manejarMensaje } = await import('../src/flows/abastecimiento.js');
const { sql, cerrarPool } = await import('../src/lib/db.js');

// --- 3b. ¿Puede limpiar después? ------------------------------------------
// Esta simulación escribe en la base REAL y borra al terminar. El rol del bot
// no tiene DELETE a propósito (ver sql/rol-bot.sql), así que hay que
// comprobarlo ANTES de escribir nada: si no, la corrida deja un cliente y un
// pedido falsos a la vista de los asesores en el panel, y la siguiente corrida
// les apila otro encima.
{
  const { error } = await sql(
    "begin; delete from mensajes where wa_id = 'sonda-permiso-borrado'; rollback;"
  );
  if (error) {
    console.error('\n\x1b[31mNo puedo correr la simulación: no tengo permiso para borrar.\x1b[0m');
    console.error(`  ${error.message}\n`);
    console.error('  Escribe en la base real y limpia al terminar, pero con el rol restringido');
    console.error('  del bot no puede limpiar. Corre la prueba con el usuario del panel:\n');
    console.error('    DATABASE_URL=postgresql://alfadeo:CONTRASENA@localhost:5433/alfadeo npm run simular\n');
    await cerrarPool();
    process.exit(1);
  }
}

// --- 4. Los guiones -------------------------------------------------------
//     Se elige con:  node scripts/simular-conversacion.mjs <escenario>
const GUIONES = {
  // Camino feliz completo, con factura.
  completo: [
    'buenas tardes, tienen ondansetron 8 mg?',
    '1',
    '20',
    'no',
    'Diego Lizarraga',
    'Hospital San Javier',
    'Guadalajara',
    'si',
    'HOSPITAL SAN JAVIER SA DE CV',
    'HSJ980315AB2',
    '45116',
    'facturas@sanjavier.com',
    'si',
  ],

  // El cliente se desvía con preguntas frecuentes a mitad de la captura.
  desvios: [
    'hola, manejan capecitabina?',
    'oye y cuanto cuesta?',
    '10',
    'no',
    'y cuando me lo entregan?',
    'Ana Torres',
    'Farmacia del Centro',
    'Monterrey',
    'no',
    'si',
  ],

  // Producto que no existe en el catálogo: debe acabar con una persona.
  nohay: [
    'tienen zzzxyzquinolona 500?',
    'zzzxyzquinolona',
  ],

  // Toda la constancia fiscal pegada en un solo mensaje.
  fiscalPegado: [
    'necesito vylkor',
    '15',
    'no',
    'Luis Ramos',
    'Clinica Santa Maria',
    'Zapopan',
    'si',
    'Razon social: CLINICA SANTA MARIA SA DE CV\nRFC: CSM010203XY4\nCP 45050\ncorreo: pagos@santamaria.mx',
    'si',
  ],

  // Licitación: nunca la contesta el bot.
  licitacion: [
    'hola, participan en la licitacion del IMSS?',
  ],
};

const escenario = process.argv[2] ?? 'completo';
const GUION = GUIONES[escenario];

if (!GUION) {
  console.error(`Escenario desconocido: "${escenario}".`);
  console.error(`Disponibles: ${Object.keys(GUIONES).join(', ')}`);
  process.exit(1);
}

const sangrar = (texto, prefijo) =>
  texto.split('\n').map((l) => prefijo + l).join('\n');

console.log('\n' + '═'.repeat(72));
console.log(`  SIMULACIÓN "${escenario}" — no se envía nada a WhatsApp`);
console.log('═'.repeat(72));

for (const mensaje of GUION) {
  salientes.length = 0;

  await manejarMensaje({
    wa_id: WA_PRUEBA,
    texto: mensaje,
    messageId: `wamid.SIM${Date.now()}`,
    nombrePerfil: 'Prueba',
    tipo: 'text',
    raw: { simulado: true },
  });

  console.log('\n\x1b[36m▸ CLIENTE:\x1b[0m ' + mensaje);
  for (const s of salientes) {
    console.log('\x1b[32m◂ BOT:\x1b[0m');
    console.log(sangrar(s.texto, '    '));
    if (s.botones) console.log('    [ ' + s.botones.join(' ] [ ') + ' ]');
  }
  if (salientes.length === 0) console.log('\x1b[31m◂ BOT: (sin respuesta)\x1b[0m');
}

// --- 5. Qué quedó guardado ------------------------------------------------
console.log('\n' + '═'.repeat(72));
console.log('  LO QUE QUEDÓ EN LA BASE');
console.log('═'.repeat(72));

const { data: clientes } = await sql(
  'select * from clientes where telefono_wa = $1',
  [WA_PRUEBA]
);
const cliente = clientes?.[0] ?? null;

if (cliente) {
  console.log('\nCliente:', JSON.stringify({
    nombre: cliente.nombre, empresa: cliente.empresa, tipo: cliente.tipo,
    ciudad: cliente.ciudad, razon_social: cliente.razon_social, rfc: cliente.rfc,
    cp_fiscal: cliente.cp_fiscal, correo_facturacion: cliente.correo_facturacion,
    requiere_factura: cliente.requiere_factura, sucursal_id: cliente.sucursal_id ? 'asignada' : null,
  }, null, 2));

  // El `solicitud_items(...)` anidado de PostgREST se reproduce con un
  // jsonb_agg en subconsulta, para que la salida se siga viendo igual.
  const { data: sols } = await sql(
    `select s.folio, s.estado, s.urgencia, s.ciudad_entrega, s.requiere_humano,
            s.requiere_factura, s.datos_fiscales, s.sucursal_id, s.notas,
            coalesce(
              (select jsonb_agg(jsonb_build_object(
                        'descripcion_libre', i.descripcion_libre,
                        'cantidad',          i.cantidad,
                        'presentacion',      i.presentacion,
                        'nota',              i.nota))
                 from solicitud_items i
                where i.solicitud_id = s.id),
              '[]'::jsonb
            ) as solicitud_items
       from solicitudes s
      where s.cliente_id = $1`,
    [cliente.id]
  );

  console.log('\nSolicitudes:', JSON.stringify(sols, null, 2));
} else {
  console.log('\n(no se creó cliente)');
}

// --- 6. Limpieza ----------------------------------------------------------
console.log('\n' + '═'.repeat(72));
console.log('  LIMPIEZA');
console.log('═'.repeat(72));

let errores = 0;
const borrar = async (etiqueta, promesa) => {
  const { error } = await promesa;
  if (error) { errores++; console.log(`  ❌ ${etiqueta}: ${error.message}`); }
  else console.log(`  ✔ ${etiqueta}`);
};

if (cliente) {
  const { data: sols } = await sql(
    'select id from solicitudes where cliente_id = $1',
    [cliente.id]
  );
  const ids = (sols ?? []).map((s) => s.id);
  if (ids.length > 0) {
    // `= any($1)` es el equivalente del .in() de PostgREST y admite el arreglo
    // como UN solo parámetro, sin armar la lista de marcadores a mano.
    await borrar('solicitud_items', sql('delete from solicitud_items where solicitud_id = any($1)', [ids]));
    await borrar('solicitudes', sql('delete from solicitudes where id = any($1)', [ids]));
  }
}
await borrar('conversaciones', sql('delete from conversaciones where wa_id = $1', [WA_PRUEBA]));
await borrar('mensajes', sql('delete from mensajes where wa_id = $1', [WA_PRUEBA]));
if (cliente) {
  await borrar('clientes', sql('delete from clientes where telefono_wa = $1', [WA_PRUEBA]));
}

console.log(errores === 0
  ? '\n✅ Simulación terminada. No quedó nada de prueba en la base.\n'
  : `\n⚠️  Quedaron ${errores} cosas sin borrar; revísalas a mano (wa_id ${WA_PRUEBA}).\n`);

await cerrarPool();
process.exit(errores === 0 ? 0 : 1);
