# Brief para llevar el ADE a Pencil (pen.dev) — 2026-10-24

Fuente de verdad: el ADE de la maqueta (`mockup.html#ade`) tras la 2.ª ronda de redistribución. Las capturas de referencia están en `capturas-2026-10-24-redistribucion/despues/` (1440×900, 1280×800, 1920×1080; datos normales y peor caso). Nada de esto es producto: datos simulados.

## Marco de trabajo
- Un archivo `docs/mockup/ade.pen` (versionado con la maqueta). Un frame por pantalla, **1440×900**, tema oscuro; después una variante clara solo del Workspace.
- Disposición del frame (de izquierda a derecha, hueco 0, sin bordes ni sombras; la jerarquía la dan los rellenos):
  barra superior de vistas 42 px · sidebar **260** · lienzo flexible (alto 792) · inspector **280** (solo Workspace con Details abierto) · barra de estado 26 px.

## Tokens (de `apps/desktop/src/styles/base.css`)
| | Oscuro | Claro |
|---|---|---|
| surface-0 … 6 | `#070707 #111111 #161616 #1C1C1C #222222 #2A2A2A #333330` | `#E6E7DD #F3F4EB #F8F9F2 #ECEDE2 #E4E5D8 #DADBCB #CFD0BE` |
| ink / body / 70 / 50 / 35 | `#F2F2EE #DCDCD6 #B5B5AF #85857F #5E5E59` | `#171713 #2E2E28 #45453F #66665E #85857B` |
| accent (lima) | `#C6D66E` sobre `#0B0B0B` | `#5E7014` sobre `#FFFFFF` |
| info / good / warn / danger / merged | `#8EC5FF #86D694 #E8C872 #F08C7C #B69CFF` | `#1F6FC2 #1E7A38 #8F6410 #B3321F #6B45C8` |
| code-bg | `#0B0B0B` | `#FBFBF6` |

Tipografía: Hanken Grotesk (UI) y JetBrains Mono (ids, ramas, comandos, cifras). Títulos de pantalla 19–24 px / 650; contenido 12.5–13 px; metadatos 11–12 px. Radio base 7 (tarjetas 10, bandas 12). Etiquetas en frase, no en mayúsculas. El estado se marca con **forma + texto**, no solo color (círculo girando = trabajando, ojo relleno = Review ready, ✕ = fallo…). Attention es un eje aparte: marcador ámbar «!».

## Pantallas y regiones (medidas a 1440×900, lienzo 1180 × 792)
1. **Workspace — Agent Runtime, Attempt A, Running.** Cabecera (≈110): título 24 + pill de estado + [Open in IDE · Actions]; línea de contexto (Lixbon · Task · objetivo en una línea); línea Attempt (tira A | B | Fork as Attempt) + host + Context. Banda de estado (≈70, relleno `tone` 8,5 %): estado · titular · detalle, facts a la derecha, etapas Prepare→Integrate finas debajo. Pestañas Activity/Changes/Terminal/Artifacts. **Actividad = 459 px** (surface-2). Pending plegado (30). Compositor: 1 línea + barra (+ · to Attempt A · agente · política · hint · modo Queue · enviar).
   Variantes: **Decision** (Mobile Remote, Waiting · approval: tarjeta de permiso bajo la banda, Actividad ≈340) y **Review ready** (Codex Sol, Attempt B).
2. **Compare — OAuth Refresh.** Cabecera + chip ContextPackage. Resumen fijo: cabeceras de columna (Attempt, agente, pill, branch, host, **Choose X**) y 7 filas (Files changed, Lines, Tests, Time, Usage, Warnings, Risks; ★ en el mejor, empate sin ganador). Exploración (surface-1): pestañas Differences / Risks / Evidence + «instrucción para ambos».
3. **Proof Pack — Attempt B @ c77d0be (Agent Runtime).** Columna principal 840: ① Needs your review (Failed rojo, Not verified ámbar, archivos sensibles, riesgo por gravedad) · ② What it checked (tabla con Passed/Failed/Not run) + Security & dependencies · ③ Detail plegable. Columna derecha 300, fija: Decision for … Attempt B @ rev, conteos, Review changes →, Accept @ rev, Reject.
4. **Attention.** Lista 400 (surface-1: grupo, riesgo, Task · Attempt, agente, host; casilla de lote solo en riesgo bajo) + Activity debajo, aparte · detalle de la seleccionada (comando, riesgo, motivo, alcance, política, Deny / Allow once).
5. Sidebar común: Project → Task → Attempt (marca «!» solo en la hoja), fila «9 need you», búsqueda, filtros.

## Orden de trabajo en Pencil
Tokens como variables → componentes (fila de sidebar, pill de estado, chip, tarjeta de Attention, fila de tabla) → las cuatro pantallas → variantes Decision / Review ready / claro → exportar PNG y comparar con las capturas de referencia.

## Estado en Pencil (2026-10-24)

`ade.pen` contiene 12 frames de 1440x860 (el ADE sin la barra de la maqueta): Workspace Running, Workspace Decision, Attention, Compare, Proof Pack OAuth B y Proof Pack Runtime B, cada uno en oscuro (fila 1) y claro (fila 2, misma estructura con `theme: {mode: light}`). Los colores que coinciden con un token del ADE estan enlazados a variables (`surface-0..6`, `ink*`, `accent`, `on-accent`, `info`, `good`, `warn`, `danger`, `merged`, `code-bg`) con tema dark/light; los tintes con transparencia siguen en hex. Tipografias: Hanken Grotesk, JetBrains Mono y Bruno Ace SC (marca). Exportaciones: `capturas-pencil-2026-10-24/v2/`.

Capas importadas de la maqueta en vivo (herramienta `browser` de Pen), no componentes. Pendiente: componentes reutilizables (fila de sidebar, pastilla de estado, etiqueta de riesgo, tarjeta de Attention, fila de tabla), variantes a 1280 y 1920, y el contenido que la maqueta oculta tras scroll (p. ej. las filas de Ready for your review en Attention). Nota: el navegador integrado de Pen congela las animaciones CSS; para importar estados recien cambiados hay que desactivarlas antes (`*{animation:none!important}`), si no los bloques con fundido de entrada se importan a opacidad 0.

### Actualizacion (componentes y variantes)

`ade.pen` tiene ahora 25 frames: biblioteca `Componentes · ADE` (arriba, y=-700; 10 componentes: 3 marcas de Attention, 3 etiquetas de riesgo, 4 pastillas de estado), 6 pantallas x oscuro/claro a 1440, y las mismas 6 en oscuro a 1280x800 (fila y=1960) y 1920x1080 (fila y=2920). 316 apariciones sustituidas por instancias de esos componentes en todos los frames. Limite conocido: los iconos de marca de estado de las pastillas Thinking y Review ready no se importaron (la importacion no traduce ese SVG). Exportaciones: `capturas-pencil-2026-10-24/v3/` (v2 queda como version previa).
