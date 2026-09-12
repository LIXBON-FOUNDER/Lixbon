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

ENV LIXBON_STATE_FILE=/var/lib/lixbon/node.json \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_URL=http://127.0.0.1:11434 \
    OLLAMA_KEEP_ALIVE=-1

VOLUME ["/var/lib/lixbon", "/root/.ollama"]
ENTRYPOINT ["/opt/lixbon/entrypoint.sh"]
