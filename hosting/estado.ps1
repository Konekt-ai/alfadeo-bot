# Diagnóstico rápido del bot ALFA-DEO en la PC de la empresa.
#
#     .\hosting\estado.ps1
#
# Contesta de un vistazo: ¿está prendido?, ¿responde?, ¿el túnel está arriba?,
# ¿qué dice el log?
#
# Nota para quien lo edite: NO uses "Si" como nombre de función. PowerShell ya
# trae un alias `si` (Set-Item) y el alias gana sobre la función, así que el
# script falla de formas muy raras.

param(
  [string]$NombreTarea = 'ALFA-DEO Bot WhatsApp',
  [int]$LineasLog = 25,

  # Se salta la consulta a GitHub. Útil si la PC está sin internet y no quieres
  # esperar el timeout.
  [switch]$SinRed
)

$RaizBot = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'comun.ps1')

function Titulo { param([string]$m) Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Ok     { param([string]$m) Write-Host "   [OK]    $m" -ForegroundColor Green }
function Falla  { param([string]$m) Write-Host "   [FALLA] $m" -ForegroundColor Red }
function Nota   { param([string]$m) Write-Host "   [ ]     $m" -ForegroundColor Yellow }

Write-Host "`nEstado del bot ALFA-DEO — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor White

# --- Versión desplegada ------------------------------------------------------
# Ahora que se despliega con hosting\actualizar.cmd, lo primero que uno quiere
# saber al diagnosticar es qué versión está corriendo.
Titulo 'Versión desplegada'

$git = Buscar-Git

if ($null -eq $git) {
  Nota 'No encuentro git.exe, no puedo decirte qué versión está desplegada.'
} elseif (-not (Test-Path (Join-Path $RaizBot '.git'))) {
  Nota 'Esta copia no es un repositorio git: se instaló a mano.'
} else {
  Ok ((& $git -C $RaizBot log -1 --pretty='%h  %s  (%ar)') -join '')

  $sucio = @(& $git -C $RaizBot status --porcelain)
  if ($sucio.Count -gt 0) {
    Nota "$($sucio.Count) archivo(s) editado(s) a mano aquí; el próximo bot-actualizar los descarta:"
    foreach ($s in $sucio) { Write-Host "             $s" -ForegroundColor Yellow }
  }

  # ¿Hay algo en GitHub que no esté aquí? Es una consulta de red, así que se
  # hace en silencio y sin tumbar el diagnóstico si la PC está sin internet.
  if (-not $SinRed) {
    & $git -C $RaizBot fetch origin main -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Nota 'No pude consultar GitHub (¿sin internet?). El resto del diagnóstico sigue siendo válido.'
    } else {
      $pendientes = @(& $git -C $RaizBot log --oneline HEAD..origin/main)
      if ($pendientes.Count -eq 0) {
        Ok 'Al día con GitHub'
      } else {
        Nota "$($pendientes.Count) commit(s) en GitHub que no están aquí. Corre: bot-actualizar"
        foreach ($p in $pendientes) { Write-Host "             $p" -ForegroundColor Yellow }
      }
    }
  }
}

# --- Tarea programada --------------------------------------------------------
Titulo 'Arranque automático'
$tarea = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($null -eq $tarea) {
  Falla "La tarea '$NombreTarea' no existe. Corre hosting\instalar.ps1 como administrador."
} else {
  if ($tarea.State -eq 'Running') { Ok 'Tarea corriendo' }
  else { Falla "Tarea en estado: $($tarea.State)" }

  $info = Get-ScheduledTaskInfo -TaskName $NombreTarea -ErrorAction SilentlyContinue
  if ($null -ne $info) {
    Nota "Última ejecución: $($info.LastRunTime)  ·  resultado: $($info.LastTaskResult)"
  }
}

# --- Proceso de node ---------------------------------------------------------
Titulo 'Proceso'
$procesos = @()
try {
  # Se acepta barra y contrabarra: la tarea programada lanza con "src\server.js"
  # pero quien lo arranque a mano desde Git Bash usará "src/server.js". Ver los
  # dos importa: si aparecen dos procesos, hay una instancia de más peleándose
  # por el puerto.
  $procesos = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]server\.js' })
} catch {
  Nota "No pude consultar los procesos: $($_.Exception.Message)"
}

if ($procesos.Count -eq 0) {
  Falla 'No hay ningún node corriendo el servidor del bot.'
} else {
  foreach ($p in $procesos) {
    # Get-CimInstance ya entrega CreationDate como DateTime; Get-WmiObject lo
    # daba como cadena DMTF. Se aceptan las dos por si alguien cambia el cmdlet.
    $desde = $p.CreationDate
    if ($desde -isnot [datetime]) {
      try { $desde = [Management.ManagementDateTimeConverter]::ToDateTime($desde) }
      catch { $desde = $null }
    }

    if ($null -eq $desde) {
      Ok "PID $($p.ProcessId) corriendo (no pude leer desde cuándo)"
    } else {
      $vivo = (Get-Date) - $desde
      Ok ("PID {0}, lleva {1}h {2}m arriba" -f $p.ProcessId, [math]::Floor($vivo.TotalHours), $vivo.Minutes)
    }
  }
}

# --- Base de datos -----------------------------------------------------------
# El bot dejo la nube: ahora la base es PostgreSQL en esta misma computadora.
# Si el puerto no escucha, no hay nada mas que revisar.
Titulo 'Base de datos'

$rutaEnvBase = Join-Path $RaizBot '.env'
$urlBase = $null
if (Test-Path $rutaEnvBase) {
  $textoEnvBase = Get-Content $rutaEnvBase -Raw
  if ($textoEnvBase -match '(?m)^\s*DATABASE_URL\s*=\s*(\S+)') { $urlBase = $Matches[1] }
}

if (-not $urlBase) {
  Falla 'Falta DATABASE_URL en .env. El bot no puede leer ni guardar nada.'
} else {
  # Se muestra sin la contrasenia: esto se corre por SSH y queda en pantalla.
  Ok ("Configurada: " + ($urlBase -replace '://[^@]*@', '://***@'))

  $puertoBase = 5433
  if ($urlBase -match ':(\d+)/') { $puertoBase = [int]$Matches[1] }

  $escucha = Get-NetTCPConnection -State Listen -LocalPort $puertoBase -ErrorAction SilentlyContinue
  if ($escucha) {
    Ok "PostgreSQL escuchando en el puerto $puertoBase"
  } else {
    Falla "Nada escucha en el puerto $puertoBase. Revisa el servicio de PostgreSQL."
  }
  Nota 'Prueba completa (permisos, tablas y busqueda):  npm run probar-base'
}

# --- Health check ------------------------------------------------------------
Titulo 'Respuesta local'
$puerto = Obtener-PuertoBot -RaizBot $RaizBot

try {
  $r = Invoke-RestMethod -Uri "http://localhost:$puerto/health" -TimeoutSec 5
  if ($r.ok -eq $true) { Ok "http://localhost:$puerto/health responde ok" }
  else { Falla "Respondió algo inesperado: $($r | ConvertTo-Json -Compress)" }
} catch {
  Falla "No responde en el puerto $puerto — $($_.Exception.Message)"
}

# --- Túnel de Cloudflare -----------------------------------------------------
Titulo 'Túnel de Cloudflare'
$svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  Falla 'El servicio cloudflared no está instalado. Ver hosting\README.md sección 3.'
} else {
  if ($svc.Status -eq 'Running') { Ok 'Servicio cloudflared corriendo' }
  else { Falla "cloudflared está en estado: $($svc.Status)" }
}

# --- Prueba pública ----------------------------------------------------------
Titulo 'URL pública'
$rutaUrl = Join-Path $PSScriptRoot 'url-publica.txt'
if (Test-Path $rutaUrl) {
  $url = (Get-Content $rutaUrl -Raw).Trim()
  try {
    $r = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 10
    if ($r.ok -eq $true) { Ok "$url/health responde — Meta puede alcanzar el bot" }
    else { Falla "Respuesta inesperada desde $url" }
  } catch {
    Falla "$url no responde — $($_.Exception.Message)"
  }
} else {
  Nota 'Guarda tu URL pública en hosting\url-publica.txt para revisarla desde aquí.'
  Nota "Ejemplo:  'https://bot.tudominio.com' | Out-File hosting\url-publica.txt -Encoding utf8"
}

# --- Log ---------------------------------------------------------------------
Titulo "Últimas $LineasLog líneas del log"
$rutaLog = Join-Path $RaizBot 'logs\bot.log'
if (Test-Path $rutaLog) {
  Get-Content $rutaLog -Tail $LineasLog | ForEach-Object {
    if ($_ -match '\bERROR\b')     { Write-Host "   $_" -ForegroundColor Red }
    elseif ($_ -match '\bWARN\b')  { Write-Host "   $_" -ForegroundColor Yellow }
    else                           { Write-Host "   $_" -ForegroundColor DarkGray }
  }
} else {
  Nota "Todavía no hay log en $rutaLog"
}

Write-Host "`nPara seguir el log en vivo:  Get-Content '$rutaLog' -Tail 50 -Wait`n"
