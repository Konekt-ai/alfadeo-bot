@echo off
REM Atajo para actualizar el bot. Sirve tal cual por SSH:
REM     C:\alfadeo-bot\hosting\actualizar.cmd
REM     C:\alfadeo-bot\hosting\actualizar.cmd -Forzar
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0actualizar.ps1" %*
