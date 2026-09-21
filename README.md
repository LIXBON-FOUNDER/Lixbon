# lixbon

Plataforma SaaS de modelos LLM auto-hospedados sobre un clúster GPU distribuido.
Un gateway central (FastAPI) expone los modelos con API compatible con OpenAI,
límites por plan y cuentas de usuario; alrededor de él hay cuatro clientes:
web, escritorio, CLI y móvil.

| Producto | Carpeta | Stack | Rama de trabajo | Release |
|---|---|---|---|---|
| **Gateway** + node agent | `core/`, `BD/`, `infra/` | Python 3.12 · FastAPI · SQLAlchemy · Postgres | `master` | Railway despliega `master` |
| **Web** (lixbon.com) | `apps/web` | React 19 · Vite | `master` | Se compila dentro de la imagen del gateway |
| **Desktop** | `apps/desktop` | Tauri 2 · React | `desktop` | Tag `desktop-vX.Y.Z` → CI → MSI |
| **CLI** | `apps/cli` | Python 3 (sin dependencias) | `cli` | `python apps/cli/build.py` → el gateway lo sirve |
| **Móvil** (Android) | `apps/mobile` | React Native · Expo | `mobile` | Tag `mobile-vX.Y.Z` → CI → APK |

El flujo de ramas está en [`docs/RAMAS_Y_RELEASES.md`](docs/RAMAS_Y_RELEASES.md);
la arquitectura completa en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Estructura del repositorio

```
.
├── core/            gateway FastAPI, inferencia, orquestación, billing, node agent
├── BD/              esquema Postgres, migraciones Alembic, seeds y scripts de BD
├── infra/           Docker del nodo, lanzadores locales (.bat/.sh) y scripts de operación
├── apps/
│   ├── web/         lixbon.com (chat, cuenta, planes, docs, panel admin)
│   ├── desktop/     app de escritorio (Tauri)
│   ├── cli/         lixbon CLI (fuente en lixbon_cli/, artefacto client_cli.py)
│   └── mobile/      app Android (Expo)
├── assets/brand/    iconos y favicon oficiales
├── docs/            documentación técnica y de producto
├── .github/         workflows de CI/CD y plantilla de PR
├── Dockerfile       imagen del gateway (incluye la web compilada y el CLI)
├── railway.toml     despliegue en Railway
├── alembic.ini      migraciones (apunta a BD/migrations)
└── .env.example     todas las variables de entorno del gateway, documentadas
```

## Arranque rápido (gateway + web en local)

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # editar DATABASE_URL, etc.

# Gateway — SIEMPRE desde la raíz del repo (import de `core`)
python -m uvicorn core.gateway.app:app --port 8000

# Web (otra terminal) — proxy /api y /v1 → :8000
cd apps/web && npm install && npm run dev            # http://localhost:5173
```

- Salud: `GET http://127.0.0.1:8000/health`
- Inferencia local: Ollama en `127.0.0.1:11434` (el orquestador cae a él si no hay nodos)
- Lanzador con menú para gateway + node agent + Ollama LAN + túnel: `infra/scripts/lixbon.bat` / `lixbon.sh`

Cada app tiene su propio README con instrucciones de desarrollo y release:
[`apps/web`](apps/web/README.md) · [`apps/desktop`](apps/desktop/README.md) ·
[`apps/cli`](apps/cli/README.md) · [`apps/mobile`](apps/mobile/README.md).

## Tests

```bash
python -m pytest core            # gateway (los tests viven junto al módulo que prueban)
python -m pytest apps/cli/tests  # CLI (incluye la verificación de que client_cli.py está al día)
```

## API compatible con OpenAI

```bash
curl -X POST "https://lixbon.com/v1/chat/completions" \
  -H "Authorization: Bearer lixbon_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.1:8b", "messages": [{"role": "user", "content": "Hola"}]}'
```

Cualquier cliente OpenAI (n8n, SDKs, LangChain) funciona con `base_url = https://lixbon.com/v1`
y una API key creada desde la cuenta.
