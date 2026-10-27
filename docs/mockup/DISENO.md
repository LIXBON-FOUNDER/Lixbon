# Maqueta unificada de Lixbon: ADE + IDE + CLI + Mobile Remote

Estado: **prototipo visual con datos ficticios**. No es producto, no toca el Core ni ningún runtime, y no entra en el build.
Fuente funcional/UX: `LIXBON_IDE_ADE_diseno_investigacion_V2_2026-10-12.md`. Base visual: la maqueta ADE anterior (`ui-ade-architecture`, 852d307).

## Dónde está y cómo verla

| | |
|---|---|
| Rama | `design/lixbon-unified-ade-mockup` (derivada de `ui-ade-architecture` 852d307) |
| Worktree | `C:\Users\USUARIO\lixbon-wt\design-unified-mockup` |
| Código | `apps/desktop/src/mockup/**` · entrada `apps/desktop/mockup.html` · config `apps/desktop/vite.mockup.config.js` |
| Ver | desde `apps/desktop`: `node node_modules/vite/bin/vite.js --config vite.mockup.config.js` y abrir `http://localhost:5179/mockup.html` |
| Probar | desde `apps/desktop`: `node node_modules/vitest/vitest.mjs run src/mockup --environment jsdom` (34 pruebas) |

Deep links para revisar rápido (el showcase los lee al cargar):
`#all` · `#ade` · `#ade/attention` · `#ade/compare/att_oa_b` · `#ade/proof/att_oa_b` · `#ade/review/att_oa_b` · `#ade/map` · `#ade/hosts` · `#ade/usage` · `#ide` · `#mobile` · `#mobile/attention` · `#mobile/task/att_rt_a` · `#mobile/approval/at_net_ch` · `#mobile/review/att_oa_b` · `#cli` · `#flow` · `#guide`. Con `?theme=light` antes del `#` se ve el tema claro.

## Qué se conserva de la maqueta anterior y qué cambia

**Se conserva (sin modificar `src/ade/`):** tokens de `styles/base.css` (relleno por peldaños, sin bordes ni sombras, lima `--accent`, Hanken Grotesk + JetBrains Mono, claro/oscuro), primitivas `.btn` de `studio.css`, iconos de `components/Icons.jsx`, la idea de «marca de estado por forma, no solo por color», el principio *Attention primero* y la honestidad sobre lo simulado.

**Evoluciona:** la maqueta anterior deshabilitaba lo que el Core aún no tiene (Fork, comparar, Steer…). Esta *simula* esas capacidades futuras para poder juzgarlas. La navegación pasa de «lista → detalle + bottom nav» a master-detail de escritorio (sidebar permanente · canvas · inspector).

## Pantallas

| Superficie | Pantallas |
|---|---|
| **Desktop ADE** | Sidebar Project→Task→Attempt · Task Workspace (cabecera con agente/modelo/branch/worktree/host/policy, tira de Attempts, pulso, timeline agrupado, Activity/Changes/Terminal/Artifacts) · Composer + Pending Queue · Fork as Attempt · Attention Inbox (+ batch triage + Activity aparte) · Compare Attempts · Proof Pack · Review (archivo a archivo, comentarios acumulados, Since last review, filtro por riesgo) · Hosts + Resources · Usage (+ quota-aware routing) · Mission Map · Jump Palette (Ctrl J) · New Task · Return to Agent · Inspector (Task / Changes / Context / Autonomy) |
| **Desktop IDE** | Barra de contexto permanente Task→Attempt→branch→worktree→agent→host · Explorer del worktree con marcas de cambios y «AI» · editor con pestañas, gutter de líneas del agente y diagnósticos · Source Control atado al Attempt · terminal / Problems / Tests / Debug · Agent sidecar con composer · Delegate selection · Take Over / Return to Agent · aviso «Location mismatch» |
| **Mobile** | Home · Tasks · Task detail / Agent remote (timeline, pending, Queue/Steer/Stop & Send, Fork avanzado, Pause/Stop) · Attention · Approval (alto riesgo exige leer el comando) · Review summary (Proof Pack) · Hosts + Usage · push banner |
| **CLI** | `lxo` interactivo · `status` · `tasks` · `agents` · `attention` (+ `resolve`) · `send` (`--queue/--steer/--stop/--fork`) · `open` (`--ide`) · `review` (`--accept/--reject`) · `task show` · `help` |
| **Showcase** | Overview 4-up con vocabulario compartido · Continuity (7 pasos PC→móvil→PC→IDE sobre el mismo estado) · Guide (preguntas → pantalla, decisiones, qué es simulado) · menú Simulate |

## Design Decisions

El listado completo (D1–D16, formato Problem / Options / Decision / Reason) está también en la pestaña **Guide** de la maqueta (`src/mockup/decisions.js`). Resumen:

| # | Decisión |
|---|---|
| D1 | Aislamiento: rama + worktree propios; todo en `src/mockup` + `mockup.html` fuera del build; `src/ade` no se modifica. |
| D2 | Sidebar adaptativo: 1 Attempt ⇒ la Task es una fila; N ⇒ grupo (máx. 3 + «+N agents»). |
| D3 | Estado y Attention son ejes distintos (forma+color vs marcador ámbar «!»); Unread es un tercero; Waiting siempre lleva causa. |
| D4 | Review ready = púrpura con ojo; Completed = verde con check. |
| D5 | El host solo se ve en la fila si es remoto/offline (o con «Always show host»); siempre en cabeceras y decisiones. |
| D6 | Con el agente ocupado Enter = Queue; Ctrl+Enter = Steer; Ctrl+Shift+Enter = Stop & Send (con confirmación); Fork abre diálogo. Si un proveedor no puede hacer Steer se degrada de forma explícita. |
| D7 | Pending Queue como dock compacto sobre el composer, con procedencia por ítem (ADE/CLI/Mobile/IDE). |
| D8 | Proof Pack antes del diff; evidencia etiquetada auto / agent says / inferred; no se afirma ninguna mejora porcentual. |
| D9 | «Accept» vale solo sobre la revisión mostrada (Attempt + commit), también en móvil y CLI. |
| D10 | Desktop = master-detail; Mobile = bottom tabs. Mismo vocabulario, distinto patrón. |
| D11 | IDE: barra de contexto permanente + «AI WORK» + «Location mismatch»; Take Over / Return en ADE e IDE. |
| D12 | Mobile = Remote Control/Attention; sin diff completo, sin «allow always» en alto riesgo. |
| D13 | `lxo` usa los mismos conceptos e ids; la procedencia (CLI) informa, no crea categoría. |
| D14 | Términos de producto en inglés (como el documento); texto explicativo en español. |
| D15 | Orden estable en el sidebar; un evento de fondo nunca cambia el Active Workspace. |
| D16 | Coordinador→hijas (hueco de la maqueta anterior): provisional en Inspector y Mission Map; sin fijar en el sidebar. |

## Qué es simulado

Todo. Los datos (`data.js`) viven en memoria; `store.js` (zustand) es el «Core» de mentira que comparten las cuatro superficies: Queue/Steer/Stop/Fork, aprobaciones, fin de turno, reconexión de hosts, Take Over, Review y creación de Tasks son `setState` + `setTimeout`. No hay Git, worktrees, terminal, IPC, red, persistencia ni proveedores. Los botones marcados **sim** y el menú **Simulate** son controles de la maqueta, no del producto.

## Preguntas abiertas que la maqueta deja visibles

- Cómo aparece un coordinador (Run) con sus tareas hijas en el árbol principal (D16).
- Si Review ready debe levantar Attention cuando existen Attempts hermanos aún en curso (en la maqueta, el de Agent Runtime B no lo hace).
- Default Queue vs Steer (D6) — es configurable en el menú del composer para probar ambos.
- Cuánto debe mostrar la fila del sidebar (hoy 3 líneas) frente a densidad.

## Iteración de jerarquía — 2026-10-13

Rama codex/design-mockup-hierarchy. La descripción anterior documenta la base; esta iteración añade inspector/contexto/recursos/cola plegables, Review dentro del IDE con continuidad por Attempt, Mobile Attention/Work/More y movimiento reducido. La aceptación queda pendiente de integración. Ver REDISTRIBUCION_2026-10-13.md y VALIDACION_2026-10-13.md para alcance, respaldo y evidencia final. 44 pruebas del mockup aprobadas.

## Orquestador (pestaña «Orquestador») — 2026-10-24

Rehecha desde cero en `apps/desktop/src/mockup/orch/` (entrada `mockup-orch.html`; también la pestaña «Orquestador» del showcase). Sustituye al «Desktop Pulido», que era el ADE genérico con etiquetas de rol. Modelo propio y simulado: `orchData.js` (datos) + `orchStore.js` (el «Core» de mentira). Vocabulario del modo Orquestar real (`src/orch`, `lxo/guide/coordinator.md`); lo que aún no existe va marcado **Plan · Fase N** según `docs/PLAN_ORQUESTADOR.md`.

**Pregunta de la pantalla:** ¿qué necesita de mí el equipo de agentes y qué está listo para integrar? Lo responde la línea bajo el título del run y la lista «Esperan tu decisión».

| Vista | Qué interpreta |
|---|---|
| **Ejecuciones** | Árbol: decisiones pendientes · run activo (issue LXB-48, progreso, coste) · coordinador → hijas con rol, agente·modelo y fase · runs cerrados. Run: KPIs como tipografía, **Reparto del run** (carriles por hija, ticks de fase, dependencia `--after`), Integración propuesta (solo la persona integra), registro de `lxo` del coordinador. Hija: Terminal · Actividad (encargo, resumen, fases, mensajes) · Cambios; aviso de aprobación en terminal, pregunta con respuesta, réplica del adversario, bloqueada, cerrada sin entregar y relanzar (intento N). Inspector: Encargo · Política efectiva · Uso/vivacidad |
| **Lanzamiento pendiente** | Cada `lxo spawn` lo aprueba una persona: política efectiva, línea de lanzamiento, límites reales, confirmación explícita, motivo de rechazo, vence a los 10 min |
| **Revisar → Integrar** | La decisión vale solo para el HEAD revisado (si la rama cambia, «Revisar de nuevo»); Integrar pide confirmación y destino; Detener es de emergencia y avisa al coordinador |
| **Flota** *(Plan · Fase 5)* | Todos los agentes de todas las carpetas, incluido un handoff sin run; vivacidad (vivo · sin verificar · cerrado) sin marcar nunca «cerrado» por perder contacto |
| **Equipo** | Rol → agente · modelo · esfuerzo con validación que falla cerrado (un rol de solo lectura no se asigna a un agente sin modo verificado), registro de agentes (listo · pausado en Windows · falta) y límites del run |
| **Nuevo run** | Coordinar por roles · Comparar agentes *(Fase 5)* · Handoff *(Fase 5)* |

Decisiones de diseño: marco de tres paneles flotantes con hueco de 8 px y jerarquía por relleno (sin bordes); acento lima solo en la acción principal de cada estado; color en datos y estado; sin emoji, sin etiquetas en mayúsculas, mono solo en ids/ramas/cifras; movimiento solo como respuesta (pulsar, abrir diálogo/menú/panel; ≤200 ms, `ease-out` fuerte, sin animar acciones frecuentes, `prefers-reduced-motion`). Simulado todo: agentes, terminales, diffs, costes, vivacidad y tiempos. Pruebas: `src/mockup/orch.test.jsx` (12) · suite completa del mockup 56/56.

## Desktop integrado (pestaña «Desktop integrado», `#desk`) — 2026-10-24

El **ADE acordado con el equipo** (`src/mockup/ade/`) dentro del marco del Desktop real, junto al IDE de la maqueta. Código en `src/mockup/desk/` + `styles/desk.css`; `realShell.css` e `IdeIcons.jsx` son copias de `apps/desktop` (el worktree parte de un commit anterior que no los tiene).

**Marco (igual que el real):** barra de título (marca · proyecto | Agente · Editor · Diseño · Git · Orquestar | buscar · tres paneles · ajustes · equipo · cuenta), el modo activo en paneles flotantes con hueco de 8 px y barra de estado única.

**Distribución**
- *Orquestar* = ADE. Su cabecera propia desaparece: la marca ya está en la barra de título y las seis vistas (Workspace · Attention · Compare · Map · Hosts · Usage) pasan a una **subnavegación pegada arriba del lienzo**, con la ruta Project › Task › Attempt. Con el inspector abierto las pestañas inactivas se reducen a icono (container query). Se quitan los duplicados: «LIXBON ADE», el «Lixbon / TASK» y el botón Jump (lo hace el buscador de la barra de título).
- *Editor* = IDE. Los botones Explorer/Terminal/Agent de su cabecera se quitan: son los tres botones de panel de la barra de título.
- *Panel derecho*: mismo sitio en todos los modos (ADE = detalles de la Task; Editor = agente; Agente/Git/Diseño = agente o cambios).
- *Agente, Git y Diseño*: esqueletos con la distribución real; solo es «vivo» lo que viene del Attempt seleccionado (su conversación, sus archivos y su rama).

**Continuidad:** un único Task/Attempt para todos los modos. «Open in IDE» (ADE) y «Open in ADE» (IDE) cruzan de modo sin perder la selección; la barra de estado muestra la rama del Attempt (→ Git), los agentes trabajando (→ Orquestar) y «N esperan tu decisión» (→ Attention); el modo Orquestar lleva el contador en la barra de título.

**Animación** (Emil Kowalski): cambio de modo con el ratón = fundido de 120 ms; con teclado (**Alt 1…5**) = ninguno (se repite cientos de veces al día). Indicador del selector de modo: `transform` 240 ms con curva fuerte (antes 400 ms de muelle). Inspector y sidecar entran con `translateX(8px)` + opacidad 200 ms; el lienzo del ADE se funde 140 ms al cambiar de vista; botones con `scale(0.97)` al pulsar; hover solo con puntero fino; `prefers-reduced-motion` quita el movimiento. Los modos quedan montados e inertes (`inert` + `visibility`), como `RetainedMode` del Desktop real.

Pruebas: `src/mockup/desk.test.jsx` (7) · suite del mockup 63/63.

## Perfeccionamiento visual y de movimiento del ADE — 2026-10-24

Refina el ADE aprobado (`mockup.html#ade`, última dirección en `REDISTRIBUCION_2026-10-13.md`). No cambia estructura, vistas ni funciones. Respaldo previo: `baseline-2026-10-24.zip`. Todo el CSS nuevo está en `src/mockup/styles/polish.css` (se carga tras `hierarchy.css`) para poder compararlo o retirarlo en bloque. Capturas antes/después: `docs/mockup/capturas-2026-10-24/`.

**Diagnóstico (render real, 1440×900 y 1280×800)**
| Problema | Dónde | Efecto |
|---|---|---|
| La cabecera del Workspace gastaba ~470 px; la Actividad, que es el contenido, se quedaba en ~200 px (170 px a 1280×800) | Workspace | El log, lo que se supervisa, era lo más pequeño |
| El «momento» del Attempt era una tarjeta con borde, barra de color, degradado y tres fichas de métricas | Workspace | Ruido: la lógica de color del sistema pide relleno plano |
| Etiquetas en mayúsculas con tracking (PREVIEW, EXTERNAL WORKTREE, 2 ATTEMPTS, cabeceras de tablas y del Proof Pack…) | Todo el ADE | Jerarquía tipográfica confusa |
| «2 ATTEMPTS» + marca de Attention truncaban el nombre de la Task | Sidebar | «OAuth Refr…» |
| El menú New partía sus títulos en dos líneas | Sidebar | Lectura torpe |
| «Back to workspace» flotaba pegado a las acciones | Review, Proof Pack, Compare | Cabecera cargada |
| Texto cortado en las tarjetas | Mission Map | Se perdía «Run · …» |
| Búsqueda sin resultados: el sidebar quedaba **en blanco** | Sidebar | Sin explicación ni salida |
| 22 reglas `:hover` sin `@media (hover: hover)`; feedback `:active` solo en `.btn`; entradas con `ease-out` débil; `prefers-reduced-motion` anulaba también los fundidos | Movimiento | Hover falso en táctil; controles sin respuesta al pulsar |
| Roturas con datos extremos (break-ui): títulos sin espacios se salían, «Latest» ocupaba 3 líneas, chips del compositor se estiraban, la barra de estado empujaba los contadores fuera | Workspace, Compare, estado | Desbordes |
| El marco integrado recortaba el contenido a ≤1180 px en lugar de adaptarse | Desktop integrado | Controles inaccesibles |

**Cambios hechos** (mismo producto, más acabado)
- *Jerarquía y espacio:* cabecera del Workspace más compacta (objetivo a una línea, hechos del momento en línea en vez de fichas, sin borde ni degradado). Altura de la Actividad medida en el navegador: 272 px a 1440×900 y 252 px a 1280×800 (antes, ~210 y ~170 px, estimadas sobre las capturas «antes»). A ≤840 px de alto la cabecera cede lo accesorio (objetivo, selector Preview, detalle) y la Actividad reserva ≥240 px; si no cabe, desplaza la página.
- *Tipografía:* etiquetas en frase en todo el ADE (sentence case, 12 px 600); tags de estado/riesgo/fuente en frase.
- *Sidebar:* el contador de Attempts es un número con título accesible; el menú New cabe en el sidebar con título y pista apilados; **estado vacío** del filtro («No work matches» + «Clear search»).
- *Pantallas secundarias:* «Back to workspace» ya no pisa la cabecera; Mission Map con nodos de 224×82.
- *Datos extremos:* ajuste de línea en títulos, «Latest» con elipsis, chips del compositor acotados, barra de estado con la rama elidida y los contadores fijos. Nuevo interruptor **Simulate › Worst-case data** (control de la maqueta) para repetir la prueba.
- *Integración en Desktop:* el marco se adapta (≤1320 px solo iconos en los modos, sin nombre de marca; ≤1100 px sin controles de ventana y columnas más estrechas).

**Movimiento** (criterios de `emil-design-eng`, `review-animations`, `animation-performance`)
- Tokens únicos: `--ease-out cubic-bezier(.23,1,.32,1)`, `--dur-press 120ms`, `--motion-fast 140ms`, `--motion-panel/view 180ms`. Sin `ease-in`, sin `transition: all`, solo `transform` y `opacity`.
- Pulsar: `scale(.97)` en controles y `.99` en filas grandes. Hover **solo con puntero fino** (26 reglas).
- Menús y popovers nacen de su disparador (`transform-origin`) con `scale(.96)`+opacidad 140 ms; la marca de estado se redibuja al cambiar (clave en `Mark`, 160 ms); una Attention nueva llega con 180 ms.
- Atajos y cambio de modo por teclado: sin animación. Marco: cambio de modo con ratón = fundido de 120 ms (ver sección anterior).
- `prefers-reduced-motion`: se quitan desplazamientos y bucles; se **conservan** los fundidos de 120 ms (verificado en el navegador: el momento y la marca usan `rm-fade`, los bucles `none`).

**Validado en el navegador** (Edge, capturas): 1440×900 y 1280×800 en oscuro; claro en el Workspace; 1100 px del marco; peor caso (sin desbordes por script en Workspace, Attention, Compare, Map y Hosts); foco por teclado (16 tabulaciones, anillo de 2 px y orden lógico); movimiento reducido; búsqueda vacía. Pruebas: **67/67** (`polish.test.jsx` 4 nuevas; `mockup.test.jsx` actualizada porque «N attempts» pasó a número con título).

**No hecho / decisiones pendientes**
- *Loading y error:* la maqueta no tiene esos estados (todo está en memoria). El producto real tiene `CoreModelNotice`/«Core degradado»; falta decidir si se maqueta (propuesta: aviso dentro del bloque que falla, con última lectura buena y «Reintentar»).
- *Selector Preview:* es control de la maqueta dentro de la cabecera del producto. Propuesta: moverlo al menú Simulate y dejar la cabecera solo con producto (no se hizo: cambia una interacción de demostración).
- *Workspace como página con scroll:* con muy poco alto el compositor queda bajo el pliegue. Se probó un compositor fijo y tapaba las últimas líneas del log; se descartó. Propuesta alternativa: plegar el «momento» a una línea al hacer scroll.
- *Proof Pack y Compare* siguen siendo densos por naturaleza (evidencia); solo se mejoró la tipografía. Un desglose en subvistas queda como propuesta, sin cambio.
- *Mobile, CLI e IDE* no se revisaron a fondo en esta ronda (el IDE solo en el marco integrado).
- *Mockflow:* WireframePro MCP exige un servidor local y login, no está configurado aquí y el diseño aprobado ya está en código, así que no se usó.
- *Marca:* `founder.lixbon.com` solo devolvió texto (sin colores ni tipografías visibles): tono cálido y claro, sin mascota en la home; no se tocaron tokens.
- *Documentos citados:* solo se encontró `LIXBON_IDE_ADE_diseno_investigacion_V2_2026-10-12.md` (en Descargas) y su V1; los demás (modelo-runtime, investigacion-ades, core-multicliente, tareas-pendientes, plan-fase1, docx) no están en Descargas, Documentos ni en el repo.

## Redistribución del espacio del ADE — 2.ª ronda, 2026-10-24

Mismo ADE aprobado, mismas vistas y funciones; cambia cómo se reparte el espacio. Respaldo para volver atrás: `baseline-2026-10-24-pre-redistribucion.zip`. CSS nuevo en `styles/layout.css` (se carga tras `polish.css`; de `polish.css` se retiraron las reglas de cabecera/banda que cambian de estructura para no acumular sobrescrituras). Capturas antes/después a 1440×900, 1280×800 y 1920×1080, con datos normales y `Simulate › Worst-case data`: `capturas-2026-10-24-redistribucion/`. Referencias leídas: Orca (tabs/panes/worktrees), Cursor 3.1 y 3.4, VS Code (agents window, custom layout), Linear Triage, NN/g progressive disclosure; la de Codex devolvió 403 y no se pudo leer. Se extrajeron patrones, no se copió ninguna interfaz.

| Pantalla | Problema original | Cambio | Se conserva |
|---|---|---|---|
| Workspace | Actividad 272 / 252 / 452 px (1440 / 1280 / 1920): cabecera de 5 filas, banda con petición duplicada, tira de Attempts aparte, compositor de ~150 px | Actividad 459 / 359 / 639 px. Cabecera = título+acciones, línea de contexto, línea Attempt/host (la tira de Attempts vive ahí). Banda de estado en una línea. Compositor en reposo = 1 línea + barra (destino, política, modo). Marco a alto fijo: scroll solo en la Actividad | Estado, acciones, Context, cola Pending, Queue/Steer/Stop, política visible, decisión pendiente |
| Compare | Tabla de 10 filas y ~130 px vacíos debajo (a 1440×900) | Arriba resumen fijo (cabeceras con Choose, 7 filas); abajo exploración con Differences / Risks / Evidence (enfoque, archivos, delta factual, riesgos con texto, checks fallidos y no verificados). Explorar no mueve el resumen | Todas las filas, Choose, Proof Pack, Open diff, instrucción para ambos, marca de mejor valor y empate sin ganador |
| Proof Pack | Nueve tarjetas del mismo peso; decisión al final de una página de 1056 px en una vista de 792 | 1 Needs your review (Failed / Not verified con etiqueta de texto y tinte, archivos sensibles, riesgo por gravedad, preguntas) · 2 What it checked (estado en palabras: Passed / Failed / Not run) · 3 Detail plegable. Panel de decisión fijo con Attempt @ revisión y conteos | Todas las pruebas, seguridad, dependencias, riesgos, límites, capturas, Accept solo sobre la revisión mostrada |
| Attention | Pila de 9 tarjetas largas; Activity en columna propia | Lista de solicitudes (grupo, riesgo, Task · Attempt, agente, host) + detalle completo de la seleccionada; ↑/↓; al resolver pasa a la siguiente. Activity debajo de la lista, aparte | Comando, alcance, host, agente, Task, Attempt, política, motivo; lote solo para riesgo bajo (alto: sin casilla ni «always») |
| Sidebar | Marca «!» triplicada (proyecto, grupo, hoja), chip CLI, bloque amarillo de worktree externo | «!» en la fila hoja y en el padre solo si está plegado; CLI como texto en la línea de estado; worktree externo en una fila; banner «N need you» con un solo marcador | Project → Task → Attempt, worktree/branch asociados, estados, filtros, búsqueda |
| Inspector | Duplicaba el objetivo de la cabecera; cierre solo desde la barra superior | Cierre propio (X, Esc, devuelve el foco), anchura que sigue a la ventana, la cabecera oculta su línea de objetivo mientras está abierto | Task / Changes / Context / Autonomy |

**Movimiento.** Sin animación en gestos frecuentes (cambiar de solicitud con flechas, pestaña de exploración, selección de Attempt); con movimiento reducido el detalle de Attention tampoco hace fundido. Lo que aparece sí se mueve: inspector `translateX(8px)`+opacidad 180 ms con la curva fuerte; el chevron del detalle del Proof Pack gira 140 ms.

**Decisiones cerradas que se tocaron:** el selector «Preview» (control de la maqueta) salió de la cabecera del Workspace y está ahora en `Simulate › Preview a Task state`; la cola Pending plegada y el inspector opcional del 13/10 no cambian.

**No resuelto / propuesto:** el inspector sigue acoplado (no flotante) para no tapar contenido, por eso con él abierto a 1280 px el lienzo queda en 780 px y la Actividad en ≥ 200 px en el estado Decision; las pestañas del inspector pasan a dos líneas a ≤ 1300 px; Mission Map, Hosts, Usage, Review, IDE, Mobile y CLI no se tocaron.

## 3.a ronda — vistas restantes y marco integrado — 2026-10-24

Revisadas Review, Mission Map, Hosts, Usage, IDE, Mobile, CLI, Overview y el marco integrado (`#desk`) a 1440x900 (y Review/Map/Hosts/Usage tambien a 1280 y 1920, con datos normales y peor caso): ninguna desborda. Cambios (CSS en `styles/layout.css`, secciones 8-10):

| Pantalla | Problema | Cambio |
|---|---|---|
| Usage | Mas de la mitad del lienzo vacia | Tabla «Per Attempt» (todos los Attempts por coste, estado, host, tokens, total) con columnas fijas y elipsis; con el peor caso no desborda |
| Workspace · Decision | Actividad vacia (el Attempt no tenia eventos) y la banda repetia el riesgo y el alcance de la tarjeta | Linea de tiempo simulada coherente con el Attempt; la banda ya no muestra facts en estado Waiting |
| Hosts | «Archive» parecia texto | Boton `btn--ghost` |
| Inspector | Las 4 pestañas se partian en dos lineas | Una linea (relleno y envoltura ajustados) |
| IDE / marco integrado | El compositor compacto del panel de agente tenia los chips aplastados | En compacto solo adjuntar, modo y enviar; el destino ya esta en la barra de contexto |
| Marco integrado | El Workspace no llenaba el alto (compositor a media altura) | La vista llena el lienzo bajo la barra de vistas |

Sin cambios: Review, Mission Map, Mobile, CLI, Overview (revisados, sin defectos de composicion). Pruebas: 83/83 (`redistribucion.test.jsx` suma 3).

**Pencil:** `ade.pen` pasa a 33 frames (biblioteca de 10 componentes, 8 pantallas en oscuro y claro a 1440, Workspace/Attention/Compare/Proof Pack/Decision tambien a 1280 y 1920). Mission Map no se pudo importar como capas (los nodos son elementos absolutos que la importacion pierde): va como imagen (`pencil-assets/mission-map-1440-*.png`), no editable. Exportaciones: `capturas-pencil-2026-10-24/v4/`.

## 4.a ronda — animaciones — 2026-10-24

Auditoria del movimiento existente (curva, duracion, propiedad) y cierre de huecos, con los criterios de `emil-design-eng`. Ya cumplia: curvas fuertes, <= 200 ms, solo `transform`/`opacity`, sin `transition: all`, nada en atajos de teclado, hover solo con puntero fino, reduced-motion con fundidos. Faltaba la **salida** y varias entradas. CSS en `styles/layout.css` (secciones 11-12); logica en `AdeDesktop.jsx` e `Inspector.jsx`.

| Elemento | Antes | Ahora | Medido |
|---|---|---|---|
| Inspector al cerrar | Desaparecia de golpe | Sale por el borde por el que entro (fundido + 8 px, 140 ms); conserva su columna mientras sale; `inert` mientras sale; reabrir cancela la salida | `leaving` a 50 ms, desmontado a ~100-140 ms |
| Cambio de vista (ADE) | Sin transicion fuera del marco integrado | Fundido de opacidad de 140 ms con el raton; con teclado ninguno (`data-input` marca el origen) | `view-in` 140 ms; teclado: 0 animaciones |
| Dialogos (Fork, New Task, Return, Stop & Send) | Aparecian de golpe | Scrim 140 ms + dialogo con escala .96→1 y opacidad 180 ms; la paleta Ctrl J (teclado) no se anima | `scrim-in` 140, `modal-in` 180; paleta: ninguna |
| Avisos | Entraban; salian de golpe | Salen con fundido 200 ms antes de retirarse (la tienda los quita a los 4,2 s) | `toast-in` + `toast-out` (delay 3,95 s) |
| Grupos del sidebar, cola Pending, Detail del Proof Pack | Aparecian de golpe | Entrada de 160 ms (opacidad + 4 px). Cerrar sigue siendo instantaneo | `fold-in` 160 ms |
| Barras de uso, pastillas, marcas, filas de Attention | Cambiaban de golpe | Transiciones de color/ancho de 140-240 ms | — |

**Probado y descartado:** animar la altura del `<details>` del Proof Pack con `::details-content` + `interpolate-size` (el Edge de pruebas lo soporta, pero con ese bloque flex no interpolaba y solo retrasaba el cierre 200 ms). Se sustituyo por la entrada con fundido.

**Movimiento reducido:** vistas, dialogos, despliegues e inspector pasan a fundidos de 120 ms sin desplazamiento (la salida del inspector es `rm-out`); spinner, puntos y pulso de riesgo alto: 0 animaciones activas.

**Limites:** al desmontarse el inspector el lienzo recupera su ancho de golpe (la columna no se anima: seria animar layout); no hay salida para dialogos ni para grupos plegados; no hay estados de carga/error (la maqueta es todo en memoria). Validado en Edge con la API de animaciones, no con video. Pruebas: 86/86 (`redistribucion.test.jsx` suma 6 en total en estas dos rondas de movimiento y vistas).
