# Deja los comandos cortos del bot disponibles apenas entras por SSH.
#
#     .\hosting\instalar-comandos.ps1
#
# Después de esto, desde cualquier carpeta:
#
#     bot-estado        ¿está arriba? ¿en qué commit? ¿hay algo nuevo?
#     bot-actualizar    traer de GitHub, probar y reiniciar
#     bot-reiniciar     reiniciar sin traer cambios
#     bot-log           últimas 40 líneas
#
# Los .cmd van a C:\alfadeo porque esa carpeta ya está en el PATH del sistema,
# igual que los del panel. Son envoltorios de tres líneas: la lógica de verdad
# vive en hosting\*.ps1, que sí se versiona y sí se actualiza con git. Así
# `bot-actualizar` mejora solo cuando haces un despliegue.
#
# Por qué el prefijo `bot-`: el panel ya ocupa `estado`, `actualizar`,
# `reiniciar` y `log` en esa misma carpeta. Sin prefijo se pisarían.

param(
  # Carpeta donde se dejan los .cmd. Tiene que estar en el PATH.
  [string]$Destino = 'C:\alfadeo',

  # Cambia el prefijo si prefieres otros nombres (ej. -Prefijo 'wa-').
  [string]$Prefijo = 'bot-',

  # Sobrescribe aunque el archivo no lo hayamos generado nosotros.
  [switch]$Forzar
)

$ErrorActionPreference = 'Stop'
$RaizBot = Split-Path -Parent $PSScriptRoot

function Bien  { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Aviso { param([string]$m) Write-Host "    !   $m" -ForegroundColor Yellow }
function Alto  { param([string]$m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

# Marca para reconocer los archivos que generamos y no pisar los del panel.
$MARCA = 'REM generado por alfadeo-bot hosting\instalar-comandos.ps1'

$comandos = @(
  @{ Nombre = 'estado';     Script = 'estado.ps1';     Ayuda = 'diagnostico completo' },
  @{ Nombre = 'actualizar'; Script = 'actualizar.ps1'; Ayuda = 'traer de GitHub, probar y reiniciar' },
  @{ Nombre = 'reiniciar';  Script = 'reiniciar.ps1';  Ayuda = 'reiniciar sin traer cambios' },
  @{ Nombre = 'log';        Script = 'log.ps1';        Ayuda = 'ultimas lineas del log' }
)

Write-Host "`n==> Instalando comandos del bot en $Destino" -ForegroundColor Cyan

if (-not (Test-Path $Destino)) {
  New-Item -ItemType Directory -Path $Destino -Force | Out-Null
  Aviso "No existía $Destino, se creó."
}

# Si la carpeta no está en el PATH del sistema, los comandos no se ven y esto
# no sirve de nada. Mejor decirlo aquí que dejar que falle en silencio.
$pathMaquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$enPath = ($pathMaquina -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Destino.TrimEnd('\') }).Count -gt 0

foreach ($c in $comandos) {
  $nombreCmd = $Prefijo + $c.Nombre + '.cmd'
  $ruta      = Join-Path $Destino $nombreCmd
  $destinoPs = Join-Path $RaizBot ('hosting\' + $c.Script)

  if (-not (Test-Path $destinoPs)) {
    Aviso "$nombreCmd omitido: no existe $destinoPs"
    continue
  }

  # No pisar algo que no sea nuestro (los comandos del panel viven aquí).
  if ((Test-Path $ruta) -and -not $Forzar) {
    $actual = Get-Content $ruta -Raw -ErrorAction SilentlyContinue
    if ($actual -notlike "*$MARCA*") {
      Aviso "$nombreCmd YA EXISTE y no lo generamos nosotros. No se toca (usa -Forzar para sobrescribir)."
      continue
    }
  }

  $contenido = @"
@echo off
$MARCA
REM $($c.Ayuda)
powershell -NoProfile -ExecutionPolicy Bypass -File "$destinoPs" %*
"@

  # ASCII y CRLF: son archivos .cmd, los interpreta cmd.exe.
  [IO.File]::WriteAllText($ruta, ($contenido -replace "`r?`n", "`r`n") + "`r`n", [Text.Encoding]::ASCII)
  Bien "$nombreCmd  ->  hosting\$($c.Script)"
}

if ($enPath) {
  Bien "$Destino ya está en el PATH del sistema"
} else {
  Aviso "$Destino NO está en el PATH del sistema: los comandos no se van a ver."
  Aviso "Agrégalo con (como administrador, y reabre la sesión):"
  Write-Host "        [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','Machine') + ';$Destino', 'Machine')" -ForegroundColor Yellow
}

Write-Host @"

  Listo. Al entrar por SSH ya puedes escribir:

      $($Prefijo)estado        ¿está arriba? ¿en qué commit? ¿hay algo nuevo?
      $($Prefijo)actualizar    traer de GitHub, probar y reiniciar
      $($Prefijo)reiniciar     reiniciar sin traer cambios
      $($Prefijo)log           últimas 40 líneas

  (si acabas de abrir la sesión SSH, ciérrala y vuelve a entrar para que
   tome el PATH)

"@
