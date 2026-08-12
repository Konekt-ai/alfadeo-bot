# Actualiza el bot a la última versión de GitHub y lo reinicia.
#
#   Desde esta PC, o por SSH desde donde programas:
#       C:\alfadeo-bot\hosting\actualizar.cmd
#
#   Opciones:
#       -Forzar       reinstala y reinicia aunque no haya nada nuevo
#       -SinPruebas   se salta las pruebas (no recomendado)
#
# Flujo pensado para el día a día: programas en tu máquina, pruebas en local,
# haces commit y push, y aquí sólo corres este script.
#
# Esta PC es un DESTINO de despliegue, no un lugar donde se programa: por eso
# se usa `reset --hard` y no `pull`. Nunca puede quedar un conflicto de merge a
# media mañana esperando a que alguien lo resuelva. Si alguien editó archivos
# aquí, se pierden — pero se avisa antes de descartarlos.

param(
  [switch]$Forzar,
  [switch]$SinPruebas,
  [string]$NombreTarea = 'ALFA-DEO Bot WhatsApp'
)

$ErrorActionPreference = 'Stop'
$RaizBot = Split-Path -Parent $PSScriptRoot

function Paso  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Bien  { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Aviso { param([string]$m) Write-Host "    !   $m" -ForegroundColor Yellow }
function Alto  { param([string]$m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

# --- Herramientas ------------------------------------------------------------
# Igual que en supervisor.ps1: no basta con el PATH. Aquí además hay que evitar
# C:\alfadeo\git.ps1, que en PowerShell le gana al git de verdad porque los
# scripts tienen precedencia sobre los .exe.
function Buscar-Herramienta {
  param([string]$Nombre, [string[]]$Candidatas)

  foreach ($c in $Candidatas) { if (Test-Path $c) { return $c } }

  $cmd = Get-Command $Nombre -All -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandType -eq 'Application' } |
         Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

$GIT = Buscar-Herramienta 'git' @(
  'C:\Program Files\Git\cmd\git.exe',
  'C:\alfadeo\git\cmd\git.exe'
)
if (-not $GIT) { Alto 'No encuentro git.exe.' }

$NPM = Buscar-Herramienta 'npm' @(
  'C:\Program Files\nodejs\npm.cmd',
  'C:\alfadeo\node\npm.cmd'
)
if (-not $NPM) { Alto 'No encuentro npm.cmd.' }

Set-Location $RaizBot

if (-not (Test-Path (Join-Path $RaizBot '.git')))  { Alto "$RaizBot no es un repositorio git." }
if (-not (Test-Path (Join-Path $RaizBot '.env'))) { Alto "Falta $RaizBot\.env — sin las llaves el bot no contesta." }

# La tarea del bot es de SYSTEM: detenerla y arrancarla necesita privilegios.
# Por SSH con una cuenta de administrador la sesión ya viene elevada.
$identidad = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identidad.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Alto 'Hay que correr esto como administrador (la tarea del bot corre como SYSTEM).'
}

Write-Host "`n===============================================" -ForegroundColor White
Write-Host "  Actualización del bot ALFA-DEO" -ForegroundColor White
Write-Host "===============================================" -ForegroundColor White
Write-Host "  Carpeta: $RaizBot"
Write-Host "  git:     $GIT"
Write-Host "  npm:     $NPM"

# --- 1. Qué hay de nuevo -----------------------------------------------------
Paso 'Buscando cambios en GitHub'

$antes = (& $GIT rev-parse HEAD).Trim()
Write-Host "    commit actual: $($antes.Substring(0,7))"

# El clon puede ser superficial (--depth 1); así se puede comparar historia.
if (Test-Path (Join-Path $RaizBot '.git\shallow')) {
  & $GIT fetch --unshallow origin 2>&1 | Out-Null
}

& $GIT fetch origin main -q
if ($LASTEXITCODE -ne 0) { Alto 'No se pudo alcanzar GitHub. Revisa la salida a internet.' }

$despues = (& $GIT rev-parse origin/main).Trim()

if ($antes -eq $despues -and -not $Forzar) {
  Bien 'Ya está al día. No se tocó nada.'
  Write-Host "    (usa -Forzar si quieres reinstalar y reiniciar de todos modos)"
  exit 0
}

if ($antes -ne $despues) {
  Write-Host "`n    Cambios que entran:"
  & $GIT log --oneline "$antes..$despues" | ForEach-Object { Write-Host "      $_" }
}

# Si alguien tocó archivos versionados en esta PC, se van a perder.
$sucio = & $GIT status --porcelain
if ($sucio) {
  Aviso 'Hay cambios locales en esta PC que se van a DESCARTAR:'
  $sucio | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
}

# --- 2. Bajar ----------------------------------------------------------------
Paso 'Trayendo la última versión'
& $GIT reset --hard origin/main -q
if ($LASTEXITCODE -ne 0) { Alto 'No se pudo alinear con origin/main.' }
Bien ("Actualizado a: " + (& $GIT rev-parse --short HEAD) + '  ' + (& $GIT log -1 --pretty=%s))

# --- 3. Dependencias ---------------------------------------------------------
# Sólo se reinstala si cambió el lockfile: lo normal es que un cambio sea puro
# código, y ahí reinstalar son 20 segundos tirados a la basura.
$lockCambio = $true
if ($antes -ne $despues) {
  & $GIT diff --quiet $antes $despues -- package-lock.json
  $lockCambio = ($LASTEXITCODE -ne 0)
} elseif (Test-Path (Join-Path $RaizBot 'node_modules')) {
  $lockCambio = $false
}

# npm manda sus avisos por stderr y, con ErrorActionPreference='Stop', en
# PowerShell 5.1 eso aborta el script aunque npm haya salido con código 0.
# Aquí decide $LASTEXITCODE, no lo que npm escriba en stderr.
$preferenciaPrevia = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  if ($lockCambio -or -not (Test-Path (Join-Path $RaizBot 'node_modules'))) {
    Paso 'Instalando dependencias (cambió el lockfile)'
    # `npm ci` y no `npm install`: instala exactamente lo que dice el lockfile
    # y no lo reescribe, así el repo no queda sucio en cada actualización.
    & $NPM ci --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Alto 'npm ci falló. ¿package-lock.json está al día con package.json?' }
    Bien 'Dependencias instaladas'
  } else {
    Paso 'Dependencias'
    Bien 'Sin cambios en el lockfile, se saltan'
  }

  # --- 4. Pruebas ------------------------------------------------------------
  # Se corren ANTES de reiniciar: si el código nuevo está roto, el bot sigue
  # contestando con la versión anterior, que ya está cargada en memoria.
  if (-not $SinPruebas) {
    Paso 'Corriendo las pruebas'
    & $NPM test --silent
    if ($LASTEXITCODE -ne 0) {
      $ErrorActionPreference = $preferenciaPrevia
      Alto @"
Las pruebas fallaron. NO se reinició: el bot sigue contestando con la versión
anterior, que sigue viva en memoria.

Ojo: los archivos en disco YA son los nuevos. Arregla y vuelve a correr esto,
o regresa a la versión anterior con:

    git -C "$RaizBot" reset --hard $antes
"@
    }
    Bien 'Todas las pruebas pasan'
  }
} finally {
  $ErrorActionPreference = $preferenciaPrevia
}

# --- 5. Reiniciar ------------------------------------------------------------
Paso 'Reiniciando el bot'

try { Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue } catch {}

# La tarea lanza al supervisor, y el supervisor lanza a node. Al detener la
# tarea el node hijo puede sobrevivir, así que se baja a mano.
# El filtro es estricto a propósito: en esta misma PC corre el panel con otro
# node (`next start`), y ese no se toca.
$hijos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*src\server.js*' }
foreach ($h in $hijos) {
  Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName $NombreTarea

# --- 6. Comprobar ------------------------------------------------------------
Paso 'Comprobando que responda'

$puerto = 3000
$contenidoEnv = Get-Content (Join-Path $RaizBot '.env') -Raw
if ($contenidoEnv -match '(?m)^\s*PORT\s*=\s*(\d+)') { $puerto = [int]$Matches[1] }

$vivo = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:$puerto/health" -TimeoutSec 3
    if ($r.ok -eq $true) {
      Bien "Responde en http://localhost:$puerto/health (a los $($i*2)s)"
      $vivo = $true
      break
    }
  } catch { }
}

if (-not $vivo) {
  Alto "El bot no respondió en 60s. Revisa: Get-Content $RaizBot\logs\bot.log -Tail 50"
}

Write-Host "`n===============================================" -ForegroundColor White
Write-Host "  Listo. Bot actualizado y corriendo." -ForegroundColor White
Write-Host "===============================================`n" -ForegroundColor White
