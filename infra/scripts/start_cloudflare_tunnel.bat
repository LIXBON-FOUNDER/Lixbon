@echo off
setlocal

:: Cambia al directorio del script
cd /d "%~dp0"

:: Descargar cloudflared si no existe
if not exist "cloudflared.exe" (
    echo [INFO] Descargando Cloudflared de los servidores oficiales...
    curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -o cloudflared.exe
    if not exist "cloudflared.exe" (
        echo [ERROR] No se pudo descargar cloudflared.exe.
        pause
        exit /b 1
    )
)

echo.
echo ==============================================================
echo Iniciando Tunel de Cloudflare hacia tu API LAN (Puerto 8000)
echo ==============================================================
echo.
echo Tu API estara disponible de forma fija en: https://datacentgbx.online
echo.
echo Presiona CTRL+C en esta ventana cuando quieras cerrar el tunel.
echo ==============================================================
echo.

:: Ejecuta el tunel nombrado hacia localhost:8000
cloudflared.exe tunnel --url http://localhost:8000 run ollama-tunnel

pause
