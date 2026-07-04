#!/usr/bin/env bash
# Inicia Ollama con OLLAMA_HOST para que escuche en toda la red LAN.
# Para que arranque automáticamente al boot, agrégalo como servicio systemd
# o ponlo en /etc/rc.local

export OLLAMA_HOST=0.0.0.0:11434
ollama serve
