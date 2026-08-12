# Funciones compartidas por los scripts de hosting.
#
# No se ejecuta solo: se carga con dot-source desde los demás.
#
#     . (Join-Path $PSScriptRoot 'comun.ps1')
#
# Aquí vive todo lo que necesitan dos o más scripts. En particular el reinicio
# del bot, que lleva una guarda para no matar al panel: si esa guarda estuviera
# copiada en varios archivos, tarde o temprano uno se queda atrás y un día
# `bot-reiniciar` tumba la caja del mostrador.

# Busca un ejecutable por ruta conocida antes que por PATH.
#
# Hace falta por dos razones, las dos reales en esta PC:
#   - Las tareas programadas corren como SYSTEM, que no hereda el PATH del
#     usuario. Ahí vive el Node portable (C:\alfadeo\node).
#   - C:\alfadeo\git.ps1 le gana al git de verdad en PowerShell, porque los
#     scripts tienen precedencia sobre los .exe. Por eso se filtra por
#     CommandType 'Application'.
function Buscar-Herramienta {
  param(
    [Parameter(Mandatory)][string]$Nombre,
    [string[]]$Candidatas = @()
  )

  foreach ($c in $Candidatas) {
    if (Test-Path $c) { return $c }
  }

  $cmd = Get-Command $Nombre -All -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandType -eq 'Application' } |
         Select-Object -First 1

  if ($cmd) { return $cmd.Source }
  return $null
}

function Buscar-Git {
  return (Buscar-Herramienta -Nombre 'git' -Candidatas @(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\alfadeo\git\cmd\git.exe'
  ))
}

function Buscar-Npm {
  return (Buscar-Herramienta -Nombre 'npm' -Candidatas @(
    'C:\Program Files\nodejs\npm.cmd',
    'C:\alfadeo\node\npm.cmd'
  ))
}

# Puerto en el que escucha el bot, según el .env. Default 3000.
function Obtener-PuertoBot {
  param([Parameter(Mandatory)][string]$RaizBot)

  $rutaEnv = Join-Path $RaizBot '.env'
  if (Test-Path $rutaEnv) {
    $contenido = Get-Content $rutaEnv -Raw
    if ($contenido -match '(?m)^\s*PORT\s*=\s*(\d+)') { return [int]$Matches[1] }
  }
  return 3000
}

# ¿Corre esta sesión con privilegios? La tarea del bot es de SYSTEM: sin esto
# no se puede detener ni arrancar.
function Test-EsAdministrador {
  $identidad = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $identidad.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Baja el bot: detiene la tarea y, si el node hijo sobrevive, lo baja a mano.
#
# GUARDA IMPORTANTE: en esta misma PC corre el panel con otro node
# (`next start -p 3002`). El filtro por 'src\server.js' es lo único que separa
# un proceso del otro. No lo aflojes.
function Detener-Bot {
  param([string]$NombreTarea = 'ALFA-DEO Bot WhatsApp')

  try { Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue } catch { }

  $hijos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*src\server.js*' -and $_.CommandLine -notlike '*next*' }

  foreach ($h in $hijos) {
    Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue
  }

  return @($hijos).Count
}

function Iniciar-Bot {
  param([string]$NombreTarea = 'ALFA-DEO Bot WhatsApp')
  Start-ScheduledTask -TaskName $NombreTarea
}

# Espera a que /health conteste. Devuelve los segundos que tardó, o -1 si nunca.
function Esperar-Salud {
  param(
    [Parameter(Mandatory)][int]$Puerto,
    [int]$SegundosMaximos = 60
  )

  $intentos = [Math]::Max(1, [int]($SegundosMaximos / 2))
  for ($i = 1; $i -le $intentos; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-RestMethod -Uri "http://localhost:$Puerto/health" -TimeoutSec 3
      if ($r.ok -eq $true) { return ($i * 2) }
    } catch { }
  }
  return -1
}
