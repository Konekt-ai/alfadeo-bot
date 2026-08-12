# Reinicia el bot SIN traer cambios de GitHub.
#
#     bot-reiniciar
#
# Para cuando el código está bien pero el proceso se atoró. El caso típico:
# acabas de editar el .env — que no viaja en git, y por eso `bot-actualizar`
# nunca lo trae — y necesitas que el bot lo relea.

param([string]$NombreTarea = 'ALFA-DEO Bot WhatsApp')

$ErrorActionPreference = 'Stop'
$RaizBot = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'comun.ps1')

function Paso  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Bien  { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Alto  { param([string]$m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-EsAdministrador)) {
  Alto 'Hay que correr esto como administrador (la tarea del bot corre como SYSTEM).'
}

Paso 'Deteniendo el bot'
$bajados = Detener-Bot -NombreTarea $NombreTarea
Bien "Tarea detenida ($bajados proceso(s) de node bajado(s))"
Start-Sleep -Seconds 2

Paso 'Arrancando'
Iniciar-Bot -NombreTarea $NombreTarea

Paso 'Comprobando que responda'
$puerto   = Obtener-PuertoBot -RaizBot $RaizBot
$segundos = Esperar-Salud -Puerto $puerto

if ($segundos -lt 0) {
  Alto "No respondió en 60s. Revisa: Get-Content $RaizBot\logs\bot.log -Tail 50"
}

Bien "Responde en http://localhost:$puerto/health (a los ${segundos}s)"
Write-Host ''
