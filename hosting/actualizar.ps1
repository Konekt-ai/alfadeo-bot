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

. (Join-Path $PSScriptRoot 'comun.ps1')

function Paso  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Bien  { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Aviso { param([string]$m) Write-Host "    !   $m" -ForegroundColor Yellow }
function Alto  { param([string]$m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

# --- Herramientas ------------------------------------------------------------
$GIT = Buscar-Git
if (-not $GIT) { Alto 'No encuentro git.exe.' }

$NPM = Buscar-Npm
if (-not $NPM) { Alto 'No encuentro npm.cmd.' }

Set-Location $RaizBot

if (-not (Test-Path (Join-Path $RaizBot '.git')))  { Alto "$RaizBot no es un repositorio git." }
if (-not (Test-Path (Join-Path $RaizBot '.env'))) { Alto "Falta $RaizBot\.env — sin las llaves el bot no contesta." }

# La tarea del bot es de SYSTEM: detenerla y arrancarla necesita privilegios.
# Por SSH con una cuenta de administrador la sesión ya viene elevada.
if (-not (Test-EsAdministrador)) {
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

Detener-Bot -NombreTarea $NombreTarea | Out-Null
Start-Sleep -Seconds 2
Iniciar-Bot -NombreTarea $NombreTarea

# --- 6. Comprobar ------------------------------------------------------------
Paso 'Comprobando que responda'

$puerto   = Obtener-PuertoBot -RaizBot $RaizBot
$segundos = Esperar-Salud -Puerto $puerto

if ($segundos -lt 0) {
  Alto "El bot no respondió en 60s. Revisa: bot-log"
}

Bien "Responde en http://localhost:$puerto/health (a los ${segundos}s)"

Write-Host "`n===============================================" -ForegroundColor White
Write-Host "  Listo. Bot actualizado y corriendo." -ForegroundColor White
Write-Host "===============================================`n" -ForegroundColor White
