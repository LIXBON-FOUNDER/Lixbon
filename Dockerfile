# ── Stage 1: build de la web (React + Vite) ─────────────────────────────────
FROM node:20-alpine AS web-build
WORKDIR /build
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# ── Stage 2: gateway (FastAPI) ──────────────────────────────────────────────
FROM python:3.12-slim
WORKDIR /srv/folax

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY core/ core/
COPY BD/ BD/
COPY alembic.ini ./
COPY apps/cli/client_cli.py apps/cli/client_cli.py
COPY --from=web-build /build/dist apps/web/dist

# Railway inyecta PORT; 8000 como default para ejecución local del contenedor
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn core.gateway.app:app --host 0.0.0.0 --port ${PORT}"]
