# Especificación: Visuals como servicio de artefactos de Lixbon

Estado (2026-10-04): especificación aprobada. Fases 1, 3, 4 y 5 hechas; fase 2 hecha salvo el IDE. Worker de render desplegado en Railway (`infra/render_worker/deploy.sh`, no se despliega solo con el push). Tras las primeras pruebas con Claude Code real se añadieron versiones con nombre, `amend` y el editor integrado (ver [§15](#15-ajustes-tras-las-primeras-pruebas-2026-10-04)).
Método: especificación guiada por preguntas (estilo spec-kit): cada decisión sale de una respuesta del dueño del producto y está en el [registro de decisiones](#2-registro-de-decisiones). Lo que no se decidió está en [puntos abiertos](#13-puntos-abiertos). Nada de lo no registrado debe darse por hecho.

## 1. Resumen

**Visuals** pasa de ser «un chat web que genera HTML» a ser el servicio de artefactos de Lixbon: un lugar donde viven, con versiones, las cosas visuales que crean el chat web, el CLI y los agentes del IDE (diseños de interfaz, imágenes, carruseles, vídeos de marca). Conserva su nombre, sigue la imagen de Lixbon y se comporta como los artefactos de claude.ai (panel junto al chat) y como Claude Design (chat + lienzo en vivo, design system, traspaso a código), con otro nombre y otra interfaz; las funciones extra llegan después.

`/visual` es el comando que lo usa desde el CLI y el IDE, en **todos** los agentes del IDE, a través de un **servidor MCP de Lixbon**.

### Objetivos
1. Un solo servicio Visuals con un solo formato de datos, versionado, compartido entre web, CLI e IDE.
2. `/visual` disponible en el CLI y en el IDE para cualquier agente con soporte MCP.
3. El usuario ve el visual construirse en vivo (web y panel del IDE) y puede retocarlo a mano sin pisar al agente.
4. Traspaso de un visual a código del proyecto.
5. `/marketing-lxo` publica piezas de marketing en Visuals; catálogo de skills en el IDE y en la web.

### No objetivos (por ahora)
- Fotos o ilustraciones generativas: no hay modelo de imagen de Anthropic y el nodo de difusión de Lixbon es otro sistema.
- Presentaciones, documentos o diagramas con editor propio.
- Ramas y fusión de versiones.
- Skills publicadas por terceros.
- Migrar Visuals antiguos (se empieza de cero).
- `/visual sistema` (extraer el design system del proyecto): está en el backlog, la v1 solo tiene crear, editar y pasar a código.

## 2. Registro de decisiones

| # | Decisión | Respuesta |
|---|---|---|
| D1 | Nombre | **Visuals**. No se usa «Artifacts» en producto, API, rutas ni código |
| D2 | Relación con el chat web | Visuals se reestructura como servicio de artefactos; panel junto al chat **y** espacio completo |
| D3 | Tipos de contenido | Diseños de interfaz **y** piezas de marketing (imágenes, carruseles, vídeos) |
| D4 | Referente funcional | Claude Design: iterar en un lienzo y pasar a código; misma lógica, otro nombre y otra interfaz |
| D5 | Llegada a los agentes | Servidor MCP de Lixbon |
| D6 | Dónde se crea en la web | Panel junto a cualquier chat + `/visuals` (galería) + `/visuals/:id` (espacio completo) |
| D7 | Dónde se ve en el IDE | Panel integrado, actualizado en vivo |
| D8 | Planes | Pro y Advance crean; Gratuito solo ve (enlaces compartidos) |
| D9 | Edición manual vs agente | El agente parte siempre de la última versión; historial lineal |
| D10 | Design system | En la cuenta, compartido entre web/CLI/IDE; el agente puede extraerlo del proyecto (backlog) |
| D11 | Binarios | Postgres ahora con límites estrictos; bucket de Railway después |
| D12 | Visuals existentes | No se migran: se empieza de cero |
| D13 | Tiempo real | Empuje desde el servidor (SSE o WebSocket) |
| D14 | Traspaso a código | Herramienta MCP **y** descarga .zip |
| D15 | Subcomandos v1 | Crear, editar uno existente, pasar a código |
| D16 | Auth del MCP | Remoto en `lixbon.com/mcp`: **API key como Bearer primero**, OAuth en el navegador después, sin cambiar las herramientas |
| D17 | Conexión a agentes | El IDE registra el MCP en cada agente, pidiendo permiso la primera vez |
| D18 | `/marketing-lxo` | Publica con las herramientas MCP de Visuals; desaparece `subir.py` |
| D19 | Catálogo de skills | En ajustes del IDE y en página web pública `lixbon.com/skills`; solo skills oficiales |
| D20 | Límites | Pro 50 visuals / 500 MB; Advance 200 / 2 GB; Gratuito no crea. Ajustables en `plans` sin redesplegar |
| D21 | Orden | 1) núcleo y web, 2) MCP y `/visual` en CLI e IDE, 3) `/marketing-lxo`, 4) worker de render, 5) catálogo de skills |
| D22 | Render de PNG/MP4 | Servicio aparte en Railway (Chromium + ffmpeg) con cola en BD |
| D23 | Chat web crea visuals | **Herramientas** como camino principal; bloques `file:` como respaldo para modelos sin tool-calling; prototipo de streaming antes de cerrar el diseño |
| D24 | Disparo en el chat web | El modelo decide solo (como claude.ai); `/visual` además fuerza el modo |
| D25 | Editor | Se amplía el editor actual de Visuals (lienzo de tableros, inspector, versiones, código, compartir) |

## 3. Historias de usuario y criterios de aceptación

**H1. Crear desde el IDE.** Como usuario Pro con un agente en el IDE, escribo `/visual una landing para mi API` y obtengo un visual nuevo.
- Dado que el agente tiene el MCP de Lixbon conectado, cuando ejecuto `/visual <descripción>`, entonces el agente crea un visual, se abre en el panel del IDE y veo cómo se va construyendo.
- Dado un usuario Gratuito, cuando ejecuta `/visual`, entonces recibe un mensaje claro de que crear requiere Pro, con enlace a planes, y no se crea nada.

**H2. Editar uno existente.** `/visual <id o enlace> <cambio>`.
- El agente lee la última versión (incluidos mis retoques manuales), aplica el cambio y crea una versión nueva; nunca sobrescribe una versión anterior.
- Si la versión base que el agente usó ya no es la última, la escritura se rechaza con `stale_base` y el agente vuelve a leer.

**H3. Pasar a código.** `/visual codigo <id> [stack]`.
- El agente recibe archivos, estilos, assets e instrucciones, e implementa el diseño en el proyecto del workspace con el stack indicado.
- En la web puedo además descargar un .zip equivalente.

**H4. Retocar a mano en la web.** Selecciono un elemento y cambio texto, tamaño, colores, espacios, orden; deshago y rehago.
- Cada guardado crea una versión nueva. Si el agente está escribiendo, mis cambios no se pierden (D9).

**H5. Ver en vivo.** Al guardar el agente una versión, la web y el panel del IDE se actualizan sin recargar (D13).

**H6. Chat web.** Pido «hazme una landing» en el chat y el modelo crea un visual que se abre en un panel junto al chat (D6, D24).

**H7. Marketing.** `/marketing-lxo` genera una campaña y la publica como visual de tipo marketing; la edito en la web igual que un diseño.

**H8. Compartir.** Genero un enlace público de solo lectura, también para usuarios Gratuitos y sin sesión; puedo revocarlo.

**H9. Skills.** En Ajustes › Skills del IDE y en `lixbon.com/skills` veo tarjetas; al abrir una veo descripción detallada, fecha, versión y calificación de usuarios; instalo `/adversary` o `/marketing-lxo`; califico (1–5, un voto por usuario y skill).

## 4. Requisitos funcionales

**Núcleo**
- FR-1 Entidad **Visual** (id `vis_…`, usuario, tipo `design | marketing`, título, versión actual, token de compartir, metadatos, fechas) con archivos versionados por copia en escritura.
- FR-2 Rutas de archivo normalizadas y validadas (sin `..`, sin absolutas, sin `\`, extensiones permitidas).
- FR-3 Límites por plan (D20) más límites duros por archivo (25 MB), por visual (100 MB) y por lote.
- FR-4 Creación restringida a planes con Visuals; lectura propia y compartida para todos.
- FR-5 Cada escritura exige `base_version`; si no coincide con la última, error `stale_base`.
- FR-6 Eventos en vivo por visual (nueva versión, render terminado) para web e IDE.
- FR-7 Compartir: token público, solo lectura, revocable; el HTML se sirve con CSP `sandbox` y `nosniff`.

**MCP (`lixbon.com/mcp`, ver §7)**
- FR-8 Herramientas de crear, actualizar, leer, listar, exportar y renderizar.
- FR-9 Auth por API key en la primera versión; OAuth en una fase posterior sin cambiar el contrato de herramientas.
- FR-10 El MCP expone también el `/visual` como *prompt* con las instrucciones de diseño y el design system activo.

**Web**
- FR-11 Panel de visual junto al chat y espacio completo `/visuals/:id` (D6).
- FR-12 Galería `/visuals` con búsqueda y filtro por tipo.
- FR-13 Editor ampliado (D25): lo que ya existe + línea de tiempo de vídeo, piezas de marketing con su tamaño, historial de versiones, vista de versión antigua.
- FR-14 Exportar .zip y copiar código.

**IDE y CLI**
- FR-15 Panel integrado en el IDE con la web de Visuals en vivo.
- FR-16 El IDE registra el MCP de Lixbon en la configuración del agente activo tras pedir permiso.
- FR-17 El CLI de Lixbon tiene `/visual` con los tres subcomandos de la v1.

**Skills**
- FR-18 Catálogo oficial con versiones, descripción, fecha y calificación media y número de votos.
- FR-19 Instalación en la carpeta de skills del agente; verificación de `sha256` y confirmación del usuario.

## 5. Requisitos no funcionales

- **Seguridad**: el HTML de un visual es contenido no confiable. En visor y compartidos corre en iframe con sandbox sin acceso al origen de lixbon.com; en el editor se desactivan los scripts de la pieza. Los archivos se sirven con `nosniff`; las respuestas privadas con `no-store`.
- **Rendimiento**: la lista de visuals no carga contenidos; las miniaturas son archivos de salida.
- **Idioma**: interfaz en español y en inglés (como el resto de la web).
- **Identidad**: tokens de `base.css`, rellenos en vez de bordes, tema claro/oscuro.
- **Accesibilidad**: respeta `prefers-reduced-motion`; todo control del editor accesible por teclado.
- **Observabilidad**: eventos de auditoría de crear, compartir y borrar (ya existe `log_audit_event`).

## 6. Modelo de datos

Dos tablas, que reemplazan a las provisionales de la implementación previa (`artifacts`, `artifact_files`):

- `visuals(id, user_id, kind, title, version, share_token, meta_json, created_at, updated_at)`
- `visual_files(id, visual_id, version, path, role, mime, size, sha256, content_text, content_blob, created_at)`; único `(visual_id, path, version)`.
- `visual_versions(id, visual_id, version, label, origin, created_at)`; único `(visual_id, version)`. Nombre y origen (`web`, `mcp`, `api`) de cada versión; las versiones antiguas no tienen fila y la web les deduce un nombre.
- Roles de archivo: `source` (HTML editable) y `output` (PNG/MP4/MD ya generados).
- Pieza = HTML fuente + salida con el mismo nombre; el `<meta name="render" content="image 1080x1350">` (o `video 1080x1920 12`) declara tipo y tamaño.
- Una salida es **desactualizada** si su fuente tiene una versión mayor; el visor la marca hasta que el worker la regenere.
- Nuevas, en fases posteriores: `visual_render_jobs`, `design_systems`, `skills`, `skill_versions`, `skill_ratings`, `skill_installs`.

## 7. Herramientas MCP (propuesta de contrato)

Contrato implementado en `core/gateway/routers/mcp.py`; la configuración por cliente está en la web, Ajustes › MCP (`/account/mcp`).

| Herramienta | Entrada | Resultado |
|---|---|---|
| `visual_create` | `title`, `kind`, `label?`, `files[]` | `id`, `url`, `version` |
| `visual_update` | `id`, `base_version`, `files[]` o `edits[]` (SEARCH/REPLACE por archivo), `label?`, `amend?` | `version`; error `stale_base` |
| `visual_get` | `id`, `version?`, `paths?` | manifiesto y contenido de texto |
| `visual_list` | `kind?`, `query?` | lista breve |
| `visual_export` | `id`, `format` (`bundle` \| `zip`), `stack?` | archivos, estilos, assets e instrucciones para implementarlo |
| `visual_render` / `visual_render_status` | `id`, `paths?` / `id`, `wait_seconds?` | trabajos / estado, esperando hasta 60 s |
| `visual_view` | `id`, `path` (HTML o PNG) | la imagen renderizada, para que el agente la mire |

El *prompt* `/visual` entrega las instrucciones de diseño (a partir de `VISUALS_PROMPT`) y el design system de la cuenta.

## 8. API HTTP del gateway

Equivalente a lo ya implementado con el nombre corregido: `/api/visuals` (crear, listar, manifiesto, subir lote, leer archivo, borrar), `/api/visuals/{id}/share`, `/api/shared-visuals/{token}[/files/…]`, más `/api/visuals/{id}/events` (en vivo) y `/mcp`. Autenticación: sesión web o `Bearer lixbon_sk_…`.

Enlace público en la web: `/s/v/:token` (propuesta; el actual `/s/:token` es de conversaciones).

## 9. Interfaz

- **Web**: `/visuals` galería; `/visuals/:id` espacio completo con el editor ampliado; panel lateral en `/chat`. Estilos y componentes de la web actual.
- **IDE**: panel de Visuals junto al chat; en Ajustes, nueva página **Skills** (tarjetas, detalle, instalar, calificar).
- **CLI**: `/visual` con crear, editar y pasar a código, con salida en la terminal y enlace al visual.

## 10. Skills

- Tablas y rutas `GET /api/skills`, `GET /api/skills/{slug}`, `GET /api/skills/{slug}/download`, `PUT /api/skills/{slug}/rating`.
- Publicación solo por administradores de Lixbon, desde el panel admin.
- Detalle de una skill: descripción detallada, fecha, versión, calificación media y votos, contenido del paquete (scripts incluidos).
- Instalación: copia el paquete a la carpeta de skills del agente, tras verificar `sha256` y confirmar.
- `/marketing-lxo`: renombre de `marketing-lixbon`; ya hecho en local: fuentes e ícono empaquetados, sin editor propio. Pasa a publicar por MCP (D18).

## 11. Fases y tareas

Cada fase termina con pruebas automáticas y una verificación real en el navegador (o en el agente).

1. ✅ **Núcleo y web** (`master`).
   - Tablas `visuals`/`visual_files`, `/api/visuals` con `base_version` y `stale_base`, límites por plan (`plans.visuals_max`, `visuals_max_mb`; NULL = D20), avisos en vivo (SSE), enlace público `/s/v/:token`.
   - API nueva: `PATCH /api/visuals/{id}` (título y metadatos `conversation_id`, `design_system`, `origin`, `mode`, sin crear versión), `GET /api/visuals/{id}/versions` (fecha y archivos de cada versión), `GET /api/visuals?conversation_id=` y portada (`cover`, `pages`) en la lista.
   - **Un solo editor** (D25): `VisualsPage.jsx` es el estudio de siempre (chat, lienzo, páginas, inspector, retoques, design system, presentar, compartir) pero sobre visuals `vis_…`. Cada respuesta del modelo se guarda como versión (`lib/visualStudio.js`): el modelo recibe los archivos actuales del servidor en el prompt y el historial sin el código, así edita sobre lo que hicieron el editor o los agentes; si alguien guardó mientras escribía, el cambio se reaplica sobre su versión. Los retoques manuales se guardan como versión con «Guardar retoques». Las piezas de marketing y las imágenes se ven con su resultado, botón de render y el editor de piezas; los `.md` como documento. La página intermedia `VisualPage.jsx` se retiró.
   - **Galería** `/visuals`: todos los visuals (estudio, chat y agentes) con portada, filtro Todos/Diseños/Marketing, búsqueda, orden, lista o cuadrícula, renombrar y borrar.
   - **Panel en el chat** (D6, D24): si el usuario tiene Pro/Advance, el chat añade al prompt la regla de Visuals; cuando el modelo entrega ```file:index.html se abre un panel junto a la conversación con la vista en vivo y al terminar se guarda como visual de esa conversación (las siguientes respuestas crean versiones; `edit:` aplica cambios). En el hilo se ve un chip en lugar del código; una respuesta con ```html normal no abre nada. El panel tiene «Abrir en Visuals» y «Descartar» (borra el visual; punto abierto 9).
   - El Visuals antiguo (conversaciones `source=visuals`) no se migra (D11): sus rutas `/visuals/<uuid>` llevan a la galería. Se conservan `/s/:token` (enlaces ya compartidos) y `/api/conversations/{id}/files` (lo usa el `/visual <id>` de CLIs ya publicados); retirar ambos cuando no queden clientes.
   - Verificado en el navegador con un Ollama falso guionizado (no hay nodos aquí): chat → panel en vivo → v1 con dos páginas → edición v2 → pregunta normal sin panel → recargar → abrir en el estudio; estudio: crear desde el inicio, retoques como versión, historial, enlace público, pieza de marketing con render real, filtros. **Pendiente**: probar con modelos reales del clúster; prototipo de streaming de tool-calls (D23, punto abierto 1) — hoy el chat web usa los bloques `file:`, que funcionan con cualquier modelo.
2. **MCP y `/visual`**.
   - ✅ Servidor MCP remoto en `/mcp` (Streamable HTTP sin sesión, API key): `visual_create`, `visual_update`, `visual_get`, `visual_list`, `visual_export` y prompt `visual`. Verificado con **Claude Code 2.1.288 real**: crear, leer y editar con `/mcp__lixbon__visual vis_… <cambio>`.
   - ✅ CLI: transporte HTTP en su cliente MCP, servidor `lixbon` registrado solo con la API key (desactivable con `"lixbon_mcp": false`), `/visual` nuevo; el `/visual <id> [stack]` antiguo se retiró. Verificado contra el gateway; el turno completo del agente del CLI no se probó (necesita nodos del clúster).
   - ⏳ IDE (`desktop`, después de `master`): registro del MCP en cada agente con permiso, panel integrado y `/visual` para todos los agentes.
3. ✅ **`/marketing-lxo`** publica por MCP. El skill ya no trae scripts ni fuentes: compone desde sus plantillas, publica con `visual_create`, renderiza en el servidor y **mira cada imagen con `visual_view`** antes de entregar.
   - Nuevas en el MCP: `visual_view` (devuelve el PNG como imagen para que el agente lo vea) y `wait_seconds` en `visual_render_status`.
   - Las piezas pueden usar otros archivos del visual con rutas relativas (capturas reales): el worker los coloca junto al HTML y el editor web fija la base.
   - Las fuentes de marca se inyectan siempre en el render y en el editor (una pieza que nombra «Geist» sin declararla ya no cae en una fuente del sistema).
   - Verificado con Claude Code real (Haiku) en tres pasadas: la primera aprobó una pieza con texto cortado; la segunda escribió el CSS desde cero y salió fuera de marca; tras endurecer la revisión (defectos concretos, describir la imagen y no el HTML) y obligar a partir de plantillas, la tercera salió en marca y sin defectos. Pendiente: con modelos pequeños aún aparecen promesas no verificadas («en 30 segundos»).
4. ✅ **Worker de render** (`core/render/`, cola en `core/persistence/visual_renders.py`, despliegue en `infra/render_worker/`).
   - Cola `visual_render_jobs` con arrendamiento de 5 min, 3 intentos y sin duplicados por pieza; render automático al editar una pieza que ya tenía salida.
   - Cada salida guarda el sha256 de su HTML: la web marca como desactualizada solo la salida que de verdad no corresponde.
   - Barrera de red del renderizador (solo IPs públicas y assets de marca), límites de tamaño y duración.
   - API `POST /api/visuals/{id}/render`, `GET …/renders`; aviso del worker en `POST /api/internal/render-events` (token compartido); herramientas MCP `visual_render` y `visual_render_status`; botón «Renderizar» y estado en vivo en la web.
   - Verificado: 16 tests; render real de imagen (1,6 s) y vídeo de 10 s 1080x1920 (18,7 s); una página espía no logró ninguna petición a localhost; en el navegador, render manual y re-render automático tras editar, con el PNG actualizado.
   - **Pendiente**: construir la imagen (sin Docker en la máquina de desarrollo) y crear el servicio en Railway; cuotas diarias **provisionales** (Pro 100 imágenes / 10 vídeos, Advance 500 / 50) a fijar por negocio.
5. ✅ **Catálogo de skills** (`core/persistence/skills.py`, `core/gateway/routers/skills.py`).
   - Tablas `skills`, `skill_versions` (zip determinista en Postgres, sha256, lista de archivos), `skill_ratings`, `skill_installs`.
   - API pública `GET /api/skills[/{slug}]`; descarga con sesión o API key (`X-Skill-Sha256`, cuenta la instalación); `PUT/DELETE /api/skills/{slug}/rating`.
   - Admin › Skills: se sube la carpeta de la skill (el slug sale del `name` de su SKILL.md; se omiten `evals/`, `__pycache__`, `.git`), versión semver estrictamente mayor, ficha (título, resumen, categoría, descripción en Markdown), mostrar/ocultar y borrar. Una skill nueva nace oculta.
   - Web `/skills` y `/skills/:slug` (es/en, en la navegación, el pie y el sitemap): tarjetas, ficha con descripción, versión, fecha, calificación, historial, contenido y sha256; descarga .zip y voto.
   - IDE (rama `desktop`), Ajustes › Skills: tarjetas con estado (instalada, actualización, instalada aparte), ficha en modal, elegir agentes, instalar/actualizar/desinstalar con confirmación y calificar. El instalador (`src-tauri/src/skills_catalog.rs`) verifica el sha256, rechaza entradas fuera de `<slug>/`, descomprime al lado y cambia al final, deja `.lixbon-skill.json`, no pisa una carpeta ajena sin permiso y sustituye `{{LXO_BIN}}` por la ruta de `lxo`.
   - Verificado: 7 tests de la API, 3 tests del instalador en Rust; en el navegador, catálogo, ficha, descarga, voto y publicación desde el admin; en el IDE (interfaz con el simulador de Tauri contra el gateway local), instalar, votar y estado de las tarjetas. **Sin probar en la app de escritorio compilada.**
6. Backlog: OAuth del MCP, `/visual sistema`, bucket de Railway, ramas.

## 12. Estado del código existente (para el renombrado y la limpieza)

- **Reutilizable**: `core/persistence/artifacts.py`, `core/gateway/routers/artifacts.py`, sus 15 tests, `ArtifactEditor.jsx` y páginas de la web, `scripts/subir.py` (hasta el MCP). Todo con nombres «artifact» que debe pasar a «visual».
- **A reutilizar tal cual**: `VisualsPage.jsx` (editor actual), `PLANES_CON_VISUALS`/`ensure_can_use_visuals`, `visual_files.py` (parser de bloques `file:` para el respaldo), `lib/visuals.js`.
- **A retirar o reescribir** por D12: el almacenamiento de visuals en `conversations` (`source=visuals`), `/api/conversations/{id}/files` para visuals, y `/visual <id>` del CLI en su forma actual.
- `docs/PLAN_ARTIFACTS_Y_SKILLS.md` queda reemplazado por este documento.

## 13. Puntos abiertos

1. **Streaming de tool-calls** con los modelos del clúster: ¿llega el HTML de una llamada token a token o completo? Decide si el lienzo se construye en vivo en el chat web (prototipo de la fase 1).
2. **Autenticación del panel del IDE**: la web usa cookie de sesión y el IDE tiene API key; hay que definir cómo el webview obtiene sesión (probable: canje por el flujo `ide_auth` ya existente).
3. **Formato de registro del MCP por agente**. Verificado con la ayuda de cada CLI instalado: Claude Code `claude mcp add --transport http lixbon <url> --header "Authorization: Bearer …" -s user`; OpenCode 2.0.12 `opencode mcp add lixbon --url <url> --header Authorization=… --global`; agente de Lixbon: automático (fase 2). **Sin verificar**: Codex, Gemini y Cursor (no instalados aquí). Cursor y OpenCode dan problemas como hijos del orquestador; su comportamiento con MCP en chat interactivo no está probado.
4. **Skills en agentes que no son Claude Code**: `/adversary` y `/marketing-lxo` son skills de Claude Code (`SKILL.md`). Falta decidir cómo se ofrecen a Codex, Cursor, Gemini y OpenCode (p. ej. como *prompts* MCP).
5. **Empuje en vivo**: SSE o WebSocket y, si el gateway tiene varias instancias, un bus (Redis).
6. **Ruta del enlace público** (`/s/v/:token` propuesta) y valores finales del enum de tipos.
7. **Reglas de calificación de skills** (decidido provisionalmente): vota quien la descargó al menos una vez, un voto por usuario y skill, se puede cambiar o retirar, sin reseñas con texto.
8. **Versionado de skills oficiales**: la fuente de `/adversary` para el catálogo vive en `skills/adversary/` (versionada, con el marcador `{{LXO_BIN}}`). `/marketing-lxo` sigue en `.claude/skills/` (ignorada por git): falta decidir si se mueve a `skills/`.
10. **Dos orígenes de `/adversary`**: el orquestador del IDE la escribe desde Rust (`orch/skill.rs`) y el catálogo la instala desde el paquete. Conviven (ambas llevan `lxo-skill-version`), pero lo limpio es que el orquestador la instale desde el catálogo.
9. **Qué pasa con el panel del chat cuando el modelo decide solo** (D24) y se equivoca: cómo se descarta un visual no pedido.

## 14. Riesgos

- OAuth del MCP es la pieza más grande y se aplaza a propósito (D16).
- Binarios en Postgres no escalan para vídeo; hay disparador claro para pasar a bucket (D11).
- El worker de render añade un servicio que operar (D22).
- La calidad del tool-calling de modelos auto-hospedados no está medida (D23, punto abierto 1).

## 15. Ajustes tras las primeras pruebas (2026-10-04)

Probando el MCP con Claude Code real salieron tres problemas; esto es lo que cambió.

**Versiones: una petición, una versión, con nombre**
- `put_files` tiene tres modos: `new` (versión nueva), `amend` (rehace la versión actual: crea la N+1, mueve los archivos que no cambian y borra los sobrescritos, así la anterior desaparece del historial) y `attach` (añade filas a la versión actual sin subir el número; lo usa el worker para las salidas renderizadas, por eso un render ya no crea versión).
- `amend` lo piden `PATCH`/`POST /api/visuals/{id}/files` con `amend: true` (el editor web lo usa siempre al guardar, para actualizar la versión que se está editando) y la herramienta `visual_update` con `amend: true` (el agente, para corregirse tras `visual_view`). Un agente solo puede enmendar si la última escritura fue suya (`last_origin` en `meta_json`): si la web retocó después, su cambio crea una versión nueva y no se pierde nada.
- Cada versión lleva `label`: lo manda el chat o el estudio (lo que pidió el usuario, hasta 60 caracteres), `label` en `visual_create`/`visual_update` (hasta 80) o el prompt de una imagen generada. Un `amend` sin nombre conserva el anterior. `PATCH /api/visuals/{id}/versions/{version}` la renombra y publica un evento `meta`. `GET …/versions` devuelve `label` y `origin`; el manifiesto trae `viewing_label`.
- Web: el historial muestra nombre, «Actual», fecha y archivos; se renombra con el lápiz o doble clic. Sin número `v3` en ninguna parte (cabecera, avisos, chips del chat, panel del chat).

**Editor integrado**
- Editar una pieza ya no abre otra vista: el panel de edición (`PiezaEditor`, pestañas Diseño y Código) se despliega a la derecha del lienzo. Sliders de arrastre con valor editable, colores, grosor, alineación, línea de tiempo del vídeo; deshacer/rehacer; Guardar solo activo con cambios; el chat se pliega.
- La vista previa de una pieza es el HTML vivo a su tamaño real escalado al lienzo (`PiezaVista`), no el PNG; el PNG/MP4 se muestra solo en vídeo o si no hay fuente.

**Calidad del render**
- Las imágenes se renderizan a doble resolución (`device_scale_factor` 2) cuando el lado mayor es ≤ 2160 px; por encima y en vídeo, a 1x. Antes salían a 1x y se veían borrosas junto al editor.

**Skills**
- `/marketing-lxo` pide `label` siempre y `amend: true` para correcciones. Sus archivos viven en `.claude/skills/` (ignorada por git): tras cambiarlos hay que subir una versión nueva en Admin › Skills.

**Despliegue**
- La tabla `visual_versions` la crea el gateway al arrancar (`create_all`). El worker de render hay que redesplegarlo con `bash infra/render_worker/deploy.sh` para el render a 2x y el modo `attach`.
