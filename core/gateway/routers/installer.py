"""
installer.py — Endpoints de distribución del Lixbon CLI.
Sirve los scripts de instalación para Linux/macOS y Windows,
y el archivo client_cli.py descargable.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse

from core.config import CLI_SOURCE_PATH, PUBLIC_BASE_URL

router = APIRouter()


def _server_base(request: Request) -> str:
    """Base pública para los scripts generados. Preferimos PUBLIC_BASE_URL:
    request.base_url depende de la cabecera Host (manipulable) y detrás del
    proxy llega como http://."""
    return (PUBLIC_BASE_URL or str(request.base_url)).rstrip("/")


@router.get("/install/client_cli.py")
async def download_cli() -> FileResponse:
    """Descarga el archivo client_cli.py (Lixbon CLI)."""
    if not CLI_SOURCE_PATH.exists():
        raise HTTPException(status_code=404, detail="client_cli.py no encontrado en el servidor")
    return FileResponse(
        path=str(CLI_SOURCE_PATH),
        media_type="text/x-python",
        filename="client_cli.py",
    )


@router.get("/install.sh")
async def install_script(request: Request) -> PlainTextResponse:
    """Genera un script bash de instalación del CLI para Linux/macOS."""
    server_base = _server_base(request)
    # rf-string: los \n y \033 tienen que llegar LITERALES al script; si Python
    # los interpretara, printf recibiría saltos de línea reales y se rompería.
    script = rf"""#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${{1:-{server_base}}}"
INSTALL_DIR="${{HOME}}/.lixbon"
BIN_DIR="${{HOME}}/.local/bin"
CLI_FILE="${{INSTALL_DIR}}/client_cli.py"
LAUNCHER_FILE="${{BIN_DIR}}/lixbon"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RESET=$'\033[0m'

printf '\n  %sLixbon CLI%s\n' "$BOLD" "$RESET"
printf '  %sInstalador para Linux y macOS%s\n\n' "$DIM" "$RESET"
printf '  %sDescargando el CLI...%s\n' "$DIM" "$RESET"

mkdir -p "${{INSTALL_DIR}}" "${{BIN_DIR}}"
curl -fsSL "${{SERVER_URL}}/install/client_cli.py" -o "${{CLI_FILE}}"
chmod +x "${{CLI_FILE}}"
python3 "${{CLI_FILE}}" init --base-url "${{SERVER_URL}}/v1" >/dev/null 2>&1 || true

cat > "${{LAUNCHER_FILE}}" <<'LAUNCHER'
#!/usr/bin/env bash
python3 "${{HOME}}/.lixbon/client_cli.py" "$@"
LAUNCHER
chmod +x "${{LAUNCHER_FILE}}"

PATH_NOTE="ya configurado"
for profile in "${{HOME}}/.bashrc" "${{HOME}}/.zshrc" "${{HOME}}/.profile"; do
  if [ -f "$profile" ] && ! grep -q '\.local/bin' "$profile"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
    PATH_NOTE="añadido a ${{BIN_DIR}}"
  fi
done

printf '\n  %sListo%s\n\n' "$GREEN" "$RESET"
printf '    CLI        %s\n' "${{CLI_FILE}}"
printf '    Comando    %s\n' "lixbon"
printf '    PATH       %s\n' "${{PATH_NOTE}}"
printf '\n  %sPara empezar, abre una terminal nueva:%s\n\n' "$DIM" "$RESET"
printf '    lixbon setup     %sconfiguración inicial%s\n' "$DIM" "$RESET"
printf '    lixbon chat      %schat interactivo%s\n' "$DIM" "$RESET"
printf '    lixbon status    %sestado del gateway%s\n\n' "$DIM" "$RESET"
printf '  %sSi el comando no se reconoce:%s export PATH="$HOME/.local/bin:$PATH"\n\n' "$DIM" "$RESET"
"""
    return PlainTextResponse(content=script)


@router.get("/install.ps1")
async def install_script_windows(request: Request) -> PlainTextResponse:
    """Genera un script PowerShell de instalación del CLI para Windows."""
    server_base = _server_base(request)
    # Los acentos viajan bien (existen en cp437/850), pero los checks y los
    # guiones largos NO: la consola de Windows los degrada a otro glifo.
    script = rf"""$ErrorActionPreference = "Stop"

$ServerUrl = if ($args.Count -gt 0 -and $args[0]) {{ $args[0] }} else {{ "{server_base}" }}
$InstallDir = Join-Path $env:USERPROFILE ".lixbon"
$CliFile = Join-Path $InstallDir "client_cli.py"
$LauncherFile = Join-Path $InstallDir "lixbon.cmd"

Write-Host ""
Write-Host "  Lixbon CLI" -ForegroundColor White
Write-Host "  Instalador para Windows" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Descargando el CLI..." -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$ServerUrl/install/client_cli.py" -OutFile $CliFile
python $CliFile init --base-url "$ServerUrl/v1" | Out-Null

@"
@echo off
python "%USERPROFILE%\.lixbon\client_cli.py" %*
"@ | Set-Content -Path $LauncherFile -Encoding Ascii

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) {{ $userPath = "" }}
if ($userPath -notlike "*$InstallDir*") {{
  $newPath = if ($userPath) {{ "$userPath;$InstallDir" }} else {{ $InstallDir }}
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $pathNote = "añadido a $InstallDir"
}} else {{
  $pathNote = "ya configurado"
}}

Write-Host ""
Write-Host "  Listo" -ForegroundColor Green
Write-Host ""
Write-Host "    CLI        $CliFile"
Write-Host "    Comando    lixbon"
Write-Host "    PATH       $pathNote"
Write-Host ""
Write-Host "  Para empezar, abre una terminal nueva:" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    lixbon setup     " -NoNewline
Write-Host "configuración inicial" -ForegroundColor DarkGray
Write-Host "    lixbon chat      " -NoNewline
Write-Host "chat interactivo" -ForegroundColor DarkGray
Write-Host "    lixbon status    " -NoNewline
Write-Host "estado del gateway" -ForegroundColor DarkGray
Write-Host ""
"""
    return PlainTextResponse(content=script)
