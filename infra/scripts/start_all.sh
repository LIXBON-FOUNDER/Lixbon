#!/usr/bin/env bash
# Script maestro: arranca todos los servicios del stack LAN LLM en Ubuntu.
# Lanza cada servicio en segundo plano dentro de una sesión tmux separada,
# o en background simple si tmux no está disponible.
#
# Uso:
#   chmod +x start_all.sh
#   ./start_all.sh
#
# Para detener todo:
#   ./start_all.sh stop

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PIDS_FILE="$SCRIPT_DIR/.running_pids"

# ── Función: mostrar ayuda ───────────────────────────────────────────────────
usage() {
    echo "Uso: $0 [start|stop|status]"
    echo "  start   (default) Inicia todos los servicios"
    echo "  stop              Detiene todos los servicios iniciados"
    echo "  status            Muestra si los procesos están corriendo"
}

# ── Función: detener servicios ───────────────────────────────────────────────
stop_services() {
    if [ ! -f "$PIDS_FILE" ]; then
        echo "[INFO] No hay servicios registrados para detener."
        return
    fi
    echo "[INFO] Deteniendo servicios..."
    while IFS= read -r pid; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" && echo "  -> PID $pid detenido"
        fi
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
    echo "[OK] Todos los servicios detenidos."
}

# ── Función: mostrar estado ──────────────────────────────────────────────────
status_services() {
    if [ ! -f "$PIDS_FILE" ]; then
        echo "[INFO] No hay servicios registrados."
        return
    fi
    echo "Estado de servicios:"
    while IFS= read -r pid; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "  PID $pid → ACTIVO"
        else
            echo "  PID $pid → INACTIVO"
        fi
    done < "$PIDS_FILE"
}

# ── Función: lanzar un servicio en background ────────────────────────────────
launch() {
    local nombre="$1"
    local script="$2"
    echo "[START] $nombre..."
    bash "$SCRIPT_DIR/$script" >> "$SCRIPT_DIR/${nombre}.log" 2>&1 &
    local pid=$!
    echo "$pid" >> "$PIDS_FILE"
    echo "  -> PID $pid | Log: ${nombre}.log"
}

# ── Punto de entrada ─────────────────────────────────────────────────────────
ACTION="${1:-start}"

case "$ACTION" in
    stop)
        stop_services
        exit 0
        ;;
    status)
        status_services
        exit 0
        ;;
    start)
        ;;
    *)
        usage
        exit 1
        ;;
esac

# Limpiar registro anterior
rm -f "$PIDS_FILE"

echo
echo "======================================================"
echo "   LAN LLM Stack — Iniciando servicios en Ubuntu"
echo "======================================================"
echo

# 1. Ollama con red LAN
launch "ollama" "start_ollama_lan.sh"
sleep 2   # Dar tiempo a que Ollama levante antes del gateway

# 2. Gateway FastAPI
launch "gateway" "start_gateway.sh"
sleep 1

# 3. Agente de nodo (si existe node_agent.py)
if [ -f "$SCRIPT_DIR/node_agent.py" ]; then
    launch "node_agent" "start_node_agent.sh"
fi

# 4. Túnel Cloudflare
launch "cloudflare_tunnel" "start_cloudflare_tunnel.sh"

echo
echo "[OK] Todos los servicios iniciados."
echo "     Para ver logs: tail -f <nombre>.log"
echo "     Para detener:  ./start_all.sh stop"
echo "     Para estado:   ./start_all.sh status"
echo
