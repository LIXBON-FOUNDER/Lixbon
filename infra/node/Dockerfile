# Imagen de nodo GPU de Lixbon: Ollama + node_agent en modo conexión.
# Pensada para GPUs alquiladas (RunPod, Vast, Lambda…): solo necesita salida a internet.
#
#   docker build -f infra/node/Dockerfile -t ghcr.io/<org>/lixbon-node .
#   docker run --gpus all -e LIXBON_GATEWAY=https://lixbon.com -e LIXBON_ENROLL=<token> \
#              -e LIXBON_MODELS=qwen3:8b -v lixbon-node:/var/lib/lixbon -v ollama:/root/.ollama ghcr.io/<org>/lixbon-node
FROM ollama/ollama:latest

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages "httpx>=0.27" psutil "websockets>=13" fastapi

WORKDIR /opt/lixbon
COPY core/node_agent/agent.py ./agent.py
COPY infra/node/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

# Flash attention + caché KV en 8 bits: la mitad de VRAM por token de contexto,
# imprescindible para ventanas grandes. El num_ctx efectivo lo manda el gateway
# (MODEL_NUM_CTX); OLLAMA_CONTEXT_LENGTH es solo el default si no lo manda.
# NUM_PARALLEL: peticiones simultáneas por modelo en la GPU; cada slot reserva
# su caché KV. 4 es prudente para 24 GB; en 80 GB súbelo desde la plantilla.
# MAX_LOADED_MODELS=3: chat + embed + vision residentes, sin recargas.
ENV LIXBON_STATE_FILE=/var/lib/lixbon/node.json \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_URL=http://127.0.0.1:11434 \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_FLASH_ATTENTION=1 \
    OLLAMA_KV_CACHE_TYPE=q8_0 \
    OLLAMA_CONTEXT_LENGTH=32768 \
    OLLAMA_NUM_PARALLEL=4 \
    OLLAMA_MAX_LOADED_MODELS=3

VOLUME ["/var/lib/lixbon", "/root/.ollama"]
ENTRYPOINT ["/opt/lixbon/entrypoint.sh"]
