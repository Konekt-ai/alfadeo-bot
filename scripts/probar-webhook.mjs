// Comprueba la URL PÚBLICA del bot: exactamente lo que Meta va a hacer.
//
//     npm run probar-webhook                       (lee hosting/url-publica.txt)
//     npm run probar-webhook https://bot.midominio.com
//
// Sirve para saber si el túnel y el webhook están bien ANTES de ir al panel de
// Meta a registrar la URL. Si algo falla aquí, en Meta va a fallar igual, pero
// allá el mensaje de error no dice nada útil.
//
// No manda nada a WhatsApp ni escribe en la base: el POST de prueba lleva un
// evento sin mensajes, que el bot descarta.
import 'dotenv/config';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const ok = (m) => console.log(`  \x1b[32m[OK]\x1b[0m    ${m}`);
const mal = (m) => { fallas++; console.log(`  \x1b[31m[FALLA]\x1b[0m ${m}`); };
const nota = (m) => console.log(`  \x1b[33m[ ]\x1b[0m     ${m}`);

let fallas = 0;

// --- ¿contra qué URL? -------------------------------------------------------
let base = process.argv[2];
if (!base && existsSync('hosting/url-publica.txt')) {
  base = readFileSync('hosting/url-publica.txt', 'utf8').trim();
}
if (!base) {
  console.error('\nFalta la URL pública.\n');
  console.error('  npm run probar-webhook https://bot.tudominio.com\n');
  console.error('O guárdala para no repetirla:');
  console.error("  'https://bot.tudominio.com' | Out-File hosting\\url-publica.txt -Encoding utf8\n");
  process.exit(1);
}
base = base.replace(/\/+$/, '');

const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
const SECRETO = process.env.META_APP_SECRET ?? '';

console.log(`\nComprobando ${base}\n`);

if (!base.startsWith('https://')) {
  mal('La URL no es https. Meta EXIGE https con certificado válido.');
}

async function pedir(ruta, opciones = {}) {
  const control = new AbortController();
  const t = setTimeout(() => control.abort(), 15000);
  try {
    return await fetch(base + ruta, { ...opciones, signal: control.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- 1. ¿Llega desde fuera? -------------------------------------------------
try {
  const r = await pedir('/health');
  const cuerpo = await r.json();
  if (r.ok && cuerpo.ok === true) ok('El túnel llega al bot (/health responde)');
  else mal(`/health contestó ${r.status}: ${JSON.stringify(cuerpo)}`);
} catch (e) {
  mal(`No se alcanza ${base} — ${e.message}`);
  console.log('\n        Revisa: Get-Service cloudflared, y que el DNS del subdominio apunte al túnel.\n');
  process.exit(1);
}

// --- 2. El handshake que hace Meta al guardar la URL ------------------------
// Esto es LITERALMENTE lo que Meta manda al darle "Verify and save".
if (!VERIFY) {
  mal('WHATSAPP_VERIFY_TOKEN está vacío en el .env: Meta no podrá verificar el webhook.');
} else {
  const reto = 'prueba' + Math.floor(Math.random() * 100000);
  const q = `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=${reto}`;
  try {
    const r = await pedir(q);
    const texto = (await r.text()).trim();
    if (r.status === 200 && texto === reto) ok('Meta podrá verificar el webhook (devuelve el challenge)');
    else mal(`El handshake contestó ${r.status} con "${texto}" (se esperaba "${reto}")`);
  } catch (e) {
    mal(`Handshake falló: ${e.message}`);
  }

  // Con token equivocado tiene que rechazar, o cualquiera podría registrarlo.
  try {
    const r = await pedir('/webhook?hub.mode=subscribe&hub.verify_token=token-malo&hub.challenge=x');
    if (r.status === 403) ok('Rechaza el handshake con token equivocado (403)');
    else mal(`Con token equivocado contestó ${r.status}; debería ser 403`);
  } catch (e) {
    mal(`No pude probar el token equivocado: ${e.message}`);
  }
}

// --- 3. La firma de los webhooks -------------------------------------------
// Evento sin mensajes: el bot lo descarta, no escribe nada en la base.
const CUERPO = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

if (!SECRETO) {
  nota('META_APP_SECRET vacío: NO se valida la firma.');
  nota('Cualquiera que descubra esta URL puede inventar mensajes. Ponlo antes de');
  nota('registrarla en Meta. Está en: tu app → Configuración → Básica.');
  try {
    const r = await pedir('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: CUERPO,
    });
    if (r.status === 200) {
      ok('Acepta los eventos (200), aunque sin comprobar quién los manda');
    } else if (r.status === 403) {
      // El servidor SÍ valida y este comprobador no trae el secreto para
      // firmar. Pasa cuando se corre desde otra máquina, con otro .env: no es
      // un fallo del bot, es que aquí falta el dato.
      ok('El bot sí valida la firma (contestó 403 a un POST sin firmar)');
      nota('Este comprobador no tiene META_APP_SECRET, así que no pudo firmar.');
      nota('Para la prueba completa, córrelo en la misma máquina que el bot.');
    } else {
      mal(`El POST contestó ${r.status}; se esperaba 200 o 403`);
    }
  } catch (e) {
    mal(`El POST falló: ${e.message}`);
  }
} else {
  const firma = 'sha256=' + crypto.createHmac('sha256', SECRETO).update(CUERPO).digest('hex');

  try {
    const r = await pedir('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
      body: CUERPO,
    });
    if (r.status === 200) ok('Acepta los eventos firmados por Meta (200)');
    else mal(`Con firma buena contestó ${r.status}; se esperaba 200. ¿El META_APP_SECRET es el de esta app?`);
  } catch (e) {
    mal(`El POST firmado falló: ${e.message}`);
  }

  try {
    const r = await pedir('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: CUERPO,
    });
    if (r.status === 403) ok('Rechaza los eventos sin firma (403)');
    else mal(`Sin firma contestó ${r.status}; debería ser 403`);
  } catch (e) {
    mal(`No pude probar el POST sin firma: ${e.message}`);
  }
}

console.log(
  fallas === 0
    ? `\n\x1b[32mListo: Meta ya puede registrar ${base}/webhook y entregarte mensajes.\x1b[0m\n`
    : `\n\x1b[31m${fallas} problema(s).\x1b[0m Arréglalos antes de registrar la URL en Meta.\n`
);
process.exit(fallas === 0 ? 0 : 1);
