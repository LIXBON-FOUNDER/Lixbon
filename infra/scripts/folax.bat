@echo off
setlocal enabledelayedexpansion
title FOLAX DTC — Launcher v2.0
cd /d "%~dp0"

:: ── Activar entorno virtual si existe ─────────────────────────────────────
if exist ".venv\Scripts\activate.bat" (
    call ".venv\Scripts\activate.bat" >nul 2>&1
)

:MENU
cls
echo.
echo  ╔═══════════════════════════════════════════════╗
echo  ║                                               ║
echo  ║       F O L A X   D T C   v2.0               ║
echo  ║       Data ^& Task Center — Launcher          ║
echo  ║                                               ║
echo  ╠═══════════════════════════════════════════════╣
echo  ║                                               ║
echo  ║   [1]  Iniciar stack completo                 ║
echo  ║   [2]  Solo Gateway    (FastAPI :8000)        ║
echo  ║   [3]  Solo Node Agent (:8765)                ║
echo  ║   [4]  Solo Ollama LAN (host: 0.0.0.0)       ║
echo  ║   [5]  Solo Tunel Cloudflare                  ║
echo  ║                                               ║
echo  ║   [6]  Estado de servicios                    ║
echo  ║   [7]  Detener todos los servicios            ║
echo  ║   [8]  Ver logs                               ║
echo  ║   [9]  Abrir dashboard en navegador           ║
echo  ║                                               ║
echo  ║   [0]  Salir                                  ║
echo  ║                                               ║
echo  ╚═══════════════════════════════════════════════╝
echo.
set /p "CHOICE=  Elige [0-9]: "

if "!CHOICE!"=="1" goto :START_ALL
if "!CHOICE!"=="2" goto :START_GATEWAY
if "!CHOICE!"=="3" goto :START_AGENT
if "!CHOICE!"=="4" goto :START_OLLAMA
if "!CHOICE!"=="5" goto :START_TUNNEL
if "!CHOICE!"=="6" goto :STATUS
if "!CHOICE!"=="7" goto :STOP_ALL
if "!CHOICE!"=="8" goto :VIEW_LOGS
if "!CHOICE!"=="9" goto :OPEN_BROWSER
if "!CHOICE!"=="0" goto :EXIT
goto :MENU


:: ── Acciones ───────────────────────────────────────────────────────────────

:START_ALL
echo.
echo  [FOLAX] Iniciando stack completo...
echo.
call :LAUNCH_OLLAMA
timeout /t 3 /nobreak >nul
call :LAUNCH_GATEWAY
timeout /t 2 /nobreak >nul
call :LAUNCH_AGENT
call :LAUNCH_TUNNEL
echo.
echo  ┌─────────────────────────────────────────────────┐
echo  │  Stack iniciado correctamente.                  │
echo  │  Dashboard:    http://localhost:8000            │
echo  │  Node Agent:   http://localhost:8765/metrics    │
echo  └─────────────────────────────────────────────────┘
echo.
pause
goto :MENU

:START_GATEWAY
call :LAUNCH_GATEWAY
echo  [OK] Gateway iniciado en http://localhost:8000
pause
goto :MENU

:START_AGENT
call :LAUNCH_AGENT
echo  [OK] Node Agent iniciado en http://localhost:8765
pause
goto :MENU

:START_OLLAMA
call :LAUNCH_OLLAMA
echo  [OK] Ollama iniciado en modo LAN (0.0.0.0:11434)
pause
goto :MENU

:START_TUNNEL
call :LAUNCH_TUNNEL
echo  [OK] Tunel Cloudflare iniciado.
pause
goto :MENU


:: ── Funciones de lanzamiento ────────────────────────────────────────────────

:LAUNCH_GATEWAY
echo  [>>] Iniciando Gateway (FastAPI)...
if not exist "logs" mkdir logs
if exist ".venv\Scripts\python.exe" (
    start "FOLAX-Gateway" /min cmd /k "cd /d "%~dp0" && .venv\Scripts\python.exe -m uvicorn core.gateway.app:app --host 0.0.0.0 --port 8000 2>&1 | tee logs\gateway.log"
) else (
    start "FOLAX-Gateway" /min cmd /k "cd /d "%~dp0" && uvicorn core.gateway.app:app --host 0.0.0.0 --port 8000 2>&1 | tee logs\gateway.log"
)
goto :EOF

:LAUNCH_AGENT
echo  [>>] Iniciando Node Agent...
if not exist "logs" mkdir logs
if exist ".venv\Scripts\python.exe" (
    start "FOLAX-Agent" /min cmd /k "cd /d "%~dp0" && .venv\Scripts\python.exe app\node_agent.py 2>&1 | tee logs\agent.log"
) else (
    start "FOLAX-Agent" /min cmd /k "cd /d "%~dp0" && python app\node_agent.py 2>&1 | tee logs\agent.log"
)
goto :EOF

:LAUNCH_OLLAMA
echo  [>>] Iniciando Ollama (modo LAN)...
set OLLAMA_HOST=0.0.0.0
start "FOLAX-Ollama" /min cmd /k "set OLLAMA_HOST=0.0.0.0 && ollama serve"
goto :EOF

:LAUNCH_TUNNEL
echo  [>>] Iniciando Cloudflare Tunnel...
if exist "cloudflared.exe" (
    start "FOLAX-Tunnel" /min cmd /k "cd /d "%~dp0" && cloudflared.exe tunnel run 2>&1 | tee logs\tunnel.log"
) else (
    echo  [!] cloudflared.exe no encontrado. Saltando tunel.
)
goto :EOF


:: ── Estado de servicios ────────────────────────────────────────────────────

:STATUS
cls
echo.
echo  [FOLAX] Estado de servicios (basado en puertos):
echo.

:: Gateway — puerto 8000
netstat -ano 2>nul | findstr ":8000 " >nul 2>&1
if !errorlevel! equ 0 (
    echo    [OK] Gateway     :8000  ACTIVO
) else (
    echo    [--] Gateway     :8000  INACTIVO
)

:: Node Agent — puerto 8765
netstat -ano 2>nul | findstr ":8765 " >nul 2>&1
if !errorlevel! equ 0 (
    echo    [OK] Node Agent  :8765  ACTIVO
) else (
    echo    [--] Node Agent  :8765  INACTIVO
)

:: Ollama — puerto 11434
netstat -ano 2>nul | findstr ":11434 " >nul 2>&1
if !errorlevel! equ 0 (
    echo    [OK] Ollama      :11434 ACTIVO
) else (
    echo    [--] Ollama      :11434 INACTIVO
)

:: Cloudflare
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find "cloudflared.exe" >nul 2>&1
if !errorlevel! equ 0 (
    echo    [OK] Cloudflare  Tunel  ACTIVO
) else (
    echo    [--] Cloudflare  Tunel  INACTIVO
)

echo.
pause
goto :MENU


:: ── Detener servicios ──────────────────────────────────────────────────────

:STOP_ALL
echo.
echo  [FOLAX] Deteniendo servicios...
taskkill /FI "WINDOWTITLE eq FOLAX-Gateway*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq FOLAX-Agent*"   /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq FOLAX-Ollama*"  /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq FOLAX-Tunnel*"  /F >nul 2>&1
echo  [OK] Señal de detención enviada.
echo.
pause
goto :MENU


:: ── Ver logs ────────────────────────────────────────────────────────────────

:VIEW_LOGS
cls
echo.
echo  [1] Gateway log     (logs\gateway.log)
echo  [2] Node Agent log  (logs\agent.log)
echo  [3] Tunnel log      (logs\tunnel.log)
echo  [0] Volver al menu
echo.
set /p "LOGCHOICE=  Elige: "

if "!LOGCHOICE!"=="1" (
    if exist logs\gateway.log (
        more logs\gateway.log
    ) else (
        echo  No hay log de gateway aun.
    )
)
if "!LOGCHOICE!"=="2" (
    if exist logs\agent.log (
        more logs\agent.log
    ) else (
        echo  No hay log de agent aun.
    )
)
if "!LOGCHOICE!"=="3" (
    if exist logs\tunnel.log (
        more logs\tunnel.log
    ) else (
        echo  No hay log de tunel aun.
    )
)
if "!LOGCHOICE!"=="0" goto :MENU
pause
goto :VIEW_LOGS


:: ── Abrir navegador ────────────────────────────────────────────────────────

:OPEN_BROWSER
start "" "http://localhost:8000"
goto :MENU


:: ── Salir ──────────────────────────────────────────────────────────────────

:EXIT
echo.
echo  Hasta pronto, FOLAX DTC.
echo.
timeout /t 2 /nobreak >nul
endlocal
exit /b 0
