---
name: verify
description: Cómo verificar cambios de FOLAX end-to-end (gateway FastAPI + web React). Receta de arranque, superficies y flujos que vale la pena conducir.
---

# Verificación E2E de FOLAX

## Arranque (dev, BD de staging en Railway vía `.env`)

```powershell
# Gateway (desde la raíz del repo — SIEMPRE, si no falla el import de `core`)
Set-Location <repo>; python -m uvicorn core.gateway.app:app --port 8000

# Web dev server (proxy /api y /v1 → :8000, cookies same-origin)
Set-Location <repo>\apps\web; npm run dev   # http://localhost:5173
```

- Salud: `GET http://127.0.0.1:8000/health` → 200.
- Inferencia local: requiere Ollama en `127.0.0.1:11434` (el orquestador cae
  al Ollama local si el nodo gpu-01 de staging no responde). Verificar con
  `curl http://127.0.0.1:11434/api/tags`.
- OJO: la BD es staging REMOTA (Railway) — latencias de cientos de ms;
  no usar esperas fijas cortas en tests de UI.

## Superficie web (GUI)

Playwright Python con Edge del sistema (sin descargar navegador):

```python
p.chromium.launch(channel="msedge", headless=True)
```

Flujos que cubren F4 (ver `verify_f4.py` de referencia en la sesión F4):
anónimo→hero→redirect a registro al enviar; registro por UI; chat con
streaming (esperar `.chat-input__send:not(:disabled)` para el fin del
stream); auto-título en `.sb-item__title`; recarga persiste; renombrar y
eliminar del menú del historial (son actualizaciones optimistas — instantáneas);
logout; login con contraseña mala → `.auth__error`.

## Superficie API (curl)

Sesión por cookie: `curl -c jar.txt -X POST /api/auth/register` con
`{first_name,last_name,email,password}` (password ≥8). Luego `-b jar.txt`
para `/api/auth/me`, `/api/conversations`, `/v1/models` y
`/v1/chat/completions` (acepta cookie O Bearer API key).
Streaming: `data: {chunk OpenAI}` + `: keep-alive` + `data: [DONE]`.

## Gotchas

- Usuarios de prueba quedan en staging — usar emails `*_<timestamp>@test.local`
  y anotarlos como datos a limpiar.
- El build de la web (`npm run build`) debe correrse antes de commitear si
  el gateway sirve `dist/` (Docker lo reconstruye igual).
- `npm run lint` = oxlint.
