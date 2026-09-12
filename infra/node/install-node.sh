#!/usr/bin/env bash
# Instalador de un nodo GPU de Lixbon (Linux). Lo sirve el gateway en /install-node.sh:
#   curl -fsSL https://lixbon.com/install-node.sh | LIXBON_ENROLL=<token> bash
# Deja Ollama + el node_agent corriendo en modo conexión (sin túnel ni puertos).
set -euo pipefail

GATEWAY="${LIXBON_GATEWAY:-__GATEWAY__}"
: "${LIXBON_ENROLL:?Falta LIXBON_ENROLL: genera un token en el panel admin (Nodos → Añadir GPU)}"

DIR=/opt/lixbon
ENV_FILE=/etc/lixbon/node.env
STATE=/var/lib/lixbon/node.json
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "▸ Lixbon node · gateway: $GATEWAY"
$SUDO mkdir -p "$DIR" /etc/lixbon /var/lib/lixbon

if ! command -v ollama >/dev/null 2>&1; then
  echo "▸ Instalando Ollama…"
  curl -fsSL https://ollama.com/install.sh | $SUDO sh
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "▸ Instalando python3…"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq python3 python3-pip
  else
    echo "No hay apt-get: instala python3 y pip a mano." >&2; exit 1
  fi
fi

echo "▸ Dependencias de Python…"
python3 -m pip install --quiet --break-system-packages "httpx>=0.27" psutil "websockets>=13" fastapi 2>/dev/null \
  || python3 -m pip install --quiet "httpx>=0.27" psutil "websockets>=13" fastapi

echo "▸ Descargando el agente…"
$SUDO curl -fsSL "$GATEWAY/node-agent.py" -o "$DIR/agent.py"

$SUDO tee "$ENV_FILE" >/dev/null <<EOF
LIXBON_GATEWAY=$GATEWAY
LIXBON_ENROLL=$LIXBON_ENROLL
LIXBON_STATE_FILE=$STATE
LIXBON_NODE_NAME=${LIXBON_NODE_NAME:-}
LIXBON_NODE_ID=${LIXBON_NODE_ID:-}
LIXBON_PROVIDER=${LIXBON_PROVIDER:-}
LIXBON_MODELS=${LIXBON_MODELS:-}
OLLAMA_URL=${OLLAMA_URL:-http://127.0.0.1:11434}
EOF
$SUDO chmod 600 "$ENV_FILE"

if ! curl -fs http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && $SUDO systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    $SUDO systemctl enable --now ollama >/dev/null 2>&1 || true
  else
    nohup ollama serve >/var/log/lixbon-ollama.log 2>&1 &
  fi
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  $SUDO tee /etc/systemd/system/lixbon-node.service >/dev/null <<EOF
[Unit]
Description=Lixbon node agent
After=network-online.target ollama.service
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $DIR/agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now lixbon-node
  echo "▸ Servicio lixbon-node activo. Logs: journalctl -u lixbon-node -f"
else
  # Contenedores sin systemd (RunPod, Vast): proceso en background con log
  set -a; . "$ENV_FILE"; set +a
  nohup python3 "$DIR/agent.py" >/var/log/lixbon-node.log 2>&1 &
  echo "▸ Agente lanzado en background. Log: /var/log/lixbon-node.log"
fi

echo "✓ Listo. El nodo aparecerá en el panel en unos segundos."
