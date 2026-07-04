#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
#   FOLAX DTC v2.0 — Lanzador Unificado Linux/macOS
#   Reemplaza start_all.sh y scripts individuales
# ═══════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$SCRIPT_DIR/.folax.pids"

# ── Colores ANSI ───────────────────────────────────────────────────────────
GREEN="\e[32m"; YELLOW="\e[33m"; RED="\e[31m"; CYAN="\e[36m"; BOLD="\e[1m"; RESET="\e[0m"

# ── Python y venv ─────────────────────────────────────────────────────────
if [ -f ".venv/bin/python" ]; then
    PY=".venv/bin/python"
elif command -v python3 &>/dev/null; then
    PY="python3"
else
    PY="python"
fi

UVICORN="uvicorn"
if [ -f ".venv/bin/uvicorn" ]; then
    UVICORN=".venv/bin/uvicorn"
fi

mkdir -p "$LOG_DIR"

# ─────────────────────────────────────────────────────────────────────────
banner() {
    echo ""
    echo -e "${CYAN}${BOLD} ╔═══════════════════════════════════════════╗${RESET}"
    echo -e "${CYAN}${BOLD} ║    F O L A X   D T C   v2.0              ║${RESET}"
    echo -e "${CYAN}${BOLD} ║    Data & Task Center — Launcher          ║${RESET}"
    echo -e "${CYAN}${BOLD} ╚═══════════════════════════════════════════╝${RESET}"
    echo ""
}

# ─────────────────────────────────────────────────────────────────────────
launch_gateway() {
    echo -e " ${CYAN}[>>]${RESET} Iniciando Gateway (FastAPI :8000)..."
    nohup $UVICORN core.gateway.app:app --host 0.0.0.0 --port 8000 \
        > "$LOG_DIR/gateway.log" 2>&1 &
    echo $! >> "$PID_FILE"
    sleep 1
    echo -e " ${GREEN}[OK]${RESET} Gateway iniciado. PID=$!"
}

launch_agent() {
    echo -e " ${CYAN}[>>]${RESET} Iniciando Node Agent (:8765)..."
    nohup $PY core/node_agent/agent.py \
        > "$LOG_DIR/agent.log" 2>&1 &
    echo $! >> "$PID_FILE"
    sleep 1
    echo -e " ${GREEN}[OK]${RESET} Node Agent iniciado. PID=$!"
}

launch_ollama() {
    echo -e " ${CYAN}[>>]${RESET} Iniciando Ollama (modo LAN 0.0.0.0:11434)..."
    OLLAMA_HOST=0.0.0.0 nohup ollama serve \
        > "$LOG_DIR/ollama.log" 2>&1 &
    echo $! >> "$PID_FILE"
    sleep 2
    echo -e " ${GREEN}[OK]${RESET} Ollama iniciado. PID=$!"
}

launch_tunnel() {
    if command -v cloudflared &>/dev/null; then
        echo -e " ${CYAN}[>>]${RESET} Iniciando Cloudflare Tunnel..."
        nohup cloudflared tunnel run \
            > "$LOG_DIR/tunnel.log" 2>&1 &
        echo $! >> "$PID_FILE"
        echo -e " ${GREEN}[OK]${RESET} Tunnel iniciado. PID=$!"
    else
        echo -e " ${YELLOW}[!]${RESET}  cloudflared no encontrado. Saltando tunnel."
    fi
}

# ── Health checks ──────────────────────────────────────────────────────────
check_port() {
    local port="$1"
    ss -tlnp 2>/dev/null | grep -q ":$port " || \
    netstat -tlnp 2>/dev/null | grep -q ":$port " || \
    lsof -i ":$port" &>/dev/null
}

status() {
    banner
    echo -e " Estado de servicios:"
    echo ""
    check_port 8000 && echo -e "   ${GREEN}●${RESET} Gateway     :8000  ACTIVO" \
                     || echo -e "   ${RED}○${RESET} Gateway     :8000  INACTIVO"
    check_port 8765 && echo -e "   ${GREEN}●${RESET} Node Agent  :8765  ACTIVO" \
                     || echo -e "   ${RED}○${RESET} Node Agent  :8765  INACTIVO"
    check_port 11434 && echo -e "   ${GREEN}●${RESET} Ollama      :11434 ACTIVO" \
                      || echo -e "   ${RED}○${RESET} Ollama      :11434 INACTIVO"
    echo ""
}

stop_all() {
    echo -e " ${YELLOW}[>>]${RESET} Deteniendo servicios FOLAX DTC..."
    if [ -f "$PID_FILE" ]; then
        while IFS= read -r pid; do
            [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo -e "    Detenido PID $pid" || true
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    echo -e " ${GREEN}[OK]${RESET} Servicios detenidos."
}

logs_stream() {
    echo -e " ${CYAN}[>>]${RESET} Mostrando logs en tiempo real (Ctrl+C para salir)..."
    tail -f "$LOG_DIR"/*.log 2>/dev/null || echo "No hay logs todavía."
}

# ─────────────────────────────────────────────────────────────────────────
# Modo CLI: ./folax.sh [start|stop|restart|status|logs|gateway|agent]
# ─────────────────────────────────────────────────────────────────────────
CMD="${1:-menu}"

case "$CMD" in
    start|all)
        banner
        > "$PID_FILE"
        launch_ollama
        sleep 2
        launch_gateway
        sleep 1
        launch_agent
        launch_tunnel
        echo ""
        echo -e " ${BOLD}Stack FOLAX DTC iniciado.${RESET}"
        echo -e " Dashboard:  ${CYAN}http://localhost:8000${RESET}"
        echo -e " Node Agent: ${CYAN}http://localhost:8765/metrics${RESET}"
        echo ""
        ;;
    stop)
        stop_all
        ;;
    restart)
        stop_all
        sleep 2
        > "$PID_FILE"
        launch_ollama
        sleep 2
        launch_gateway
        sleep 1
        launch_agent
        launch_tunnel
        ;;
    status)
        status
        ;;
    logs)
        logs_stream
        ;;
    gateway)
        launch_gateway
        ;;
    agent)
        launch_agent
        ;;
    ollama)
        launch_ollama
        ;;
    tunnel)
        launch_tunnel
        ;;
    menu|*)
        while true; do
            banner
            echo -e "   ${BOLD}[1]${RESET}  Iniciar stack completo"
            echo -e "   ${BOLD}[2]${RESET}  Solo Gateway    (:8000)"
            echo -e "   ${BOLD}[3]${RESET}  Solo Node Agent (:8765)"
            echo -e "   ${BOLD}[4]${RESET}  Solo Ollama LAN (:11434)"
            echo -e "   ${BOLD}[5]${RESET}  Solo Cloudflare Tunnel"
            echo ""
            echo -e "   ${BOLD}[6]${RESET}  Estado de servicios"
            echo -e "   ${BOLD}[7]${RESET}  Detener todos"
            echo -e "   ${BOLD}[8]${RESET}  Ver logs en tiempo real"
            echo ""
            echo -e "   ${BOLD}[0]${RESET}  Salir"
            echo ""
            read -r -p "  Elige [0-8]: " CHOICE
            case "$CHOICE" in
                1) > "$PID_FILE"; launch_ollama; sleep 2; launch_gateway; sleep 1; launch_agent; launch_tunnel; read -r -p "  Presiona ENTER para continuar..." ;;
                2) launch_gateway; read -r -p "  Presiona ENTER para continuar..." ;;
                3) launch_agent; read -r -p "  Presiona ENTER para continuar..." ;;
                4) launch_ollama; read -r -p "  Presiona ENTER para continuar..." ;;
                5) launch_tunnel; read -r -p "  Presiona ENTER para continuar..." ;;
                6) status; read -r -p "  Presiona ENTER para continuar..." ;;
                7) stop_all; read -r -p "  Presiona ENTER para continuar..." ;;
                8) logs_stream ;;
                0) echo -e "\n Hasta pronto, FOLAX DTC.\n"; exit 0 ;;
                *) echo -e " ${YELLOW}Opción no válida.${RESET}" ;;
            esac
        done
        ;;
esac
