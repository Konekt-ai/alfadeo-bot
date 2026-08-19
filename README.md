# ALFA-DEO — Bot de WhatsApp (webhook)

Webhook de bot de WhatsApp para **ALFA-DEO**, distribuidora farmacéutica B2B.
Atiende consultas de producto, consulta el inventario real, registra solicitudes
en la base local y las rutea al asesor de la plaza que corresponde.

> **Qué contesta el bot solo y qué no**
>
> | Pregunta | Respuesta |
> | --- | --- |
> | ¿Tienen el medicamento? | **Sí**, consulta inventario real y dice en qué plaza hay (sin revelar piezas) |
> | ¿Cuánto cuesta? | **No**, siempre lo confirma un asesor |
> | ¿Cuándo lo entregan? | **Sí**, calcula la fecha con el calendario de paquetería |
> | ¿Requiere factura? | **Sí**, la pregunta al final y captura los datos fiscales |
>
> Estos interruptores se controlan con `BOT_DA_EXISTENCIA`, `BOT_DA_CANTIDADES`
> y `BOT_DA_PRECIOS`.

## Stack

- Node.js 20 (ES Modules)
- Express
- `pg` contra PostgreSQL 17 **en la misma computadora** (`localhost:5433`)
- `fetch` nativo contra la **WhatsApp Cloud API oficial de Meta** (Graph API v21)
- `dotenv` (sólo para entorno local)

No se usan librerías no oficiales (Baileys, whatsapp-web.js, etc.).

## ⚠️ Requisito previo: la base

La base **ya no vive en la nube**. Es un PostgreSQL 17 en la computadora del
mostrador, que escucha **sólo en `localhost`** y no está expuesto a internet.
El bot y el panel comparten esa base y la misma función `buscar_productos`, que
es donde vive el ranking para que los dos ordenen igual.

Las migraciones (catálogo desglosado, `sucursales`, existencia por plaza,
campos de facturación) las corre el repo del **panel**, no éste.

El bot necesita su propio usuario de base, con permisos mínimos:

```bash
psql -U postgres -p 5433 -d alfadeo -f sql/rol-bot.sql
```

Ese rol alcanza seis tablas y una función; no puede borrar nada ni ver ventas
ni inventario. **No uses el usuario `alfadeo` del panel para el bot.**

Comprueba que todo esté en su sitio:

```bash
npm run probar-base
```

Y que el catálogo esté bien cargado:

```bash
npm run verificar-catalogo
```

## Estructura

```text
alfadeo-bot/
├─ src/
│  ├─ server.js                  # Express, monta rutas, escucha PORT
│  ├─ config/env.js              # lee y valida variables de entorno
│  ├─ lib/db.js                  # pool de PostgreSQL + registrarMensaje()
│  ├─ lib/whatsapp.js            # sendText(), sendButtons(), parseInbound()
│  ├─ lib/fechas.js              # calendario hábil y fecha de entrega
│  ├─ flows/abastecimiento.js    # máquina de estados de la conversación
│  ├─ flows/intenciones.js       # entiende texto libre ("tienes ondansetron?")
│  ├─ flows/faq.js               # todos los textos del bot
│  ├─ services/catalogo.js       # búsqueda de productos y disponibilidad
│  ├─ services/entrega.js        # mensajes de tiempo de entrega
│  ├─ services/facturacion.js    # captura y validación de datos fiscales
│  ├─ services/ruteo.js          # a qué asesor va cada solicitud
│  ├─ services/solicitudes.js    # upsert cliente, crear solicitud + items
│  ├─ services/escalamiento.js   # reglas de "esto lo atiende una persona"
│  └─ utils/{logger,texto}.js
├─ pruebas/logica.test.mjs       # suite de pruebas (npm test)
├─ scripts/
│  ├─ probar-base.mjs            # ¿alcanza la base y tiene permisos?
│  ├─ verificar-catalogo.mjs     # revisa el catálogo contra la BD
│  └─ simular-conversacion.mjs   # conversación completa sin mandar WhatsApps
├─ hosting/                      # para correrlo en la PC de la empresa
│  ├─ README.md                  # guía de instalación paso a paso
│  ├─ instalar.ps1               # arranque automático + servicio
│  ├─ instalar-comandos.ps1      # deja bot-estado, bot-actualizar... en el PATH
│  ├─ supervisor.ps1             # mantiene el bot vivo y rota logs
│  ├─ comun.ps1                  # funciones compartidas (dot-source)
│  ├─ actualizar.ps1             # bot-actualizar: traer, probar y reiniciar
│  ├─ estado.ps1                 # bot-estado: diagnóstico
│  ├─ reiniciar.ps1              # bot-reiniciar
│  ├─ log.ps1                    # bot-log
│  ├─ desinstalar.ps1
│  └─ config-cloudflared.yml     # plantilla del túnel
├─ web/boton-whatsapp.html       # botón flotante para la página web
├─ sql/rol-bot.sql               # usuario de base del bot, permisos mínimos
├─ sql/esquema-referencia.sql    # esquema de REFERENCIA (no se ejecuta)
├─ .env.example
└─ railway.json                  # despliegue (también hay Procfile)
```

## Instalar y correr en local

```bash
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm install
npm test                  # 44 pruebas, no tocan la BD ni la API de Meta
npm start
curl http://localhost:3000/health   # -> {"ok":true}
```

### Probar la verificación del webhook

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=12345"
# -> 12345
```

### Simular un mensaje entrante

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "value": {
          "contacts": [{ "wa_id": "5213312345678", "profile": { "name": "Prueba" } }],
          "messages": [{ "from": "5213312345678", "id": "wamid.TEST", "type": "text",
                         "text": { "body": "buenas tardes, tienen ondansetron 8mg?" } }]
        }
      }]
    }]
  }'
```

Responde `200` de inmediato y procesa en segundo plano.

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `WHATSAPP_TOKEN` | Token de la app de Meta (preferible permanente de System User). |
| `WHATSAPP_PHONE_NUMBER_ID` | **Phone Number ID** del número (no el número visible). |
| `WHATSAPP_VERIFY_TOKEN` | Cadena que tú inventas; debe coincidir con la de Meta. |
| `DATABASE_URL` | `postgresql://bot:CONTRASENA@localhost:5433/alfadeo`. Usa el rol de `sql/rol-bot.sql`. |
| `META_APP_SECRET` | Secreto de la app de Meta. Sin él **no se valida la firma** de los webhooks. |
| `INTERNAL_NOTIFY_NUMBERS` | Respaldo: reciben todas las solicitudes. Separados por coma. |
| `RUTEO_ASESORES` | Asesor por plaza: `GDL:5213312345678,MTY:5218112345678`. |
| `SUCURSAL_DEFAULT` | Plaza cuando no hay pistas. Default `GDL`. |
| `BOT_DA_EXISTENCIA` | Si el bot dice sí/no de existencia. Default `true`. |
| `BOT_DA_CANTIDADES` | Si revela piezas exactas. Default `false` **(déjalo apagado)**. |
| `BOT_DA_PRECIOS` | Si da precio automático. Default `false` **(déjalo apagado)**. |
| `PAQUETERIA` | Nombre de la paquetería en los mensajes. Default `DHL`. |
| `ENTREGA_HORA_CORTE` | Hora (0-23) tras la cual el pedido sale al día siguiente. Default `15`. |
| `ENTREGA_DIAS_PROVEEDOR` | Días hábiles extra si hay que pedirlo a proveedor. Default `2`. |
| `ZONA_HORARIA` | Default `America/Mexico_City`. |
| `ESCALA_CANTIDAD_UMBRAL` | Piezas a partir de las cuales lo atiende una persona. Default `500`. |
| `PORT` | Puerto local del webhook. El panel ocupa el 3002. Default `3000`. |
| `GRAPH_API_VERSION` | Versión de Graph API. Default `v21.0`. |

## Cómo conversa el bot

El menú es **opcional**: el cliente puede escribir directo `"buenas tardes,
tienen ondansetron 8mg?"` y el bot lo entiende. El flujo sigue el orden real de
compra que se documentó en la reunión:

```text
1. producto  ->  ¿tienen existencia?   consulta inventario, dice la plaza
2. cantidad  ->  ¿cuánto cuesta?       "lo confirma un asesor"
                 ¿cuándo entregan?     fecha calculada con el calendario
3. datos     ->  nombre, empresa, ciudad (sólo si es cliente nuevo)
4. factura   ->  ¿requiere factura? -> razón social, RFC, CP, correo
5. confirmar ->  folio + fecha estimada + aviso al asesor de la plaza
```

Detalles que importan:

- **Preguntas frecuentes en cualquier momento.** Si a mitad de la captura
  preguntan "¿y cuándo llega?", el bot responde y retoma donde iba.
- **Clientes nuevos** reciben los tiempos de entrega en el primer mensaje, sin
  pedirlos.
- **Clientes conocidos** no vuelven a dar sus datos ni sus datos fiscales.
- **Varias coincidencias** (mismo genérico, distinta marca o presentación) se
  listan numeradas con ✅ en existencia / ⏳ se pide a proveedor.
- **Ventana de 24 h**: dentro de la ventana se responde con texto libre. Fuera se
  requieren **plantillas aprobadas** (pendiente).

### Reglas de tiempo de entrega

- Confirmado antes de `ENTREGA_HORA_CORTE` → sale el mismo día.
- Entrega normalmente al día siguiente hábil.
- **Si sale viernes, llega el martes** (la paquetería no entrega en fin de semana).
- Se saltan sábados, domingos y los festivos oficiales de la LFT.

### Cuándo lo atiende una persona

`requiere_humano = true` y aviso marcado al asesor si:

- Pedido urgente, o cliente de tipo `gobierno` / `hospital`.
- Volumen ≥ `ESCALA_CANTIDAD_UMBRAL`.
- Producto marcado como `controlado`.
- Licitación, concurso, queja, devolución o producto en mal estado.
- El producto no se encontró en el catálogo tras dos intentos.
- El cliente pide hablar con alguien.

### Ruteo al asesor

1. Si sólo una plaza tiene existencia, esa atiende.
2. Si hay en varias, gana la plaza de la ciudad del cliente.
3. Sin existencia propia, manda la ciudad de entrega.
4. Sin pistas, cae en `SUCURSAL_DEFAULT`.

Los números de `INTERNAL_NOTIFY_NUMBERS` reciben **todo** como respaldo.

## Botón de WhatsApp para la página web

`web/boton-whatsapp.html` es un bloque autocontenido (HTML + CSS + JS, sin
dependencias). Cambia los números en `data-numero` y pégalo antes de `</body>`.
Si configuras dos plazas, muestra un selector antes de abrir el chat.

## Pruebas

```bash
npm test                   # lógica pura: fechas, intenciones, fiscal, ruteo
npm run verificar-catalogo # revisa la migración contra la BD real
npm run simular            # conversación completa, sin mandar WhatsApps
```

### El simulador

`npm run simular <escenario>` corre una conversación entera contra la base real
y te imprime el diálogo tal cual lo vería el cliente. **No manda ni un mensaje a
WhatsApp**: intercepta las llamadas a la Graph API, vacía los números de aviso y
borra al final todo lo que escribió (conversación, mensajes, cliente y
solicitud). Lo único que no revierte es el consumo de un folio, porque la
secuencia de identidad no retrocede.

| Escenario | Qué prueba |
| --- | --- |
| `completo` | Camino feliz: producto → cantidad → datos → factura → folio |
| `desvios` | El cliente pregunta precio y entrega a mitad de la captura |
| `nohay` | Producto que no existe: dos intentos y pasa a una persona |
| `fiscalPegado` | El cliente pega toda su constancia fiscal en un mensaje |
| `licitacion` | Nunca lo contesta el bot |

Úsalo antes de publicar cualquier cambio de textos o de flujo.

## Desplegar

### En la computadora de la empresa (Windows)

Guía completa paso a paso: **[hosting/README.md](hosting/README.md)**

Resumen: `hosting\instalar.ps1` deja el bot arrancando solo al encender la PC y
reviviéndose si se cae; Cloudflare Tunnel le da URL pública con HTTPS sin abrir
ningún puerto del router. `hosting\estado.ps1` diagnostica todo de un vistazo.

### Publicar cambios

Programas aquí, pruebas en local, `git push`. Y en la PC de la empresa:

```text
ssh alfadeo-bot
bot-estado        # ¿está arriba? ¿en qué commit? ¿hay algo nuevo?
bot-actualizar    # traer, probar y reiniciar
```

También sirven de un tiro, sin entrar:

```powershell
ssh alfadeo-bot bot-actualizar
```

`bot-actualizar` trae los cambios, reinstala sólo si cambió el lockfile, corre
las pruebas y reinicia. **Si las pruebas fallan no reinicia**, así el bot se
queda contestando con la versión anterior. Los otros comandos (`bot-reiniciar`,
`bot-log`) y cómo dejar el SSH sin contraseña, en
[hosting/README.md](hosting/README.md#operación-diaria).

### En Railway (ya no es un respaldo listo)

`railway.json` y el `Procfile` siguen aquí, pero **ya no bastan para revivir el
bot**. Antes la base estaba en la nube y Railway la alcanzaba desde cualquier
lado; ahora `DATABASE_URL` apunta a `localhost:5433`, que desde Railway no
existe.

Para volver a tener un respaldo de verdad habría que resolver primero cómo
alcanza la base desde fuera — y eso es justo lo que el cliente decidió no hacer.
Se conservan los archivos por si algún día cambia esa decisión; hoy el respaldo
real es que la computadora del mostrador vuelva a encender.

1. Sube el repo a GitHub.
2. Railway: **New Project → Deploy from GitHub repo**.
3. Usa el `startCommand` de `railway.json` (`node src/server.js`).
4. En **Variables**, agrega todas las del cuadro (excepto `PORT`).
5. **Settings → Networking → Generate Domain**.
6. Verifica: `https://<tu-app>.up.railway.app/health`.

## Registrar el webhook en Meta

1. [Meta for Developers](https://developers.facebook.com) → tu app de WhatsApp.
2. **WhatsApp → Configuración → Webhook**.
3. **Callback URL:** `https://<tu-app>.up.railway.app/webhook`
4. **Verify token:** el mismo de `WHATSAPP_VERIFY_TOKEN`.
5. **Verify and save**, y suscríbete al campo **`messages`**.
6. El `WHATSAPP_TOKEN` necesita permiso `whatsapp_business_messaging`.

## Pendientes conocidos

- **Plantillas fuera de la ventana de 24 h**: los avisos al asesor pueden fallar
  si no ha habido conversación reciente. Hoy se registran en `mensajes` como
  respaldo; falta dar de alta plantillas aprobadas en Meta.
- El bot no factura ni descuenta inventario todavía: registra la solicitud y la
  factura la emite el panel.
