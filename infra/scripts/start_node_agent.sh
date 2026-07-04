#!/usr/bin/env bash
# Ejecuta node_agent.py desde la misma carpeta donde está este script.
# Compatible con cualquier usuario y ruta de instalación.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

python3 "$SCRIPT_DIR/node_agent.py"
