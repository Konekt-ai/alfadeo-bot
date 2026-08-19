// Verifica que el catálogo esté bien cargado en la base (minuta 17-20, 28).
//
//     npm run verificar-catalogo
//
// Revisa cuatro cosas:
//   1. Que las columnas del catálogo existan y estén pobladas.
//   2. Que el IVA esté bien clasificado.
//   3. Que la búsqueda por nombre comercial y por genérico devuelva algo.
//   4. Que el inventario esté asignado a una sucursal.
//
// Lee de la base local (DATABASE_URL). Es de sólo lectura: no modifica nada.
import 'dotenv/config';
import { sql, cerrarPool } from '../src/lib/db.js';

let problemas = 0;
const aviso = (msg) => { problemas++; console.log(`  ⚠️  ${msg}`); };

async function terminar(codigo) {
  await cerrarPool();
  process.exit(codigo);
}

console.log('\n=== 1. Columnas del catálogo (minuta 17) ===');
const { data: prods, error: errProd } = await sql(
  `select id, nombre, nombre_comercial, nombre_generico, concentracion,
          forma_farmaceutica, presentacion, tasa_iva
     from productos`
);

if (errProd) {
  console.log(`  ❌ No se pudo leer productos: ${errProd.message}`);
  console.log('     ¿Ya se corrieron las migraciones de la base?');
  await terminar(1);
}

const total = prods.length;
if (total === 0) {
  console.log('  ❌ La tabla productos está vacía.');
  await terminar(1);
}

const cuenta = (campo) => prods.filter((p) => p[campo]).length;

for (const campo of ['nombre_comercial', 'nombre_generico', 'concentracion', 'forma_farmaceutica', 'presentacion']) {
  const n = cuenta(campo);
  const pct = Math.round((n / total) * 100);
  console.log(`  ${campo.padEnd(20)} ${String(n).padStart(4)}/${total}  (${pct}%)`);
}

const sinGenerico = prods.filter((p) => !p.nombre_generico);
if (sinGenerico.length > 0) {
  aviso(`${sinGenerico.length} productos sin nombre genérico:`);
  sinGenerico.slice(0, 10).forEach((p) => console.log(`      · ${p.nombre}`));
}

console.log('\n=== 2. IVA (minuta 3) ===');
const tasa0 = prods.filter((p) => Number(p.tasa_iva) === 0).length;
console.log(`  Tasa 0% (medicamento): ${tasa0}/${total}`);
console.log(`  Con IVA 16%:           ${total - tasa0}/${total}`);

console.log('\n=== 3. Búsqueda por nombre (minuta 19, 20) ===');
for (const q of ['ondansetron', 'vylkor', 'acido zoledronico', 'valsartan', 'capecitabina']) {
  const { data, error } = await sql(
    'select * from buscar_productos($1, $2) order by score desc',
    [q, 3]
  );
  if (error) {
    aviso(`buscar_productos('${q}') falló: ${error.message}`);
    continue;
  }
  const primero = data?.[0];
  console.log(`  "${q}" -> ${data?.length ?? 0} resultado(s)` +
    (primero ? `  · top: ${primero.nombre_comercial ?? primero.nombre_generico} (score ${Number(primero.score).toFixed(2)})` : ''));
  if (!data || data.length === 0) aviso(`la búsqueda de "${q}" no devolvió nada`);
}

console.log('\n=== 4. Inventario por sucursal (minuta 28) ===');
// Lo que en PostgREST era un select anidado `sucursales ( clave, nombre )`
// aquí es un LEFT JOIN: el left importa, porque justo lo que se busca son
// los registros de inventario SIN sucursal asignada.
const { data: inv, error: errInv } = await sql(
  `select i.id, i.existencia, i.sucursal_id, s.clave, s.nombre
     from inventario i
     left join sucursales s on s.id = i.sucursal_id`
);

if (errInv) {
  aviso(`No se pudo leer inventario con sucursal: ${errInv.message}`);
} else {
  const sinSucursal = inv.filter((i) => !i.sucursal_id).length;
  const porPlaza = {};
  for (const i of inv) {
    const clave = i.clave ?? 'SIN ASIGNAR';
    porPlaza[clave] = (porPlaza[clave] ?? 0) + 1;
  }
  for (const [clave, n] of Object.entries(porPlaza)) {
    console.log(`  ${clave.padEnd(12)} ${n} registros`);
  }
  if (sinSucursal > 0) aviso(`${sinSucursal} registros de inventario sin sucursal asignada`);
}

console.log(
  problemas === 0
    ? '\n✅ Catálogo verificado, sin problemas.\n'
    : `\n⚠️  ${problemas} punto(s) a revisar.\n`
);
await terminar(problemas === 0 ? 0 : 1);
