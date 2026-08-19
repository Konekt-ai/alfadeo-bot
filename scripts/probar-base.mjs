// ¿El bot alcanza la base y tiene los permisos que necesita?
//
//     npm run probar-base
//
// Es lo primero que hay que correr en la computadora del mostrador después
// de un despliegue: contesta en segundos si el problema es de base, de
// permisos o de configuración, sin tener que leer logs.
//
// Sólo lee. No modifica nada.
import 'dotenv/config';
import { sql, cerrarPool } from '../src/lib/db.js';

const ok = (m) => console.log(`  \x1b[32m[OK]\x1b[0m    ${m}`);
const mal = (m) => console.log(`  \x1b[31m[FALLA]\x1b[0m ${m}`);

let fallas = 0;

console.log('\nComprobando la base del bot\n');

// --- 1. ¿Está configurada la URL? -----------------------------------------
if (!process.env.DATABASE_URL) {
  mal('Falta DATABASE_URL en .env');
  console.log('        Ejemplo: postgresql://bot:CONTRASENA@localhost:5433/alfadeo\n');
  process.exit(1);
}
// Se imprime sin la contraseña: este comando se corre por SSH y queda en pantalla.
ok(`DATABASE_URL apunta a ${process.env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);

// --- 2. ¿Contesta? ---------------------------------------------------------
const { data: version, error: errConn } = await sql('select version() as v, current_user as usuario');
if (errConn) {
  mal(`No conecta: ${errConn.message}`);
  await cerrarPool();
  process.exit(1);
}
ok(`Conecta como usuario "${version[0].usuario}"`);
console.log(`        ${version[0].v.split(',')[0]}`);

if (version[0].usuario === 'alfadeo') {
  console.log('  \x1b[33m[ ]\x1b[0m     Estás usando el usuario del panel. Para el bot conviene el rol');
  console.log('        restringido: psql -f sql/rol-bot.sql  (ver ese archivo).');
}

// --- 3. ¿Están las tablas que usa el bot? ---------------------------------
const TABLAS = ['clientes', 'conversaciones', 'mensajes', 'solicitudes', 'solicitud_items', 'sucursales'];
for (const t of TABLAS) {
  const { data, error } = await sql(`select count(*)::int as n from ${t}`);
  if (error) { mal(`${t.padEnd(16)} ${error.message}`); fallas++; }
  else ok(`${t.padEnd(16)} ${data[0].n} filas`);
}

// --- 4. ¿Existe la función de búsqueda? -----------------------------------
const { data: prods, error: errBusca } = await sql(
  'select * from buscar_productos($1, $2) order by score desc',
  ['paracetamol', 3]
);
if (errBusca) {
  mal(`buscar_productos: ${errBusca.message}`);
  fallas++;
} else {
  ok(`buscar_productos responde (${prods.length} resultado(s) de prueba)`);
  // El bot depende de estas dos columnas: score para ordenar y filtrar,
  // disponibilidad para saber en qué plaza hay existencia.
  if (prods.length > 0) {
    for (const col of ['score', 'disponibilidad', 'nombre_comercial']) {
      if (!(col in prods[0])) { mal(`a buscar_productos le falta la columna "${col}"`); fallas++; }
    }
  }
}

// --- 5. ¿Puede escribir? ---------------------------------------------------
// Todo dentro de begin/rollback: comprueba los permisos sin dejar basura.
const { error: errInsert } = await sql(
  `begin;
   insert into mensajes (wa_id, direccion, tipo, cuerpo) values ('sonda-permisos', 'in', 'text', 'prueba');
   rollback;`
);
if (errInsert) { mal(`No puede INSERT en mensajes: ${errInsert.message}`); fallas++; }
else ok('Puede INSERT (probado con rollback, no quedó nada)');

// El UPDATE se prueba aparte: el bot lo necesita para el upsert de clientes y
// de conversaciones, y un rol al que sólo se le dio INSERT pasaría la prueba
// anterior y fallaría en la primera conversación.
const { error: errUpdate } = await sql(
  `begin;
   update conversaciones set ultima_actividad = now() where wa_id = 'sonda-permisos';
   rollback;`
);
if (errUpdate) { mal(`No puede UPDATE en conversaciones: ${errUpdate.message}`); fallas++; }
else ok('Puede UPDATE');

// DELETE se informa, no se exige: el rol del bot NO lo tiene a propósito. Sólo
// se avisa porque `npm run simular` sí lo necesita para limpiar lo que escribe.
const { error: errDelete } = await sql(
  `begin;
   delete from mensajes where wa_id = 'sonda-permisos';
   rollback;`
);
if (errDelete) {
  console.log('  [33m[ ][0m     Sin permiso de DELETE (correcto para el bot).');
  console.log('        `npm run simular` no podrá limpiar; córrelo con el usuario del panel.');
} else {
  ok('Puede DELETE (estás usando un rol con más permisos de los que el bot necesita)');
}

console.log(
  fallas === 0
    ? '\n\x1b[32mTodo bien: el bot puede trabajar contra esta base.\x1b[0m\n'
    : `\n\x1b[31m${fallas} problema(s).\x1b[0m Revisa las migraciones y sql/rol-bot.sql\n`
);

await cerrarPool();
process.exit(fallas === 0 ? 0 : 1);
