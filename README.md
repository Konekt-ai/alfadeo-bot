# ALFA-DEO — Bot de WhatsApp (webhook)

Webhook de bot de WhatsApp para **ALFA-DEO**, distribuidora farmacéutica B2B.
Recibe solicitudes de abastecimiento por WhatsApp, las califica, las guarda en
**Supabase (PostgreSQL)** y notifica al equipo interno.

> **Regla de oro:** el bot **nunca** promete precio, existencia ni tiempo de
> entrega. Todo queda **"sujeto a confirmación"** de un asesor.

## Stack

- Node.js 20 (ES Modules)
- Express
- `@supabase/supabase-js` (Service Role)
- `fetch` nativo contra la **WhatsApp Cloud API oficial de Meta** (Graph API v21)
- `dotenv` (sólo para entorno local)

No se usan librerías no oficiales (Baileys, whatsapp-web.js, etc.).

## Estructura

```
alfadeo-bot/
├─ src/
│  ├─ server.js                 # Express, monta rutas, escucha PORT
│  ├─ config/env.js             # lee y valida variables de entorno
│  ├─ lib/supabase.js           # cliente Supabase + registrarMensaje()
│  ├─ lib/whatsapp.js           # sendText(), verifyWebhook(), parseInbound()
│  ├─ flows/abastecimiento.js   # máquina de estados de la solicitud
│  ├─ flows/faq.js              # respuestas de información (texto fijo)
│  ├─ services/solicitudes.js   # upsert cliente, crear solicitud + items
│  ├─ services/escalamiento.js  # reglas de escalamiento + notificarEquipo()
│  └─ utils/logger.js
├─ supabase/schema.sql          # esquema de REFERENCIA (no se ejecuta)
├─ .env.example
├─ package.json
├─ railway.json                 # config de despliegue (también hay Procfile)
└─ README.md
```

## Instalar y correr en local

1. Clona el repo y entra a la carpeta.
2. Copia el archivo de variables y complétalo:
   ```bash
   cp .env.example .env
   ```
3. Instala dependencias y arranca:
   ```bash
   npm install
   npm start
   ```
4. Verifica que responde:
   ```bash
   curl http://localhost:3000/health
   # -> {"ok":true}
   ```

> En Windows PowerShell usa `Copy-Item .env.example .env` y
> `Invoke-RestMethod http://localhost:3000/health`.

### Probar la verificación del webhook (local)

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=12345"
# -> 12345
```

### Probar un mensaje entrante simulado (local)

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "value": {
          "contacts": [{ "wa_id": "5213312345678", "profile": { "name": "Prueba" } }],
          "messages": [{ "from": "5213312345678", "id": "wamid.TEST", "type": "text", "text": { "body": "1" } }]
        }
      }]
    }]
  }'
```

El servidor responde `200` de inmediato y procesa el mensaje en segundo plano
(intentará enviar la respuesta por WhatsApp y registrar en `mensajes`).

## Variables de entorno

| Variable                    | Descripción                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `WHATSAPP_TOKEN`            | Token de acceso de la app de Meta (preferible token permanente de System User). |
| `WHATSAPP_PHONE_NUMBER_ID`  | **Phone Number ID** del número (no el número visible). Lo da Meta.           |
| `WHATSAPP_VERIFY_TOKEN`     | Cadena que tú inventas; debe coincidir con la que registras en Meta.        |
| `SUPABASE_URL`              | URL del proyecto Supabase.                                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service Role Key** (no la anon key). Sólo en el servidor.                  |
| `INTERNAL_NOTIFY_NUMBERS`   | Números del equipo separados por coma, formato `5213312345678`.             |
| `ESCALA_CANTIDAD_UMBRAL`    | Cantidad a partir de la cual se escala a humano (default `500`).            |
| `PORT`                      | Puerto local (Railway lo inyecta automáticamente; default `3000`).          |
| `GRAPH_API_VERSION`         | (Opcional) versión de Graph API. Default `v21.0`.                            |

## Desplegar en Railway

1. Sube este repo a GitHub.
2. En [Railway](https://railway.app): **New Project → Deploy from GitHub repo** y
   selecciona el repositorio.
3. Railway detecta Node automáticamente y usa el `startCommand` de `railway.json`
   (`node src/server.js`).
4. En la pestaña **Variables**, agrega todas las del cuadro de arriba
   (excepto `PORT`, que Railway inyecta solo).
5. Genera un dominio público en **Settings → Networking → Generate Domain**.
   Obtendrás algo como `https://<tu-app>.up.railway.app`.
6. Verifica salud: `https://<tu-app>.up.railway.app/health`.

## Registrar el webhook en Meta

1. En [Meta for Developers](https://developers.facebook.com) abre tu app de
   **WhatsApp**.
2. Ve a **WhatsApp → Configuración → Webhook** (Configuration).
3. **Callback URL:** `https://<tu-app>.up.railway.app/webhook`
4. **Verify token:** el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
5. Pulsa **Verify and save**. Meta hará un `GET /webhook`; si el token coincide,
   el servidor devuelve el `hub.challenge` y queda verificado.
6. En **Webhook fields**, suscríbete al campo **`messages`**.
7. Asegúrate de que tu número de prueba o producción esté agregado y de que el
   `WHATSAPP_TOKEN` tenga permisos `whatsapp_business_messaging`.

## Comportamiento del bot

Flujo (máquina de estados en `conversaciones`):

```
inicio → menu → cap_nombre → cap_empresa → cap_tipo → cap_ciudad →
cap_producto → cap_cantidad → cap_urgencia → cap_contacto → confirmar → fin
```

- **Menú**: 1) Solicitar abastecimiento · 2) Información · 3) Hablar con una persona.
- Al **confirmar** una solicitud: `upsert` en `clientes` (por `telefono_wa`),
  alta en `solicitudes` (`canal='whatsapp'`, `estado='nueva'`) y filas en
  `solicitud_items`. Se responde con el **folio** y la leyenda *sujeto a confirmación*.
- **Escala a humano** (`requiere_humano=true` + notifica al equipo) si:
  urgencia `urgente`; tipo `gobierno`/`hospital`; cantidad ≥ `ESCALA_CANTIDAD_UMBRAL`;
  producto `controlado`; datos incompletos; o el usuario pide precio exacto,
  menciona licitación o se queja.
- **Ventana de 24h**: dentro de la ventana se responde con texto libre. Para
  reabrir fuera de las 24h se requieren **plantillas aprobadas**
  (`// TODO: plantillas`, no implementado aún).
- Cada mensaje entrante y saliente se registra en `mensajes`.

## Notas

- La base de datos **ya existe** en Supabase; el bot sólo la consume. El archivo
  `supabase/schema.sql` es referencia y no se ejecuta.
- Pendientes marcados como `// TODO: plantillas` / `// TODO: plantilla de
  notificación` para mensajería fuera de la ventana de 24h.
