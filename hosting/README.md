# Hostear el bot en la computadora de la empresa

Guía completa para dejar el bot corriendo 24/7 en una PC con Windows, con URL
pública y HTTPS válido, **sin abrir un solo puerto del router**.

Tiempo estimado: 40 minutos la primera vez.

---

## Cómo va a quedar

```text
   Cliente en WhatsApp
            │
            ▼
   Servidores de Meta
            │  HTTPS a https://bot.tudominio.com/webhook
            ▼
   Red de Cloudflare
            │  el túnel sale DESDE la PC, nadie entra
            ▼
   PC de la empresa
     ├─ cloudflared  (servicio de Windows)
     └─ node src/server.js  (tarea programada + supervisor)
            │
            ▼
        Supabase
```

Lo importante: **la conexión la abre la PC hacia afuera**. No hay puertos
abiertos, no hace falta IP fija, y si cambia la IP de la oficina no se rompe
nada. Por eso esta opción es más segura que reenviar puertos en el router.

---

## 1. Preparar la PC

### 1.1 Instalar Node.js

En PowerShell **como administrador**:

```powershell
winget install OpenJS.NodeJS.LTS
```

Cierra y vuelve a abrir PowerShell, y comprueba:

```powershell
node --version    # debe decir v20.x o superior
```

### 1.2 Copiar el proyecto

Ponlo en una ruta corta y sin espacios, por ejemplo `C:\alfadeo-bot`.

Si usas Git:

```powershell
cd C:\
git clone <URL-DEL-REPO> alfadeo-bot
```

Si lo copias a mano, **no copies** `node_modules` ni `logs`.

### 1.3 Crear el `.env`

El archivo `.env` **no viaja en Git** porque trae las llaves. Cópialo aparte
(USB o gestor de contraseñas, nunca por WhatsApp ni correo) y déjalo en
`C:\alfadeo-bot\.env`.

Si no lo tienes, arranca del ejemplo:

```powershell
cd C:\alfadeo-bot
Copy-Item .env.example .env
notepad .env
```

Rellena como mínimo:

| Variable | De dónde sale |
| --- | --- |
| `WHATSAPP_TOKEN` | Meta for Developers → tu app → WhatsApp → API Setup |
| `WHATSAPP_PHONE_NUMBER_ID` | Mismo lugar. Es el **ID**, no el número visible |
| `WHATSAPP_VERIFY_TOKEN` | Lo inventas tú; debe coincidir con el que pongas en Meta |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Igual. Es la **service role**, no la anon |
| `RUTEO_ASESORES` | `GDL:5213312345678,MTY:5218112345678` |
| `INTERNAL_NOTIFY_NUMBERS` | Números de respaldo que reciben todo |

---

## 2. Instalar el bot como servicio

PowerShell **como administrador**:

```powershell
cd C:\alfadeo-bot
.\hosting\instalar.ps1
```

El script verifica Node y el `.env`, instala dependencias, corre las pruebas,
evita que la PC se suspenda y registra una tarea que:

- arranca el bot **al encender la PC**, aunque nadie inicie sesión;
- lo **vuelve a levantar solo** si se cae, con espera creciente;
- guarda todo en `logs\bot.log` y rota el archivo cada 10 MB.

Al terminar deberías ver `El bot responde en http://localhost:3000/health`.

> **Por qué tarea programada y no un servicio clásico:** un servicio de Windows
> requiere descargar utilidades externas (NSSM y similares), que TI a veces
> bloquea. La tarea programada es nativa, hace lo mismo y no depende de nada
> que se pueda bajar de internet.

---

## 3. Túnel de Cloudflare

### 3.1 Si tu dominio todavía no está en Cloudflare

Cloudflare necesita administrar el **DNS** del dominio. Es gratis.

**Esto NO mueve tu hosting y NO rompe Vercel.** Cloudflare sólo resuelve
nombres; el panel se sigue sirviendo desde Vercel exactamente igual. Lo único
que pasa es que los registros DNS que hoy están en tu proveedor los copias a
Cloudflare.

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site**.
2. Escribe tu dominio y elige el plan **Free**.
3. Cloudflare importa tus registros actuales. **Revísalos uno por uno** antes
   de continuar: si falta el registro que apunta a Vercel, agrégalo a mano
   (Vercel te lo indica en Project → Settings → Domains).
4. Cambia los *nameservers* en tu registrador a los dos que te da Cloudflare.
5. Espera la propagación (de minutos a unas horas).

Si el DNS lo administra otra persona, pídele exactamente esto: *"cambiar los
nameservers del dominio a los de Cloudflare"*, y que te den acceso al panel.

### 3.2 Instalar cloudflared

```powershell
winget install --id Cloudflare.cloudflared
```

Cierra y reabre PowerShell.

### 3.3 Crear el túnel

```powershell
cloudflared tunnel login
```

Abre el navegador; elige tu dominio y autoriza. Luego:

```powershell
cloudflared tunnel create alfadeo-bot
```

Apunta las dos cosas que imprime:

- el **ID del túnel** (algo como `6f2a...-...`)
- la ruta del **archivo de credenciales** `.json`

### 3.4 Configurar

Copia la plantilla al perfil de tu usuario y edítala:

```powershell
Copy-Item C:\alfadeo-bot\hosting\config-cloudflared.yml "$env:USERPROFILE\.cloudflared\config.yml"
notepad "$env:USERPROFILE\.cloudflared\config.yml"
```

Cambia las tres cosas marcadas con `<<< >>>`: el ID del túnel, la ruta del
`.json` y tu subdominio (por ejemplo `bot.alfadeo.com`).

### 3.5 Apuntar el subdominio al túnel

```powershell
cloudflared tunnel route dns alfadeo-bot bot.tudominio.com
```

Esto crea solo el registro DNS en Cloudflare.

### 3.6 Instalar como servicio

PowerShell **como administrador**:

```powershell
cloudflared service install
Start-Service cloudflared
Get-Service cloudflared     # debe decir Running
```

### 3.7 Comprobar desde fuera

Desde el celular con **datos móviles** (no wifi de la oficina):

```text
https://bot.tudominio.com/health
```

Debe responder `{"ok":true}`. Si responde, Meta también puede llegar.

Guarda la URL para que el diagnóstico la revise sola:

```powershell
'https://bot.tudominio.com' | Out-File C:\alfadeo-bot\hosting\url-publica.txt -Encoding utf8
```

---

## 4. Apuntar Meta a la PC

1. [Meta for Developers](https://developers.facebook.com) → tu app →
   **WhatsApp → Configuración → Webhook** → *Edit*.
2. **Callback URL:** `https://bot.tudominio.com/webhook`
3. **Verify token:** el mismo valor de `WHATSAPP_VERIFY_TOKEN` en tu `.env`.
4. **Verify and save.** Si el token coincide, queda verificado al instante.
5. En **Webhook fields**, confirma que `messages` siga suscrito.

### Apaga Railway

Meta entrega a **una sola** URL, así que al guardar la nueva, Railway deja de
recibir. Aun así, apágalo para no pagar de más ni confundirte después viendo
logs de un servidor que ya no atiende a nadie.

---

## 5. Comprobación final

```powershell
cd C:\alfadeo-bot
.\hosting\estado.ps1
```

Debe salir todo en verde. Y la prueba de verdad: **mándale un WhatsApp al
número del negocio desde tu celular** y verifica que conteste.

Checklist antes de darlo por bueno:

- [ ] `estado.ps1` todo en verde
- [ ] `https://bot.tudominio.com/health` responde desde datos móviles
- [ ] Un mensaje real recibe respuesta
- [ ] **Reinicia la PC** y vuelve a mandar un mensaje: es la única forma de
      comprobar que el arranque automático de verdad funciona
- [ ] El asesor de la plaza recibe el aviso de la solicitud

---

## Operación diaria

```powershell
.\hosting\estado.ps1                              # diagnóstico completo
Get-Content .\logs\bot.log -Tail 50 -Wait         # log en vivo
Restart-ScheduledTask -TaskName 'ALFA-DEO Bot WhatsApp'   # reiniciar
```

### Actualizar el bot

```powershell
cd C:\alfadeo-bot
Stop-ScheduledTask -TaskName 'ALFA-DEO Bot WhatsApp'
git pull
npm ci --omit=dev
npm test
Start-ScheduledTask -TaskName 'ALFA-DEO Bot WhatsApp'
.\hosting\estado.ps1
```

### Cambiar textos del bot

Casi todo lo que dice está en `src/flows/faq.js`. Después de editar, prueba
**antes** de reiniciar:

```powershell
npm run simular
```

---

## Cuando algo falla

| Síntoma | Qué revisar |
| --- | --- |
| `health` local no responde | `Get-Content .\logs\bot.log -Tail 50`. Casi siempre es el `.env` |
| Local sí, público no | `Get-Service cloudflared`. Si está detenido: `Start-Service cloudflared` |
| Meta no verifica el webhook | El `WHATSAPP_VERIFY_TOKEN` del `.env` debe ser **idéntico** al de Meta |
| Llegan mensajes, no contesta | El `WHATSAPP_TOKEN` caducó. Los temporales duran 24 h: usa uno permanente de System User |
| Contesta pero no encuentra productos | `npm run verificar-catalogo` |
| El asesor no recibe avisos | `RUTEO_ASESORES` vacío, o pasaron 24 h sin conversación con ese número (Meta exige plantilla) |
| Dejó de funcionar de madrugada | ¿Se reinició por Windows Update? `.\hosting\estado.ps1` dirá cuánto lleva arriba |

---

## Riesgos que conviene tener claros

**Si se cae el internet de la oficina, el bot no contesta.** Meta reintenta la
entrega con frecuencia decreciente durante varios días, así que los mensajes no
se pierden, pero el cliente sí percibe la demora. Con una caída larga vale la
pena avisar por otro canal.

**Windows Update reinicia la PC.** El arranque automático lo cubre: al encender,
la tarea levanta el bot y `cloudflared` se reconecta solo. Aun así, configura la
ventana de mantenimiento activo de Windows fuera del horario de atención.

**La PC no debe suspenderse.** `instalar.ps1` ya lo desactiva con corriente. Si
es una laptop, déjala siempre conectada: con batería el comportamiento cambia.

**El `.env` tiene llaves con acceso total a la base.** Cualquiera con acceso a
esa PC puede leerlo. Ponle contraseña al usuario de Windows y no dejes la sesión
abierta.

**Un solo punto de falla.** Antes estaba en Railway con reinicio automático; una
PC de oficina depende de la luz, del internet y de que nadie la apague. Si el bot
se vuelve crítico para vender, conviene volver a un servidor o tener Railway
como respaldo listo para reactivar cambiando la URL en Meta.
