// Verifica que la migración del catálogo haya quedado bien (minuta 17-20, 28).
//
// Correr DESPUÉS de aplicar supabase/reunion-catalogo-sucursales.sql:
//     npm run verificar-catalogo
//
// Revisa tres cosas:
//   1. Que las columnas nuevas existan y estén pobladas.
//   2. Que la búsqueda por nombre comercial y por genérico devuelva algo.
//   3. Que el inventario esté asignado a una sucursal.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

let problemas = 0;
const aviso = (msg) => { problemas++; console.log(`  ⚠️  ${msg}`); };

console.log('\n=== 1. Columnas del catálogo (minuta 17) ===');
const { data: prods, error: errProd } = await supabase
  .from('productos')
  .select('id, nombre, nombre_comercial, nombre_generico, concentracion, forma_farmaceutica, presentacion, tasa_iva');

if (errProd) {
  console.log(`  ❌ No se pudo leer productos: ${errProd.message}`);
  console.log('     ¿Ya corriste supabase/reunion-catalogo-sucursales.sql?');
  process.exit(1);
}

const total = prods.length;
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
  const { data, error } = await supabase.rpc('buscar_productos', { q, limite: 3 });
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
const { data: inv, error: errInv } = await supabase
  .from('inventario')
  .select('id, existencia, sucursal_id, sucursales ( clave, nombre )');

if (errInv) {
  aviso(`No se pudo leer inventario con sucursal: ${errInv.message}`);
} else {
  const sinSucursal = inv.filter((i) => !i.sucursal_id).length;
  const porPlaza = {};
  for (const i of inv) {
    const clave = i.sucursales?.clave ?? 'SIN ASIGNAR';
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
process.exit(problemas === 0 ? 0 : 1);
