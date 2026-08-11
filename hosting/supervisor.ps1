# Supervisor del bot ALFA-DEO.
#
# Mantiene `node src/server.js` corriendo pase lo que pase: si el proceso muere
# lo vuelve a levantar, y va guardando la salida en logs\bot.log con rotación.
#
# No se ejecuta a mano: lo lanza la tarea programada que instala instalar.ps1.
# Para verlo trabajar en vivo puedes correrlo directo desde PowerShell.

param(
  # Raíz del proyecto (la carpeta que contiene src\ y .env).
  [string]$RaizBot = (Split-Path -Parent $PSScriptRoot),

  # Segundos de espera inicial antes de reintentar tras una caída.
  [int]$EsperaInicial = 5,

  # Tope de espera entre reintentos.
  [int]$EsperaMaxima = 60,

  # Tamaño en MB a partir del cual se rota el log.
  [int]$TamanoLogMB = 10,

  # Cuántos logs viejos se conservan.
  [int]$LogsAConservar = 5
)

$ErrorActionPreference = 'Stop'

$CarpetaLogs = Join-Path $RaizBot 'logs'
$ArchivoLog  = Join-Path $CarpetaLogs 'bot.log'
$Entrada     = Join-Path $RaizBot 'src\server.js'

if (-not (Test-Path $CarpetaLogs)) {
  New-Item -ItemType Directory -Path $CarpetaLogs -Force | Out-Null
}

function Write-Log {
  param([string]$Mensaje, [string]$Nivel = 'INFO')
  $linea = "[{0}] {1,-5} [supervisor] {2}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Nivel, $Mensaje
  Add-Content -Path $ArchivoLog -Value $linea -Encoding utf8
  Write-Host $linea
}

function Invoke-RotacionDeLog {
  if (-not (Test-Path $ArchivoLog)) { return }

  $mb = (Get-Item $ArchivoLog).Length / 1MB
  if ($mb -lt $TamanoLogMB) { return }

  $sello = Get-Date -Format 'yyyyMMdd-HHmmss'
  Move-Item -Path $ArchivoLog -Destination (Join-Path $CarpetaLogs "bot-$sello.log") -Force

  # Se conservan sólo los N más recientes.
  $viejos = Get-ChildItem -Path $CarpetaLogs -Filter 'bot-*.log' |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip $LogsAConservar
  foreach ($v in $viejos) {
    try { Remove-Item $v.FullName -Force -ErrorAction Stop } catch {}
  }
}

# --- Verificaciones de arranque ---------------------------------------------
if (-not (Test-Path $Entrada)) {
  Write-Log "No encuentro $Entrada. ¿RaizBot está bien? ($RaizBot)" 'ERROR'
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Log 'Node.js no está en el PATH. Instálalo con: winget install OpenJS.NodeJS.LTS' 'ERROR'
  exit 1
}

if (-not (Test-Path (Join-Path $RaizBot '.env'))) {
  Write-Log 'Falta el archivo .env. Cópialo de .env.example y llénalo.' 'ERROR'
  exit 1
}

Write-Log "Supervisor iniciado. Node: $($node.Source)"
Write-Log "Raíz del bot: $RaizBot"

# --- Ciclo de supervisión ----------------------------------------------------
$espera = $EsperaInicial

while ($true) {
  Invoke-RotacionDeLog

  $inicio = Get-Date
  Write-Log 'Levantando el bot...'

  try {
    # Se redirige todo a un archivo temporal y de ahí al log, para que el
    # supervisor mantenga el control aunque node escupa mucho texto.
    $tmpOut = Join-Path $CarpetaLogs 'salida.tmp'
    $tmpErr = Join-Path $CarpetaLogs 'error.tmp'

    $proceso = Start-Process -FilePath $node.Source `
                             -ArgumentList 'src\server.js' `
                             -WorkingDirectory $RaizBot `
                             -RedirectStandardOutput $tmpOut `
                             -RedirectStandardError $tmpErr `
                             -NoNewWindow -PassThru

    # Tocar .Handle obliga a .NET a conservar el handle del proceso; sin esto
    # ExitCode queda vacío después de WaitForExit y el log no dice nada útil.
    $null = $proceso.Handle

    $proceso.WaitForExit()
    $codigo = $proceso.ExitCode
    if ($null -eq $codigo) { $codigo = 'desconocido' }

    foreach ($tmp in @($tmpOut, $tmpErr)) {
      if (Test-Path $tmp) {
        Get-Content $tmp -ErrorAction SilentlyContinue | Add-Content -Path $ArchivoLog -Encoding utf8
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    Write-Log "Fallo al lanzar node: $($_.Exception.Message)" 'ERROR'
    $codigo = -1
  }

  $duracion = (Get-Date) - $inicio
  Write-Log ("El bot terminó con código {0} después de {1:n0} segundos." -f $codigo, $duracion.TotalSeconds) 'WARN'

  # Si aguantó más de un minuto, no fue un fallo de arranque: se reintenta rápido.
  if ($duracion.TotalSeconds -gt 60) {
    $espera = $EsperaInicial
  } else {
    $espera = [Math]::Min($espera * 2, $EsperaMaxima)
  }

  Write-Log "Reintentando en $espera segundos."
  Start-Sleep -Seconds $espera
}
