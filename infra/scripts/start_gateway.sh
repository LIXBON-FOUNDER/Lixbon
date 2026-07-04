#!/usr/bin/env bash
# Inicia el Gateway LAN LLM (FastAPI + uvicorn).
# Ajusta PROJECT_DIR a la ruta donde clonaste/copiaste el proyecto en Ubuntu.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Activar entorno virtual si existe
if [ -f ".venv/bin/activate" ]; then
    source ".venv/bin/activate"
fi

# Iniciar el gateway en primer plano (quita el & si quieres que bloquee la terminal)
uvicorn core.gateway.app:app --host 0.0.0.0 --port 8000
