// Pruebas de la lógica del bot. No tocan la base de datos ni la API de Meta.
// Correr con:  npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizar, esAfirmativo, esNegativo, extraerCantidad,
  extraerRFC, extraerCP, extraerCorreo,
} from '../src/utils/texto.js';
import { calcularEntrega, esFestivo, esHabil } from '../src/lib/fechas.js';
import { detectarIntencion, detectarIntenciones, requiereHumano, pareceProducto, INTENCION } from '../src/flows/intenciones.js';
import { limpiarConsulta, nombreProducto, fichaProducto, disponibilidadTexto, hayExistencia, sucursalesConStock, agruparLotes } from '../src/services/catalogo.js';
import { extraerDatosFiscales, validarDatoFiscal, siguienteDatoFiscal, datosFiscalesCompletos, avisoIVA } from '../src/services/facturacion.js';
import { resolverSucursal, plazaPorTexto } from '../src/services/ruteo.js';
import { construirUpsertCliente } from '../src/services/solicitudes.js';

// ---------------------------------------------------------------------------
describe('utils/texto', () => {
  test('normalizar quita acentos y espacios', () => {
    assert.equal(normalizar('  Ondansetrón   8MG '), 'ondansetron 8mg');
    assert.equal(normalizar('ÁCIDO FÓLICO'), 'acido folico');
  });

  test('afirmativo y negativo', () => {
    for (const s of ['sí', 'si', 'Claro', 'ok', 'va', 'dale', 'correcto']) {
      assert.equal(esAfirmativo(s), true, `debería ser afirmativo: ${s}`);
    }
    for (const s of ['no', 'nel', 'cancelar', 'corregir']) {
      assert.equal(esNegativo(s), true, `debería ser negativo: ${s}`);
    }
    assert.equal(esAfirmativo('no'), false);
  });

  test('extraerCantidad lee números con separador de miles', () => {
    assert.equal(extraerCantidad('necesito 20 cajas'), 20);
    assert.equal(extraerCantidad('1,500 piezas'), 1500);
    assert.equal(extraerCantidad('sin números'), null);
  });

  test('extrae RFC, CP y correo', () => {
    assert.equal(extraerRFC('mi rfc es AFD120315AB9 gracias'), 'AFD120315AB9');
    assert.equal(extraerRFC('RFC: LOPJ850101H23'), 'LOPJ850101H23');
    assert.equal(extraerRFC('no traigo'), null);
    assert.equal(extraerCP('CP 45050 Zapopan'), '45050');
    assert.equal(extraerCorreo('mándalo a compras@hospital.com por favor'), 'compras@hospital.com');
  });
});

// ---------------------------------------------------------------------------
describe('lib/fechas · tiempos de entrega (minuta 5)', () => {
  const en = (iso) => calcularEntrega({ instante: new Date(iso) });

  test('lunes temprano: sale hoy, llega al día siguiente', () => {
    const r = en('2026-08-10T16:00:00Z'); // 10:00 CDMX
    assert.equal(r.envioTexto, 'lunes 10 de agosto');
    assert.equal(r.entregaTexto, 'martes 11 de agosto');
    assert.equal(r.saleHoy, true);
  });

  test('pasada la hora de corte: sale al día siguiente', () => {
    const r = en('2026-08-10T23:00:00Z'); // 17:00 CDMX
    assert.equal(r.envioTexto, 'martes 11 de agosto');
    assert.equal(r.saleHoy, false);
  });

  test('REGLA DEL VIERNES: envío viernes -> entrega martes', () => {
    const r = en('2026-08-14T16:00:00Z'); // viernes 10:00 CDMX
    assert.equal(r.envioTexto, 'viernes 14 de agosto');
    assert.equal(r.entregaTexto, 'martes 18 de agosto');
    assert.equal(r.envioEnViernes, true);
  });

  test('fin de semana: sale el lunes', () => {
    assert.equal(en('2026-08-15T16:00:00Z').envioTexto, 'lunes 17 de agosto'); // sábado
    assert.equal(en('2026-08-16T16:00:00Z').envioTexto, 'lunes 17 de agosto'); // domingo
  });

  test('la entrega salta días festivos', () => {
    // 16 sep 2026 (Independencia) cae miércoles.
    const r = en('2026-09-15T16:00:00Z');
    assert.equal(r.envioTexto, 'martes 15 de septiembre');
    assert.equal(r.entregaTexto, 'jueves 17 de septiembre');
  });

  test('festivos oficiales de 2026', () => {
    const f = (m, d) => esFestivo(new Date(Date.UTC(2026, m - 1, d)));
    assert.equal(f(1, 1), true);   // Año Nuevo
    assert.equal(f(2, 2), true);   // primer lunes de febrero
    assert.equal(f(3, 16), true);  // tercer lunes de marzo
    assert.equal(f(5, 1), true);   // Día del Trabajo
    assert.equal(f(9, 16), true);  // Independencia
    assert.equal(f(11, 16), true); // tercer lunes de noviembre
    assert.equal(f(12, 25), true); // Navidad
    assert.equal(f(2, 9), false);  // segundo lunes de febrero: hábil
    assert.equal(esHabil(new Date(Date.UTC(2026, 7, 15))), false); // sábado
  });

  test('sin existencia se agregan días de proveedor', () => {
    const conStock = calcularEntrega({ instante: new Date('2026-08-10T16:00:00Z'), enExistencia: true });
    const sinStock = calcularEntrega({ instante: new Date('2026-08-10T16:00:00Z'), enExistencia: false });
    assert.ok(sinStock.diaEnvio > conStock.diaEnvio, 'sin stock debe salir después');
    assert.equal(sinStock.desdeProveedor, true);
  });
});

// ---------------------------------------------------------------------------
describe('flows/intenciones · las 3 preguntas frecuentes (minuta 2)', () => {
  test('¿tienen el medicamento?', () => {
    assert.equal(detectarIntencion('tienen ondansetron 8mg?'), INTENCION.EXISTENCIA);
    assert.equal(detectarIntencion('manejan acido zoledronico'), INTENCION.EXISTENCIA);
    assert.equal(detectarIntencion('hay disponibilidad de venclexta'), INTENCION.EXISTENCIA);
  });

  test('¿cuánto cuesta?', () => {
    assert.equal(detectarIntencion('cuanto cuesta?'), INTENCION.PRECIO);
    assert.equal(detectarIntencion('me pasas precio por favor'), INTENCION.PRECIO);
    assert.equal(detectarIntencion('necesito una cotizacion'), INTENCION.PRECIO);
  });

  test('¿cuándo lo entregan?', () => {
    assert.equal(detectarIntencion('cuando lo entregan?'), INTENCION.ENTREGA);
    assert.equal(detectarIntencion('en cuanto llega a monterrey'), INTENCION.ENTREGA);
    assert.equal(detectarIntencion('cual es el tiempo de entrega'), INTENCION.ENTREGA);
  });

  test('entrega gana sobre precio cuando ambas caben', () => {
    // "cuánto tarda" no debe leerse como "cuánto cuesta".
    assert.equal(detectarIntencion('cuanto tarda en llegar'), INTENCION.ENTREGA);
  });

  test('un mensaje puede traer varias intenciones', () => {
    const i = detectarIntenciones('hola, tienen ondansetron y cuanto cuesta?');
    assert.ok(i.includes(INTENCION.EXISTENCIA));
    assert.ok(i.includes(INTENCION.PRECIO));
  });

  test('factura y asesor', () => {
    assert.equal(detectarIntencion('necesito factura'), INTENCION.FACTURA);
    assert.equal(detectarIntencion('me das mi cfdi'), INTENCION.FACTURA);
    assert.equal(detectarIntencion('quiero hablar con un asesor'), INTENCION.ASESOR);
  });

  test('licitaciones y quejas siempre van a una persona', () => {
    assert.equal(requiereHumano('participan en la licitacion del imss?'), true);
    assert.equal(requiereHumano('tengo una queja con mi pedido'), true);
    assert.equal(requiereHumano('tienen paracetamol'), false);
  });

  test('pareceProducto descarta cortesías', () => {
    assert.equal(pareceProducto('gracias', limpiarConsulta('gracias')), false);
    assert.equal(pareceProducto('ok', limpiarConsulta('ok')), false);
    assert.equal(pareceProducto('tienen ondansetron?', limpiarConsulta('tienen ondansetron?')), true);
  });
});

// ---------------------------------------------------------------------------
describe('services/catalogo · presentación al cliente (minuta 17, 18, 28)', () => {
  const vylkor = {
    producto_id: 'a1', nombre: 'VYLKOR - ONDANSETRON TAB 8 mg C/10',
    nombre_comercial: 'VYLKOR', nombre_generico: 'ONDANSETRON',
    concentracion: '8 mg', forma_farmaceutica: 'TAB', presentacion: 'C/10',
    laboratorio: 'ZURICH', controlado: false, tasa_iva: 0,
    disponibilidad: [
      { sucursal: 'GDL', nombre: 'ALFA-DEO Guadalajara', ciudad: 'Guadalajara', existencia: 45 },
      { sucursal: 'MTY', nombre: 'ALFA-DEO Monterrey', ciudad: 'Monterrey', existencia: 12 },
    ],
  };
  const agotado = { ...vylkor, producto_id: 'a2', disponibilidad: [] };

  test('limpiarConsulta deja sólo el producto', () => {
    assert.equal(limpiarConsulta('buenas tardes, tienen ondansetron 8mg?'), 'ondansetron 8mg');
    assert.equal(limpiarConsulta('¿cuanto cuesta el acido zoledronico?'), 'el acido zoledronico');
  });

  test('nombreProducto arma los 4 campos', () => {
    assert.equal(nombreProducto(vylkor), 'VYLKOR (ONDANSETRON) 8 mg · TAB · C/10');
  });

  test('la ficha muestra comercial, genérico, miligramos y presentación', () => {
    const f = fichaProducto(vylkor);
    assert.match(f, /Comercial:\* VYLKOR/);
    assert.match(f, /Genérico:\* ONDANSETRON/);
    assert.match(f, /Miligramos:\* 8 mg/);
    assert.match(f, /Presentación:\* C\/10/);
  });

  test('disponibilidad por plaza SIN revelar piezas (minuta 28)', () => {
    const t = disponibilidadTexto(vylkor);
    assert.equal(t, 'Guadalajara y Monterrey');
    assert.doesNotMatch(t, /45|12/, 'no debe filtrar cantidades');
    assert.equal(disponibilidadTexto(agotado), null);
  });

  test('hayExistencia y sucursalesConStock', () => {
    assert.equal(hayExistencia(vylkor), true);
    assert.equal(hayExistencia(agotado), false);
    assert.deepEqual(sucursalesConStock(vylkor), ['GDL', 'MTY']);
    assert.deepEqual(sucursalesConStock(agotado), []);
  });

  test('los lotes del mismo producto se fusionan en una sola opción (minuta 23)', () => {
    // En el catálogo cada lote es una fila distinta de `productos`. Mostrarle
    // "XANIBA C/120" tres veces al cliente parece un error del sistema.
    const lote = (id, l, existencia, caducidad) => ({
      producto_id: id, lote: l, caducidad,
      nombre_comercial: 'XANIBA', nombre_generico: 'CAPECITABINA',
      concentracion: '500 mg', forma_farmaceutica: 'TAB', presentacion: 'C/120',
      laboratorio: 'HETERO', score: 0.9,
      disponibilidad: [{ sucursal: 'GDL', ciudad: 'Guadalajara', existencia }],
    })

    const agrupado = agruparLotes([
      lote('p1', 'L001', 10, '2028-05-01'),
      lote('p2', 'L002', 5, '2027-01-01'),
    ]);

    assert.equal(agrupado.length, 1, 'debe quedar una sola opción');
    assert.deepEqual(agrupado[0].lotes, ['L001', 'L002']);
    assert.equal(agrupado[0].disponibilidad[0].existencia, 15, 'se suman las existencias');
    assert.equal(agrupado[0].caducidad, '2027-01-01', 'se conserva la caducidad más próxima');
  });

  test('distinta presentación NO se fusiona (minuta 18)', () => {
    const base = {
      nombre_comercial: 'ZUREBID', nombre_generico: 'ACIDO MICOFENOLICO',
      concentracion: '500 mg', forma_farmaceutica: 'TAB',
      laboratorio: 'ZURICH', score: 0.9, disponibilidad: [],
    };
    const agrupado = agruparLotes([
      { ...base, producto_id: 'a', presentacion: 'C/50' },
      { ...base, producto_id: 'b', presentacion: 'C/12' },
    ]);
    assert.equal(agrupado.length, 2, 'misma dosis con distinta presentación son productos distintos');
  });

  test('la fusión suma por plaza, no las revuelve', () => {
    const base = {
      nombre_comercial: 'X', nombre_generico: 'Y', concentracion: '1 mg',
      forma_farmaceutica: 'TAB', presentacion: 'C/1', laboratorio: 'L', score: 0.9,
    };
    const agrupado = agruparLotes([
      { ...base, producto_id: 'a', lote: 'A', disponibilidad: [{ sucursal: 'GDL', ciudad: 'Guadalajara', existencia: 3 }] },
      { ...base, producto_id: 'b', lote: 'B', disponibilidad: [{ sucursal: 'MTY', ciudad: 'Monterrey', existencia: 7 }] },
      { ...base, producto_id: 'c', lote: 'C', disponibilidad: [{ sucursal: 'GDL', ciudad: 'Guadalajara', existencia: 2 }] },
    ]);
    assert.equal(agrupado.length, 1);
    const porPlaza = Object.fromEntries(agrupado[0].disponibilidad.map((d) => [d.sucursal, d.existencia]));
    assert.deepEqual(porPlaza, { GDL: 5, MTY: 7 });
    assert.deepEqual(sucursalesConStock(agrupado[0]).sort(), ['GDL', 'MTY']);
  });

  test('un producto sin marca no repite el genérico', () => {
    const generico = {
      nombre_comercial: null, nombre_generico: 'VALSARTAN',
      concentracion: '80 mg', forma_farmaceutica: 'TAB', presentacion: 'C/30',
      disponibilidad: [],
    };
    assert.equal(nombreProducto(generico), 'VALSARTAN 80 mg · TAB · C/30');
  });
});

// ---------------------------------------------------------------------------
describe('services/facturacion (minuta 1 y 3)', () => {
  test('lee una constancia pegada de un jalón', () => {
    const d = extraerDatosFiscales(
      'Razón social: HOSPITAL SAN JAVIER SA DE CV\nRFC: HSJ980315AB2\nCP 45116\nfacturas@sanjavier.com\nUso G01'
    );
    assert.equal(d.rfc, 'HSJ980315AB2');
    assert.equal(d.cp, '45116');
    assert.equal(d.correo, 'facturas@sanjavier.com');
    assert.equal(d.uso_cfdi, 'G01');
    assert.match(d.razon_social, /HOSPITAL SAN JAVIER/);
  });

  test('el CP no se confunde con los dígitos del RFC', () => {
    const d = extraerDatosFiscales('RFC AFD120315AB9 y mi cp es 64000');
    assert.equal(d.rfc, 'AFD120315AB9');
    assert.equal(d.cp, '64000');
  });

  test('valida cada campo', () => {
    assert.equal(validarDatoFiscal('rfc', 'AFD120315AB9').ok, true);
    assert.equal(validarDatoFiscal('rfc', 'no me acuerdo').ok, false);
    assert.equal(validarDatoFiscal('cp', '45050').valor, '45050');
    assert.equal(validarDatoFiscal('cp', 'abc').ok, false);
    assert.equal(validarDatoFiscal('correo', 'a@b.com').valor, 'a@b.com');
    assert.equal(validarDatoFiscal('correo', 'arroba').ok, false);
  });

  test('pide los datos en orden y se detiene al completarlos', () => {
    assert.equal(siguienteDatoFiscal({}).campo, 'razon_social');
    assert.equal(siguienteDatoFiscal({ razon_social: 'X' }).campo, 'rfc');
    const completo = { razon_social: 'X', rfc: 'AFD120315AB9', cp: '45050', correo: 'a@b.com' };
    assert.equal(siguienteDatoFiscal(completo), null);
    assert.equal(datosFiscalesCompletos(completo), true);
  });

  test('aviso de IVA: medicamentos son tasa 0% (minuta 3)', () => {
    assert.match(avisoIVA([{ tasa_iva: 0 }, { tasa_iva: 0 }]), /tasa 0%/);
    assert.match(avisoIVA([{ tasa_iva: 0 }, { tasa_iva: 0.16 }]), /algún producto/);
    assert.match(avisoIVA([{ tasa_iva: 0.16 }]), /sí causan IVA/);
  });
});

// ---------------------------------------------------------------------------
describe('services/ruteo · a qué asesor va (minuta 15)', () => {
  test('reconoce la plaza por el texto', () => {
    assert.equal(plazaPorTexto('Monterrey, Nuevo León'), 'MTY');
    assert.equal(plazaPorTexto('zapopan jalisco'), 'GDL');
    assert.equal(plazaPorTexto('Mérida'), null);
  });

  test('si sólo una plaza tiene existencia, esa atiende', () => {
    const r = resolverSucursal({ sucursalesConStock: ['MTY'], ciudadEntrega: 'Guadalajara' });
    assert.equal(r.clave, 'MTY');
  });

  test('con existencia en ambas gana la ciudad del cliente', () => {
    const r = resolverSucursal({ sucursalesConStock: ['GDL', 'MTY'], ciudadEntrega: 'San Pedro, NL' });
    assert.equal(r.clave, 'MTY');
  });

  test('sin existencia manda la ciudad de entrega', () => {
    const r = resolverSucursal({ sucursalesConStock: [], ciudadEntrega: 'Monterrey' });
    assert.equal(r.clave, 'MTY');
  });

  test('sin pistas cae en la sucursal por defecto', () => {
    const r = resolverSucursal({ sucursalesConStock: [], ciudadEntrega: 'Mérida' });
    assert.equal(r.clave, 'GDL');
  });
});

// ===========================================================================
// El upsert de cliente es la única consulta del bot que arma su lista de
// columnas en tiempo de ejecución. Se prueba aparte porque un descuido ahí
// genera SQL inválido, y eso sólo se vería en producción.
// ===========================================================================
describe('services/solicitudes · SQL del upsert de cliente', () => {
  test('sólo escribe las columnas que traen valor', () => {
    const { texto, valores } = construirUpsertCliente({
      telefono_wa: '5213312345678',
      nombre: 'Diego',
      empresa: null,        // null: no debe aparecer
      ciudad: '',           // vacío: tampoco
      rfc: undefined,       // ausente: tampoco
    });

    assert.match(texto, /insert into clientes \(telefono_wa, nombre\)/);
    assert.doesNotMatch(texto, /empresa/);
    assert.doesNotMatch(texto, /ciudad/);
    assert.doesNotMatch(texto, /rfc/);
    assert.deepEqual(valores, ['5213312345678', 'Diego']);
  });

  test('los marcadores van en orden y casan con los valores', () => {
    const { texto, valores } = construirUpsertCliente({
      telefono_wa: '521331', nombre: 'Ana', empresa: 'Hospital', ciudad: 'GDL',
    });

    assert.match(texto, /values \(\$1, \$2, \$3, \$4\)/);
    assert.equal(valores.length, 4);
    // Tantos marcadores como valores: si esto se desalinea, Postgres rechaza.
    const marcadores = texto.match(/\$\d+/g) ?? [];
    assert.equal(new Set(marcadores).size, valores.length);
  });

  test('el DO UPDATE no se pisa el teléfono a sí mismo', () => {
    const { texto } = construirUpsertCliente({ telefono_wa: '521331', nombre: 'Ana' });
    assert.match(texto, /do update set nombre = excluded\.nombre/);
  });

  test('con sólo el teléfono sigue siendo SQL válido', () => {
    // Sin asignaciones, un "do update set" a secas no compila.
    const { texto, valores } = construirUpsertCliente({ telefono_wa: '521331' });
    assert.match(texto, /do update set telefono_wa = excluded\.telefono_wa/);
    assert.deepEqual(valores, ['521331']);
  });

  test('requiere_factura en false se guarda, no se confunde con vacío', () => {
    // Si el filtro usara "falsy" en vez de comparar contra null y '', un "no
    // requiero factura" se perdería y volveríamos a preguntarlo cada vez.
    const { texto, valores } = construirUpsertCliente({
      telefono_wa: '521331', requiere_factura: false,
    });
    assert.match(texto, /requiere_factura/);
    assert.deepEqual(valores, ['521331', false]);
  });

  test('ignora columnas que no están en la lista blanca', () => {
    // Los nombres de columna se interpolan en el SQL, así que sólo pueden
    // salir de COLUMNAS_CLIENTE y nunca de datos de entrada.
    const { texto } = construirUpsertCliente({
      telefono_wa: '521331',
      '; drop table clientes; --': 'x',
      columna_inventada: 'y',
    });
    assert.doesNotMatch(texto, /drop table/i);
    assert.doesNotMatch(texto, /columna_inventada/);
  });
});
