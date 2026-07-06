#!/usr/bin/env bash
# Inicia el túnel de Cloudflare hacia el gateway local (puerto 8000).
# Requiere que cloudflared esté autenticado previamente con:
#   cloudflared tunnel login
#   cloudflared tunnel create ollama-tunnel

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Descargar cloudflared si no existe en el PATH ni en el directorio actual
if ! command -v cloudflared &>/dev/null && [ ! -f "./cloudflared" ]; then
    echo "[INFO] Descargando cloudflared para Linux (amd64)..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
        -o cloudflared
    chmod +x cloudflared
fi

# Usar cloudflared del PATH o del directorio actual
CLOUDFLARED="cloudflared"
if ! command -v cloudflared &>/dev/null; then
    CLOUDFLARED="./cloudflared"
fi

echo
echo "=============================================================="
echo " Iniciando Túnel de Cloudflare hacia la API LAN (Puerto 8000)"
echo "=============================================================="
echo " Tu API estará disponible en: https://lixbon.com"
echo " Presiona CTRL+C para cerrar el túnel."
echo "=============================================================="
echo

"$CLOUDFLARED" tunnel --url http://localhost:8000 run ollama-tunnel
