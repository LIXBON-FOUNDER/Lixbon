# Worker de render de Visuals (HTML → PNG/MP4). Servicio aparte del gateway:
# comparte DATABASE_URL y toma trabajos de la tabla visual_render_jobs.
# La etiqueta de la imagen debe coincidir con la versión de playwright de abajo.
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/lixbon
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt playwright==1.63.0

COPY core/ core/
# Fuentes e ícono de marca que las piezas referencian como __ASSETS__/brand/…
COPY apps/web/public/fonts/ /srv/assets/fonts/
COPY apps/web/public/icon-192.png apps/web/public/icon-512.png /srv/assets/

ENV RENDER_ASSETS_DIR=/srv/assets \
    PYTHONUNBUFFERED=1

# Chromium del sistema de la imagen corre como usuario sin privilegios.
USER pwuser
CMD ["python", "-m", "core.render.worker"]
