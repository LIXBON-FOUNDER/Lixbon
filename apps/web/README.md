# lixbon Web (lixbon.com)

Frontend en **React 19 + Vite**: chat generalista con streaming, cuenta y
API keys, planes y pagos (Stripe), uso, documentación y guías (es/en), estado
público del clúster, descargas de apps y panel de administración.

Vive en **`master`** junto al gateway: el `Dockerfile` la compila y el gateway
la sirve desde `apps/web/dist`, así que un cambio en la web se despliega con
el siguiente push a `master`.

## Desarrollo local

```bash
# 1. gateway desde la raíz del repo
python -m uvicorn core.gateway.app:app --port 8000

# 2. web
cd apps/web
npm install
npm run dev        # http://localhost:5173, proxy de /api y /v1 → :8000 (cookies same-origin)
npm run lint       # oxlint
```

## Build

```bash
npm run build      # vite build + SSR estático (entry-server.jsx) + prerender de rutas públicas
npm run build:spa  # solo SPA, sin prerender
```

`scripts/prerender.mjs` genera HTML estático para las rutas de
`src/rutasPublicas.js` (landing, docs, guías, legal, planes…) para SEO; el
resto es SPA.

## Estructura

```
src/
  App.jsx, main.jsx, entry-server.jsx   raíz cliente y servidor
  rutasPublicas.js                      rutas que se prerenderizan
  pages/                                una página por ruta; admin/ es el panel
  pages/*Content.{es,en}.jsx            contenido de docs, guías y legal por idioma
  components/                           ChatInput, Mensajes, Sidebar, Markdown, CodeBlock, pagos/ …
  hooks/                                useAuth, useTema, useDictado, useConfirmar …
  i18n/                                 LocaleContext, diccionarios, rutas localizadas
  lib/                                  api.js, stream.js (SSE), stripe.js, visuals.js, remote.js …
  styles/base.css                       TOKENS DE DISEÑO — fuente de verdad para todas las apps
public/                                 favicons (desde assets/brand/), fuentes, robots.txt
```

## Diseño

`src/styles/base.css` define la identidad (crema `#F6F7ED`, tinta `#171717`,
bordes 1px, Bruno Ace SC + Bricolage Grotesque). Desktop y móvil copian esos
tokens, no los reinterpretan. Especificación completa en `docs/DISENO_WEB.md`
y principios en `PRODUCT.md`.

Contratos con el gateway que hay que mantener en paralelo:
`lib/visuals.js` ↔ `core/inference/visual_files.py`, `lib/stream.js` ↔
`core/gateway/routers/chat.py`.
