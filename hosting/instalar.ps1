# Instala el bot ALFA-DEO como servicio en la PC de la empresa.
#
#   Clic derecho en PowerShell -> "Ejecutar como administrador", y:
#       cd C:\alfadeo-bot\hosting
#       .\instalar.ps1
#
# Qué hace:
#   1. Verifica Node.js y el archivo .env
#   2. Instala dependencias de producción
#   3. Corre las pruebas
#   4. Evita que la PC se duerma (si se duerme, el bot deja de contestar)
#   5. Registra una tarea que arranca el bot al encender la PC y lo reinicia
#      solo si se cae
#
# NO instala el túnel de Cloudflare: eso va aparte, ver hosting/README.md

#Requires -RunAsAdministrator

param(
  [string]$NombreTarea = 'ALFA-DEO Bot WhatsApp',
  [switch]$SinPruebas
)

$ErrorActionPreference = 'Stop'
$RaizBot = Split-Path -Parent $PSScriptRoot

function Paso  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Bien  { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Aviso { param([string]$m) Write-Host "    !   $m" -ForegroundColor Yellow }
function Alto  { param([string]$m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

Write-Host "`n===============================================" -ForegroundColor White
Write-Host "  Instalación del bot ALFA-DEO" -ForegroundColor White
Write-Host "===============================================" -ForegroundColor White
Write-Host "  Carpeta: $RaizBot"

# --- 1. Node.js --------------------------------------------------------------
Paso 'Verificando Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Alto @'
Node.js no está instalado (o no está en el PATH).
Instálalo con:

    winget install OpenJS.NodeJS.LTS

Cierra y vuelve a abrir PowerShell, y corre este script otra vez.
'@
}

$version = (& node --version).TrimStart('v')
$mayor = [int]($version.Split('.')[0])
if ($mayor -lt 20) {
  Alto "Node $version es muy viejo. Se necesita 20 o superior: winget install OpenJS.NodeJS.LTS"
}
Bien "Node $version en $($node.Source)"

# --- 2. Archivo .env ---------------------------------------------------------
Paso 'Verificando configuración'
$rutaEnv = Join-Path $RaizBot '.env'

if (-not (Test-Path $rutaEnv)) {
  $ejemplo = Join-Path $RaizBot '.env.example'
  Copy-Item $ejemplo $rutaEnv
  Alto @"
No existía .env, así que lo creé a partir de .env.example:

    $rutaEnv

Ábrelo y llena TODAS las variables (tokens de Meta, Supabase y los números
de RUTEO_ASESORES). Luego corre este script otra vez.
"@
}

$contenidoEnv = Get-Content $rutaEnv -Raw
$faltantes = @()
foreach ($clave in @('WHATSAPP_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_VERIFY_TOKEN','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY')) {
  if ($contenidoEnv -notmatch "(?m)^\s*$clave\s*=\s*\S") { $faltantes += $clave }
}
if ($faltantes.Count -gt 0) {
  Alto "Faltan valores en .env: $($faltantes -join ', ')"
}
Bien 'El .env tiene todas las variables obligatorias'

if ($contenidoEnv -notmatch '(?m)^\s*RUTEO_ASESORES\s*=\s*\S') {
  Aviso 'RUTEO_ASESORES está vacío: todas las solicitudes irán a INTERNAL_NOTIFY_NUMBERS sin distinguir plaza.'
}

# --- 3. Dependencias ---------------------------------------------------------
Paso 'Instalando dependencias'
Push-Location $RaizBot

# npm manda sus avisos (EBADENGINE, audit, deprecaciones) por stderr. En
# PowerShell 5.1, con ErrorActionPreference='Stop', redirigir stderr de un
# programa externo convierte cada línea en un error TERMINANTE y aborta la
# instalación aunque npm haya salido con código 0. Bajamos la guardia sólo
# alrededor de npm: quien manda aquí es $LASTEXITCODE, no lo que escupa stderr.
$preferenciaPrevia = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  if (Test-Path (Join-Path $RaizBot 'package-lock.json')) {
    & npm ci --omit=dev 2>&1 | Out-Null
  } else {
    & npm install --omit=dev 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Alto 'npm falló al instalar dependencias.' }
  Bien 'Dependencias instaladas'

  # --- 4. Pruebas ------------------------------------------------------------
  if (-not $SinPruebas) {
    Paso 'Corriendo las pruebas'
    & npm test 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Aviso 'Algunas pruebas fallaron. Revisa con: npm test'
    } else {
      Bien 'Todas las pruebas pasan'
    }
  }
} finally {
  $ErrorActionPreference = $preferenciaPrevia
  Pop-Location
}

# --- 5. Que la PC no se duerma ----------------------------------------------
Paso 'Ajustando energía para que la PC no se suspenda'
try {
  & powercfg /change standby-timeout-ac 0
  & powercfg /change hibernate-timeout-ac 0
  & powercfg /change monitor-timeout-ac 15
  Bien 'La PC ya no se suspende con corriente (la pantalla sí se apaga a los 15 min)'
} catch {
  Aviso "No pude cambiar la configuración de energía: $($_.Exception.Message)"
}

# --- 6. Tarea programada -----------------------------------------------------
Paso 'Registrando el arranque automático'

$existente = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($null -ne $existente) {
  Aviso 'Ya existía la tarea; se reemplaza.'
  Stop-ScheduledTask  -TaskName $NombreTarea -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false
}

$rutaSupervisor = Join-Path $PSScriptRoot 'supervisor.ps1'

$accion = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$rutaSupervisor`"" `
  -WorkingDirectory $RaizBot

# Al encender la PC, sin importar quién inicie sesión.
$disparador = New-ScheduledTaskTrigger -AtStartup

# SYSTEM: así corre aunque nadie tenga sesión abierta y sin guardar contraseñas.
$identidad = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$opciones = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $NombreTarea `
  -Action $accion `
  -Trigger $disparador `
  -Principal $identidad `
  -Settings $opciones `
  -Description 'Webhook del bot de WhatsApp de ALFA-DEO. Lo mantiene vivo hosting\supervisor.ps1.' | Out-Null

Bien "Tarea registrada: $NombreTarea"

Start-ScheduledTask -TaskName $NombreTarea
Bien 'Bot arrancado'

# --- 7. Comprobación ---------------------------------------------------------
Paso 'Comprobando que responda'
$puerto = 3000
if ($contenidoEnv -match '(?m)^\s*PORT\s*=\s*(\d+)') { $puerto = [int]$Matches[1] }

$vivo = $false
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:$puerto/health" -TimeoutSec 3
    if ($r.ok -eq $true) { $vivo = $true; break }
  } catch { }
}

if ($vivo) {
  Bien "El bot responde en http://localhost:$puerto/health"
} else {
  Aviso "El bot no respondió todavía. Revisa el log: $RaizBot\logs\bot.log"
}

Write-Host "`n===============================================" -ForegroundColor White
Write-Host "  Listo. Falta el túnel de Cloudflare." -ForegroundColor White
Write-Host "===============================================" -ForegroundColor White
Write-Host @"

  Siguiente paso:  hosting\README.md  (sección "2. Túnel de Cloudflare")

  Comandos útiles:
      .\hosting\estado.ps1        ver si está vivo y las últimas líneas del log
      .\hosting\desinstalar.ps1   quitar el arranque automático
      Get-Content .\logs\bot.log -Tail 50 -Wait     ver el log en vivo

"@
