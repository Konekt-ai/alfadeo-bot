@echo off
REM Diagnostico del bot. Sirve tal cual por SSH:
REM     ssh alfadeo-bot C:\alfadeo-bot\hosting\estado.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0estado.ps1" %*
