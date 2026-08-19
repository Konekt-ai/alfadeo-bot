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
     ├─ node src/server.js  (tarea programada + supervisor)
     ├─ panel Next.js       (tarea programada, puerto 3002)
     └─ PostgreSQL 17       (localhost:5433, NO sale a internet)
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

Y crea el usuario de base del bot, con permisos mínimos (una sola vez):

```powershell
psql -U postgres -p 5433 -d alfadeo -f sql\rol-bot.sql
```

Ese rol sólo alcanza las seis tablas que el bot usa y la función de búsqueda:
no puede borrar nada, ni ver ventas, ni tocar inventario. **No pongas en
`DATABASE_URL` el usuario `alfadeo` que usa el panel.**

Rellena como mínimo:

| Variable | De dónde sale |
| --- | --- |
| `WHATSAPP_TOKEN` | Meta for Developers → tu app → WhatsApp → API Setup |
| `WHATSAPP_PHONE_NUMBER_ID` | Mismo lugar. Es el **ID**, no el número visible |
| `WHATSAPP_VERIFY_TOKEN` | Lo inventas tú; debe coincidir con el que pongas en Meta |
| `DATABASE_URL` | `postgresql://bot:CONTRASENA@localhost:5433/alfadeo` |
| `META_APP_SECRET` | Meta → tu app → Configuración → Básica → Clave secreta |
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

**Esto sólo mueve el DNS, no mueve nada más.** Cloudflare se limita a resolver
nombres: los registros que hoy tienes se copian tal cual y todo sigue apuntando
a donde apuntaba.

> **Revisa el correo antes de confirmar.** El dominio `alfadeo.mx` tiene el
> correo en IONOS. Si los registros **MX** y el **SPF** no quedan copiados en
> Cloudflare, el correo de la empresa deja de llegar el día que propague el
> cambio, y nadie lo nota hasta que alguien reclama.

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

```text
# aquí: programas, pruebas con npm run dev, commiteas y empujas
git push

# allá:
ssh alfadeo-bot
bot-estado        # ¿está arriba? ¿en qué commit? ¿hay algo nuevo?
bot-actualizar    # traer, probar y reiniciar
```

| Comando | Qué hace |
| --- | --- |
| `bot-estado` | Diagnóstico completo, y te avisa si GitHub tiene commits que no están en la máquina |
| `bot-actualizar` | `fetch` → `reset --hard` → `npm ci` si cambió el lockfile → pruebas → reiniciar |
| `bot-actualizar -Forzar` | Reinstala y reinicia aunque no haya nada nuevo |
| `bot-reiniciar` | Reiniciar sin traer cambios (útil tras editar el `.env`) |
| `bot-log` | Últimas 40 líneas. `bot-log -Seguir` para verlo en vivo |

Son `.cmd` en `C:\alfadeo`, que ya está en el PATH del sistema: los escribes tal
cual apenas entras por SSH. Los instala `hosting\instalar.ps1`, y si alguno
falta `bot-actualizar` los repone solo en el siguiente despliegue.

**La primera vez** —en una máquina que ya tenía el bot pero todavía no los
comandos— hay que arrancar el huevo y la gallina a mano, una sola vez:

```powershell
ssh alfadeo-bot
C:\alfadeo-bot\hosting\actualizar.cmd
powershell -ExecutionPolicy Bypass -File C:\alfadeo-bot\hosting\instalar-comandos.ps1
bot-estado
```

De ahí en adelante basta `bot-actualizar`.

> **Por qué llevan prefijo `bot-`:** en esa misma carpeta viven los comandos del
> panel (`estado`, `actualizar`, `reiniciar`, `log`). Sin prefijo se pisarían.
> Si prefieres otros nombres: `.\hosting\instalar-comandos.ps1 -Prefijo 'wa-'`.

Los envoltorios sólo llaman a `hosting\*.ps1`, que sí se versionan. Así la
lógica mejora sola en cada despliegue y los `.cmd` no hay que volver a tocarlos.

Para dejarlo sin contraseña, en tu máquina:

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519_alfadeo -N '""'
```

y agrega el `.pub` a la PC de la empresa. **Ojo:** si la cuenta es de
administrador —que es el caso—, la llave **no** va en `~/.ssh/authorized_keys`
sino en `C:\ProgramData\ssh\administrators_authorized_keys`, y ese archivo sólo
puede tener permisos para *Administradores* y *SYSTEM*, sin herencia. Si los
permisos quedan flojos, `sshd` ignora el archivo en silencio y te sigue pidiendo
contraseña.

Tu `~/.ssh/config`:

```text
Host alfadeo-bot
    HostName 192.168.1.116
    User DELL
    IdentityFile ~/.ssh/id_ed25519_alfadeo
    IdentitiesOnly yes
```

### Actualizar el bot

El día a día es: programas en tu máquina, pruebas en local, `git push`. Y aquí,
un solo comando:

```powershell
C:\alfadeo-bot\hosting\actualizar.cmd
```

Funciona igual por SSH desde donde programas, sin abrir escritorio remoto:

```powershell
ssh DELL@192.168.1.116 C:\alfadeo-bot\hosting\actualizar.cmd
```

El script se encarga de todo:

1. Busca cambios en GitHub. **Si no hay nada nuevo, no toca nada** y termina
   (usa `-Forzar` si quieres reinstalar y reiniciar de todos modos).
2. Te lista los commits que entran, y te avisa si hay cambios locales en la PC
   que se van a descartar.
3. Se alinea con `origin/main`.
4. Reinstala dependencias **sólo si cambió `package-lock.json`**.
5. Corre las pruebas.
6. Reinicia el bot y comprueba que responda `/health`.

> **Por qué `reset --hard` y no `git pull`:** esta PC es un destino de
> despliegue, no un lugar donde se programa. Con `pull`, cualquier archivo
> editado aquí produce un conflicto de merge, y un conflicto a media mañana
> significa que el bot se queda sin actualizar y nadie se entera. Con `reset`
> el resultado es siempre el mismo: exactamente lo que hay en `origin/main`.

**Si las pruebas fallan, no reinicia.** El bot sigue contestando con la versión
anterior, que ya está cargada en memoria. Eso sí: los archivos en disco ya son
los nuevos, así que arregla y vuelve a correrlo, o regresa a la versión buena
con `git reset --hard <commit>` (el script te imprime cuál era).

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

**El `.env` tiene la contraseña de la base.** Ya no es una llave maestra —el rol
`bot` sólo alcanza seis tablas y no puede borrar— pero con ella se leen los
datos de los clientes y sus solicitudes. Ponle contraseña al usuario de Windows
y no dejes la sesión abierta.

**Un solo punto de falla.** Antes estaba en Railway con reinicio automático; una
PC de oficina depende de la luz, del internet y de que nadie la apague. Si el bot
se vuelve crítico para vender, conviene volver a un servidor o tener Railway
como respaldo listo para reactivar cambiando la URL en Meta.
