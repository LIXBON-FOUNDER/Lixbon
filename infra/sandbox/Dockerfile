# Imagen del entorno aislado de una sesión de Coding en la nube.
#
# Corre `lixbon host`: el CLI de Lixbon sin interfaz, haciendo de host de una
# sesión /remote. No tiene pantalla: el agente ve las interfaces con Chromium
# headless. Sin root; el contenedor se lanza además con --cap-drop ALL,
# no-new-privileges, rootfs de solo lectura y en una red sin salida directa
# (ver core/sandbox/runner.py). El binario `lixbon` (linux/amd64) lo deja
# infra/scripts/sandbox-build.ps1 en infra/sandbox/bin/.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LIXBON_BROWSER_NO_SANDBOX=1 \
    LIXBON_BROWSER=/usr/bin/chromium \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq less procps unzip xz-utils \
      nodejs npm python3 python3-pip python3-venv \
      chromium fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g corepack@0.31.0 && corepack enable \
 && useradd -m -u 1000 -s /bin/bash lixbon \
 && mkdir -p /workspace && chown lixbon:lixbon /workspace

# git: identidad del agente; el remoto real lo fija `lixbon host` al clonar.
RUN git config --system user.name "Lixbon" \
 && git config --system user.email "agente@lixbon.com" \
 && git config --system init.defaultBranch main \
 && git config --system advice.detachedHead false

COPY bin/lixbon /usr/local/bin/lixbon
RUN chmod 0755 /usr/local/bin/lixbon

USER lixbon
WORKDIR /workspace
EXPOSE 7000
ENTRYPOINT ["/usr/local/bin/lixbon", "host"]
