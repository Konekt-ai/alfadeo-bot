# Últimas líneas del log del bot.
#
#     bot-log              últimas 40 líneas
#     bot-log -Lineas 200  más historia
#     bot-log -Seguir      se queda mirando en vivo (Ctrl+C para salir)

param(
  [int]$Lineas = 40,
  [switch]$Seguir
)

$ErrorActionPreference = 'Stop'
$RaizBot    = Split-Path -Parent $PSScriptRoot
$ArchivoLog = Join-Path $RaizBot 'logs\bot.log'

if (-not (Test-Path $ArchivoLog)) {
  Write-Host "Todavía no hay log en $ArchivoLog" -ForegroundColor Yellow
  Write-Host "Si el bot nunca ha arrancado, revisa: bot-estado" -ForegroundColor Yellow
  exit 0
}

$tamano = [math]::Round((Get-Item $ArchivoLog).Length / 1KB, 1)
Write-Host "$ArchivoLog  ($tamano KB)" -ForegroundColor Cyan

# El supervisor escribe sus propias líneas al vuelo, pero la salida de node la
# guarda en un archivo temporal y sólo la vuelca al log cuando el proceso
# termina. O sea: mientras el bot está sano, aquí no aparecen mensajes nuevos
# suyos. No es que esté mudo.
Write-Host "(la salida de node se vuelca al log cuando el proceso reinicia)" -ForegroundColor DarkGray
Write-Host ''

if ($Seguir) {
  Get-Content $ArchivoLog -Tail $Lineas -Wait
} else {
  Get-Content $ArchivoLog -Tail $Lineas
}
