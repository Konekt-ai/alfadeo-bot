# Quita el arranque automático del bot ALFA-DEO.
#
#   PowerShell como administrador:
#       .\hosting\desinstalar.ps1
#
# NO borra el código, ni el .env, ni los logs, ni el túnel de Cloudflare.
# Sólo deja de levantarse solo al encender la PC.

#Requires -RunAsAdministrator

param(
  [string]$NombreTarea = 'ALFA-DEO Bot WhatsApp',
  # Quita también el servicio del túnel.
  [switch]$IncluirTunel,
  # Carpeta donde quedaron los comandos cortos (bot-estado, bot-actualizar...).
  [string]$CarpetaComandos = 'C:\alfadeo',
  [string]$Prefijo = 'bot-'
)

$ErrorActionPreference = 'Continue'

$tarea = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($null -eq $tarea) {
  Write-Host "No existe la tarea '$NombreTarea'; no hay nada que quitar." -ForegroundColor Yellow
} else {
  Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false
  Write-Host "Tarea '$NombreTarea' eliminada." -ForegroundColor Green
}

# El supervisor pudo dejar un node huérfano.
# El filtro va pegado a 'src\server.js' y descarta 'next' a propósito: en esta
# misma PC corre el panel con otro node, y desinstalar el bot no debe tocarlo.
$procesos = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'src[\\/]server\.js' -and $_.CommandLine -notlike '*next*' }
foreach ($p in $procesos) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    Write-Host "Proceso node detenido (PID $($p.ProcessId))." -ForegroundColor Green
  } catch {
    Write-Host "No pude detener el PID $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# Comandos cortos. Sólo se borran los que generamos nosotros: en esa misma
# carpeta viven los del panel y no se tocan.
$MARCA = 'REM generado por alfadeo-bot hosting\instalar-comandos.ps1'
foreach ($n in @('estado','actualizar','reiniciar','log')) {
  $ruta = Join-Path $CarpetaComandos ($Prefijo + $n + '.cmd')
  if (-not (Test-Path $ruta)) { continue }

  $contenido = Get-Content $ruta -Raw -ErrorAction SilentlyContinue
  if ($contenido -like "*$MARCA*") {
    Remove-Item $ruta -Force -ErrorAction SilentlyContinue
    Write-Host "Comando $($Prefijo)$n eliminado." -ForegroundColor Green
  } else {
    Write-Host "$ruta no lo generamos nosotros; se deja como está." -ForegroundColor Yellow
  }
}

if ($IncluirTunel) {
  $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($null -ne $svc) {
    & cloudflared service uninstall
    Write-Host 'Servicio cloudflared desinstalado.' -ForegroundColor Green
  } else {
    Write-Host 'El servicio cloudflared no estaba instalado.' -ForegroundColor Yellow
  }
}

Write-Host "`nListo. Para volver a instalarlo: .\hosting\instalar.ps1`n"
