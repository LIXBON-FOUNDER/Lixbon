"""Scripts de instalación del CLI Go (`/install.sh` e `/install.ps1`).

El gateway embebe en cada script la URL y el SHA-256 de los binarios que tiene
registrados; el script solo instala si el archivo descargado coincide con ese
digest y con el SHA256SUMS publicado junto al archivo en la release.
"""
from __future__ import annotations

import re

_URL_RE = re.compile(r"https://[A-Za-z0-9._~:/?=&%\-]+")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_VERSION_RE = re.compile(r"[A-Za-z0-9._-]+")


def _assets(release: dict) -> dict[str, dict]:
    """Solo se embebe lo que pasa la validación del registro, así nada raro
    llega al script aunque la fila de la BD se hubiera tocado a mano."""
    return {
        platform: asset for platform, asset in release["assets"].items()
        if _URL_RE.fullmatch(asset["url"]) and _SHA256_RE.fullmatch(asset["sha256"])
    }


def _check_version(release: dict) -> str:
    version = release["version"]
    if not _VERSION_RE.fullmatch(version):
        raise ValueError("versión inválida")
    return version


_SH = r"""#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${1:-__SERVER__}"
VERSION="__VERSION__"
BIN_DIR="${HOME}/.local/bin"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RESET=$'\033[0m'

fail() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

printf '\n  %sLixbon CLI%s\n' "$BOLD" "$RESET"
printf '  %sInstalador para Linux y macOS%s\n\n' "$DIM" "$RESET"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "Sistema no soportado: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "Arquitectura no soportada: $(uname -m)" ;;
esac

case "${os}-${arch}" in
__CASES__
  *) fail "No hay binario publicado para ${os}-${arch}" ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
asset="${URL##*/}"

printf '  %sDescargando lixbon %s (%s-%s)...%s\n' "$DIM" "$VERSION" "$os" "$arch" "$RESET"
curl -fsSL "$URL" -o "$tmp/$asset" || fail "No se pudo descargar $URL"
actual="$(sha256_of "$tmp/$asset")"
[ "$actual" = "$SHA" ] || fail "El SHA-256 del archivo no coincide con el del servidor. No se instaló nada."
published="$(curl -fsSL "${URL%/*}/SHA256SUMS" | awk -v n="$asset" '$2 == n || $2 == "*" n { print $1 }')" || published=""
[ "$actual" = "$published" ] || fail "El SHA-256 del archivo no coincide con SHA256SUMS de la release. No se instaló nada."

tar -xzf "$tmp/$asset" -C "$tmp"
binary="$(find "$tmp" -type f -name lixbon | head -n 1)"
[ -n "$binary" ] || fail "El archivo descargado no contiene el binario."

mkdir -p "$BIN_DIR"
cp "$binary" "$BIN_DIR/.lixbon.new"
chmod 755 "$BIN_DIR/.lixbon.new"
mv -f "$BIN_DIR/.lixbon.new" "$BIN_DIR/lixbon"
rm -f "${HOME}/.lixbon/client_cli.py"
"$BIN_DIR/lixbon" init --base-url "${SERVER_URL}/v1" >/dev/null 2>&1 || true

PATH_NOTE="ya configurado"
for profile in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
  if [ -f "$profile" ] && ! grep -q '\.local/bin' "$profile"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
    PATH_NOTE="añadido a ${BIN_DIR}"
  fi
done

printf '\n  %sListo%s\n\n' "$GREEN" "$RESET"
printf '    Versión    %s\n' "$VERSION"
printf '    Comando    %s\n' "$BIN_DIR/lixbon"
printf '    PATH       %s\n' "$PATH_NOTE"
printf '\n  %sPara empezar, abre una terminal nueva:%s\n\n' "$DIM" "$RESET"
printf '    lixbon setup     %sconfiguración inicial%s\n' "$DIM" "$RESET"
printf '    lixbon chat      %schat interactivo%s\n' "$DIM" "$RESET"
printf '    lixbon update    %sactualizar a la última versión%s\n\n' "$DIM" "$RESET"
printf '  %sSi el comando no se reconoce:%s export PATH="$HOME/.local/bin:$PATH"\n\n' "$DIM" "$RESET"
"""

_PS1 = r"""$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ServerUrl = if ($args.Count -gt 0 -and $args[0]) { $args[0] } else { "__SERVER__" }
$Version = "__VERSION__"
$InstallDir = Join-Path $env:USERPROFILE ".lixbon"
$Exe = Join-Path $InstallDir "lixbon.exe"

$Assets = @{
__ENTRIES__
}

function Fail($message) {
  Write-Host ""
  Write-Host "  $message" -ForegroundColor Red
  Write-Host ""
  throw $message
}

Write-Host ""
Write-Host "  Lixbon CLI" -ForegroundColor White
Write-Host "  Instalador para Windows" -ForegroundColor DarkGray
Write-Host ""

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "amd64" }
  "ARM64" { "arm64" }
  default { Fail "Arquitectura no soportada: $($env:PROCESSOR_ARCHITECTURE)" }
}
$platform = "windows-$arch"
if (-not $Assets.ContainsKey($platform)) { Fail "No hay binario publicado para $platform" }
$asset = $Assets[$platform]
$name = $asset.Url.Substring($asset.Url.LastIndexOf("/") + 1)

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("lixbon-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp $name
  Write-Host "  Descargando lixbon $Version ($platform)..." -ForegroundColor DarkGray
  Invoke-WebRequest -Uri $asset.Url -OutFile $zip -UseBasicParsing

  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $asset.Sha) { Fail "El SHA-256 del archivo no coincide con el del servidor. No se instaló nada." }
  $sumsUrl = $asset.Url.Substring(0, $asset.Url.LastIndexOf("/")) + "/SHA256SUMS"
  $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $published = $null
  foreach ($line in ($sums -split "`n")) {
    $fields = $line.Trim() -split "\s+"
    if ($fields.Count -eq 2 -and $fields[1].TrimStart("*") -eq $name) { $published = $fields[0].ToLower() }
  }
  if ($actual -ne $published) { Fail "El SHA-256 del archivo no coincide con SHA256SUMS de la release. No se instaló nada." }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $binary = Get-ChildItem -Path $tmp -Recurse -Filter "lixbon.exe" | Select-Object -First 1
  if (-not $binary) { Fail "El archivo descargado no contiene el binario." }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if (Test-Path $Exe) {
    Remove-Item "$Exe.old" -Force -ErrorAction SilentlyContinue
    Move-Item -Path $Exe -Destination "$Exe.old" -Force
  }
  Copy-Item -Path $binary.FullName -Destination $Exe -Force
  Remove-Item "$Exe.old" -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Remove-Item (Join-Path $InstallDir "lixbon.cmd") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $InstallDir "client_cli.py") -Force -ErrorAction SilentlyContinue
& $Exe init --base-url "$ServerUrl/v1" | Out-Null

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
if ($userPath -notlike "*$InstallDir*") {
  $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $pathNote = "añadido a $InstallDir"
} else {
  $pathNote = "ya configurado"
}

Write-Host ""
Write-Host "  Listo" -ForegroundColor Green
Write-Host ""
Write-Host "    Versión    $Version"
Write-Host "    Comando    $Exe"
Write-Host "    PATH       $pathNote"
Write-Host ""
Write-Host "  Para empezar, abre una terminal nueva:" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    lixbon setup     " -NoNewline
Write-Host "configuración inicial" -ForegroundColor DarkGray
Write-Host "    lixbon chat      " -NoNewline
Write-Host "chat interactivo" -ForegroundColor DarkGray
Write-Host "    lixbon update    " -NoNewline
Write-Host "actualizar a la última versión" -ForegroundColor DarkGray
Write-Host ""
"""


def install_sh(server_base: str, release: dict) -> str:
    cases = "\n".join(
        f"  {platform}) URL='{asset['url']}'; SHA='{asset['sha256']}' ;;"
        for platform, asset in _assets(release).items() if not platform.startswith("windows")
    )
    return (_SH.replace("__SERVER__", server_base).replace("__VERSION__", _check_version(release))
            .replace("__CASES__", cases))


def install_ps1(server_base: str, release: dict) -> str:
    entries = "\n".join(
        f'  "{platform}" = @{{ Url = "{asset["url"]}"; Sha = "{asset["sha256"]}" }}'
        for platform, asset in _assets(release).items() if platform.startswith("windows")
    )
    return (_PS1.replace("__SERVER__", server_base).replace("__VERSION__", _check_version(release))
            .replace("__ENTRIES__", entries))
