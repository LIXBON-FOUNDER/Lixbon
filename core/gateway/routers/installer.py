"""
installer.py — Endpoints para distribución del CLI de lixbon DTC.
Sirve scripts de instalación para Linux/macOS y Windows,
y el archivo client_cli.py descargable.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse

from core.config import CLI_SOURCE_PATH

router = APIRouter()


@router.get("/install/client_cli.py")
async def download_cli() -> FileResponse:
    """Descarga el archivo client_cli.py (CLI de lixbon DTC)."""
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
    server_base = str(request.base_url).rstrip("/")
    script = f"""#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${{1:-{server_base}}}"
INSTALL_DIR="${{HOME}}/.lixbon"
BIN_DIR="${{HOME}}/.local/bin"
CLI_FILE="${{INSTALL_DIR}}/client_cli.py"
LAUNCHER_FILE="${{BIN_DIR}}/lixbon"

echo "╔══════════════════════════════════════╗"
echo "║   Instalando lixbon DTC CLI...        ║"
echo "╚══════════════════════════════════════╝"
echo ""

mkdir -p "${{INSTALL_DIR}}" "${{BIN_DIR}}"
curl -fsSL "${{SERVER_URL}}/install/client_cli.py" -o "${{CLI_FILE}}"
chmod +x "${{CLI_FILE}}"
python3 "${{CLI_FILE}}" init --base-url "${{SERVER_URL}}/v1" >/dev/null 2>&1 || true

cat > "${{LAUNCHER_FILE}}" <<'LAUNCHER'
#!/usr/bin/env bash
python3 "${{HOME}}/.lixbon/client_cli.py" "$@"
LAUNCHER
chmod +x "${{LAUNCHER_FILE}}"

for profile in "${{HOME}}/.bashrc" "${{HOME}}/.zshrc" "${{HOME}}/.profile"; do
  if [ -f "$profile" ] && ! grep -q '\\.local/bin' "$profile"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
  fi
done

echo ""
echo "✓ CLI instalado en: ${{CLI_FILE}}"
echo "✓ Comando creado:   ${{LAUNCHER_FILE}}"
echo ""
echo "Uso:"
echo "  lixbon setup   — Configuración inicial"
echo "  lixbon chat    — Chat interactivo"
echo "  lixbon status  — Estado del gateway"
echo ""
echo "Si 'lixbon' no se reconoce en la sesión actual, ejecuta:"
echo "  export PATH=\\"\\$HOME/.local/bin:\\$PATH\\""
"""
    return PlainTextResponse(content=script)


@router.get("/install.ps1")
async def install_script_windows(request: Request) -> PlainTextResponse:
    """Genera un script PowerShell de instalación del CLI para Windows."""
    server_base = str(request.base_url).rstrip("/")
    script = f"""$ErrorActionPreference = "Stop"

$ServerUrl = if ($args.Count -gt 0 -and $args[0]) {{ $args[0] }} else {{ "{server_base}" }}
$InstallDir = Join-Path $env:USERPROFILE ".lixbon"
$CliFile = Join-Path $InstallDir "client_cli.py"
$LauncherFile = Join-Path $InstallDir "lixbon.cmd"

Write-Host ""
Write-Host "╔══════════════════════════════════════╗"
Write-Host "║   Instalando lixbon DTC CLI...        ║"
Write-Host "╚══════════════════════════════════════╝"
Write-Host ""

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$ServerUrl/install/client_cli.py" -OutFile $CliFile
python $CliFile init --base-url "$ServerUrl/v1" | Out-Null

@"
@echo off
python "%USERPROFILE%\\.lixbon\\client_cli.py" %*
"@ | Set-Content -Path $LauncherFile -Encoding Ascii

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) {{ $userPath = "" }}
if ($userPath -notlike "*$InstallDir*") {{
  $newPath = if ($userPath) {{ "$userPath;$InstallDir" }} else {{ $InstallDir }}
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "✓ Agregado al PATH de usuario: $InstallDir"
}} else {{
  Write-Host "✓ El PATH de usuario ya contiene: $InstallDir"
}}

Write-Host ""
Write-Host "✓ CLI instalado en: $CliFile"
Write-Host "✓ Comando creado:   lixbon"
Write-Host ""
Write-Host "Uso (abre una nueva terminal):"
Write-Host "  lixbon setup"
Write-Host "  lixbon chat"
Write-Host "  lixbon status"
"""
    return PlainTextResponse(content=script)
