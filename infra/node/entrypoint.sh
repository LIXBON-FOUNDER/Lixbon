#!/usr/bin/env bash
set -euo pipefail
: "${LIXBON_GATEWAY:?Falta LIXBON_GATEWAY (ej. https://lixbon.com)}"

ollama serve >/proc/1/fd/1 2>&1 &
for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
  sleep 1
done

exec python3 /opt/lixbon/agent.py
