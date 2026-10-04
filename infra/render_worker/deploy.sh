#!/usr/bin/env bash
# Despliega el worker de render en Railway (servicio render-worker).
#
#   bash infra/render_worker/deploy.sh
#
# El railway.toml de la raíz es del gateway y Railway lo impone a cualquier servicio
# conectado al repo (y ya no deja asignar otro archivo por servicio), así que el
# worker no se conecta a GitHub: se sube desde una carpeta con solo lo que necesita.
# Hay que volver a ejecutarlo cuando cambie core/ o requirements.txt.
set -euo pipefail

PROJECT="${RAILWAY_PROJECT:-eb8f12b8-5446-4d61-89ae-8d11bcbffa39}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
SERVICE="${RAILWAY_SERVICE:-render-worker}"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/apps/web/public"
cp "$REPO/requirements.txt" "$STAGE/"
cp -r "$REPO/core" "$STAGE/core"
cp -r "$REPO/apps/web/public/fonts" "$STAGE/apps/web/public/fonts"
cp "$REPO/apps/web/public/icon-192.png" "$REPO/apps/web/public/icon-512.png" "$STAGE/apps/web/public/"
cp "$REPO/infra/render_worker/Dockerfile" "$STAGE/Dockerfile"
cp "$REPO/infra/render_worker/railway.toml" "$STAGE/railway.toml"
find "$STAGE" \( -name __pycache__ -o -name .pytest_cache \) -type d -prune -exec rm -rf {} +

cd "$STAGE"
railway up --project "$PROJECT" --environment "$ENVIRONMENT" --service "$SERVICE" --detach \
  -m "render-worker $(git -C "$REPO" rev-parse --short HEAD)"
