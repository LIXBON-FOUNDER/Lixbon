# Verificación del IDE — funciones nuevas (sesión 2026-07-12)

Guía práctica para **compilar (vía GitHub CI), desplegar el gateway y verificar
una por una** todas las funciones añadidas. Marca cada casilla al probarla.

> **Alcance de la sesión:** M0 (paleta+comandos), M1 (Ctrl+K, seguridad de
> comandos del agente), M2 (ghost text, @-menciones, RAG), M3 (Git pro), M4
> (Problemas, Outline, Formatear), M5 (Preview, Bienvenida, Atajos).
> **No incluido:** A1 LSP y D2 split-editors (pendientes).
> **Dato clave:** en esta sesión **no se añadió ningún comando Rust nuevo**; todo
> se apoya en `run_command`, `gitRun` y los comandos de archivo ya existentes.

---

## 0. ANTES de compilar/desplegar (obligatorio)

### 0.1 Sincronizar las 3 versiones y taggear
Ahora mismo están **desincronizadas** (romperían el CI):
- `apps/desktop/package.json` → `0.6.3`
- `apps/desktop/src-tauri/tauri.conf.json` → `0.6.4`
- `apps/desktop/src-tauri/Cargo.toml` → `0.6.4`

**Ponlas las tres iguales** (sugerido: **`0.7.0`**, por ser un release grande) y luego:
```
git add -A && git commit -m "feat: IDE M0–M5 (paleta, Ctrl+K, ghost text, RAG, Git pro, problemas, preview…)"
git tag v0.7.0
git push origin master --tags
```
El workflow `.github/workflows/tauri.yml` compila el Rust (`portable-pty`, `zip`,
y **valida `run_command`**), firma y sube el MSI. **Vigila en el log del CI:**
- que diga *"Found signature file …msi.sig"* (updater),
- que la subida a `/api/versions/upload` responda 2xx,
- que **no** haya errores de compilación en `src-tauri/` (aquí se valida `run_command`).

### 0.2 Desplegar el gateway (Railway)
Se añadieron endpoints en `core/gateway/routers/chat.py` y `core/inference/ollama.py`.
**Sin desplegar, no funcionan:** ghost text (B1) ni el índice RAG (B3).
- `POST /api/fim` — autocompletado fill-in-the-middle.
- `POST /api/embed` — embeddings para el índice.
- flag `no_persist` en `/v1/chat/completions` — usado por Ctrl+K (efímero).

> Ctrl+K (B2) **funciona igual sin desplegar**, pero sin `no_persist` cada edición
> dejaría una conversación en el historial. Con el deploy, es efímero.

### 0.3 Requisitos de entorno (para que TODO se pueda probar)
En la máquina donde corre Ollama / el nodo GPU:
- **Modelo de código con FIM** (ghost text + Ctrl+K): `ollama pull qwen2.5-coder:7b`
- **Modelo de embeddings** (RAG): `ollama pull nomic-embed-text`
- **(ya lo tienes)** visión: `llava`
En la máquina donde corre el IDE (para linters/formateo/git):
- `git` en el PATH (M3)
- Opcionales por lenguaje: `ruff` (py-lint), `eslint` (js-lint), `prettier`,
  `black`, `rustfmt`, `gofmt` (formateo). Si faltan, la función avisa sin romper.

---

## 1. M0 — Paleta de comandos y atajos

| # | Qué probar | Pasos | Resultado esperado |
|---|-----------|-------|--------------------|
| ☐ | **Paleta** | `Ctrl+Mayús+P` | Se abre un overlay; escribe "guardar", "terminal", "git" → filtra; Enter ejecuta |
| ☐ | Toggle paleta | `Ctrl+Mayús+P` otra vez | Se cierra |
| ☐ | Atajos previos siguen vivos | `Ctrl+P` (ir a archivo), `Ctrl+S`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+Mayús+F`, `` Ctrl+` `` | Cada uno hace lo de siempre (ahora pasan por el keymap) |
| ☐ | Nuevo: explorador | `Ctrl+B` | Muestra/enfoca el explorador |

**Flujo:** todo comando del IDE está en un registro central (`lib/commands.js`); la
paleta y los atajos (`lib/keymap.js`) lo ejecutan por id. Las fases nuevas registran
sus comandos ahí, así que **todo lo de abajo aparece en la paleta**.

---

## 2. M1 — IA: Ctrl+K y comandos del agente

### 2.1 B2 · Edición inline con IA (Ctrl+K)
**Requiere:** un modelo seleccionado en el chat.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Selecciona un bloque de código en el editor y pulsa `Ctrl+K` | Aparece un widget flotante sobre la selección |
| ☐ | Escribe "añade manejo de errores" y Enter | Se ve "Generando…"; luego el código se reemplaza y aparece un **diff inline** (verde/rojo) |
| ☐ | Usa los botones Aceptar/Rechazar por bloque | Aceptar deja el cambio; Rechazar restaura el original |
| ☐ | `Ctrl+K` sin selección (cursor en una línea) | Toma la línea actual como objetivo |
| ☐ | `Esc` mientras genera | Cancela sin tocar el código |

**Flujo:** `Ctrl+K` → `editor/InlineEdit.jsx` → `lib/inlineEdit.js` (stream al chat con
`no_persist`) → `editorStore.applyInlineEdit` reemplaza el rango y pinta el diff con
`@codemirror/merge` (el mismo que usa el agente).

### 2.2 B4 · El agente ejecuta comandos (con aprobación)
**Requiere:** `run_command` compilado (tag del 0.1) + carpeta abierta + modo Agente ON.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | En el chat (agente ON) pide: "ejecuta `npm test` y dime el resultado" | Como `npm test` está en la allowlist → se ejecuta **sin** preguntar |
| ☐ | Pide: "ejecuta `rm -rf build`" (o algo fuera de la lista) | Aparece **tarjeta de aprobación** con `$ comando` y botones **Ejecutar / Ejecutar siempre / Rechazar** |
| ☐ | Pide un comando con `&&` o `|` (p. ej. "`npm test && echo ok`") | **Siempre** pide aprobación (aunque el prefijo esté permitido) |
| ☐ | Ajustes → Agente → "Ejecutar comandos sin preguntar" ON | Ya no pide aprobación para ningún comando (modo riesgo) |
| ☐ | Ajustes → Agente → editar la lista de "Comandos permitidos" | Un prefijo por línea; se respeta al ejecutar |

**Flujo:** el agente llama a la herramienta `run_command`; `chatStore._needsApproval`
decide: los comandos **siempre** piden confirmación salvo que estén en la allowlist
(y sin encadenamiento `&& | ; $() > <`) o que actives el auto-run. Es independiente
del "aplicar cambios de archivos sin preguntar".

> **Si falla con un error tipo "comando no soportado / invoke error":** significa que
> el binario NO trae `run_command` → revisa que el tag compiló `src-tauri/` sin errores.

---

## 3. M2 — Ghost text, @-menciones y RAG

### 3.1 B1 · Autocompletado fantasma (ghost text)
**Requiere:** gateway desplegado (`/api/fim`) + modelo FIM (`qwen2.5-coder`).

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Ajustes → Editor → "Autocompletado con IA" ON | (opcional) elige el modelo; por defecto autodetecta uno con "coder" |
| ☐ | Escribe dentro de una función y espera ~1 s | Aparece una **sugerencia en gris** tras el cursor |
| ☐ | `Tab` | Inserta la sugerencia |
| ☐ | `Esc` o sigue escribiendo | La sugerencia desaparece |
| ☐ | Apágalo en Ajustes | No vuelve a sugerir (la extensión queda inerte) |

**Flujo:** al teclear (debounce ~350 ms) `editor/ghostText.js` recorta prefijo/sufijo
(`lib/fim.js`) y pide a `/api/fim`; Ollama aplica el template FIM del modelo.

### 3.2 B3 · @-menciones de archivos
| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | En el chat escribe `@` | Aparece un menú de archivos del workspace |
| ☐ | Sigue escribiendo el nombre | Filtra (fuzzy); ↑/↓ y Enter/Tab seleccionan |
| ☐ | Selecciona uno | Se añade un **chip `@nombre`**; el `@token` se quita del texto |
| ☐ | Envía (chat normal, agente OFF) | El contenido del archivo se inyecta como contexto |
| ☐ | Envía (agente ON) | Se pasa como **referencia** (el agente lo lee con `read_file`) |

### 3.3 B3 · Índice del codebase (RAG)
**Requiere:** gateway desplegado (`/api/embed`) + modelo de embeddings.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Ajustes → "Índice del codebase (RAG)" → elige modelo de embeddings | Autodetecta uno con "embed" si existe |
| ☐ | Pulsa **Construir** | Muestra progreso "construyendo… N/M"; al terminar: "N fragmentos · modelo X" |
| ☐ | Comprueba que se creó `.lixbon/index.json` en la carpeta | El índice se guarda dentro del workspace |
| ☐ | Activa "Usar contexto del codebase" y pregunta en el chat "¿dónde se valida el login?" | La respuesta usa fragmentos relevantes del repo |
| ☐ | Con el agente: pídele algo que requiera buscar | Usa la herramienta `search_codebase` |

**Flujo:** `lib/codebaseIndex.js` trocea los archivos de texto, pide embeddings a
`/api/embed`, guarda vectores en `.lixbon/index.json` (comandos de archivo del sandbox)
y busca por **coseno** en JS. El chat normal inyecta el top-5; el agente lo consulta
con `search_codebase`.

---

## 4. M3 — Git profesional
**Requiere:** abrir una carpeta que sea repositorio git + `git` en el PATH.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Abre el panel Git (icono de rama en la ActivityBar) | Muestra rama y cambios |
| ☐ | **C1** Haz clic en un archivo modificado | Se abre el **visor de diff** en el centro (unified coloreado) |
| ☐ | **C2** Pulsa "Historial" | Lista de commits recientes |
| ☐ | Haz clic en un commit | Muestra su diff completo |
| ☐ | **C3** Haz clic en el nombre de la rama | Menú de ramas: cambiar o crear (campo "Nueva rama…") |
| ☐ | **C3** Pulsa "Stash" y luego "Stash pop" | Guarda y recupera los cambios |

**Flujo:** todo en JS vía `gitRun` (que ejecuta cualquier subcomando git). El diff se
muestra en `centerView: 'diff'` (`sections/SourceControl/DiffView.jsx`).

---

## 5. M4 — Inteligencia de código

### 5.1 A2 · Problemas / linter
**Requiere:** `ruff` (Python) o `eslint` (JS/TS) en el PATH + `run_command`.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Abre un `.py` con un error y pulsa el icono ⚠ (Problemas) en la ActivityBar | Ejecuta el linter; lista errores/avisos |
| ☐ | Mira el editor | Subrayados rojos/amarillos + marcas en el gutter |
| ☐ | Haz clic en un problema | Salta a la línea |
| ☐ | Cambia de archivo con el panel abierto | Re-analiza el nuevo archivo |

### 5.2 A3 · Esquema (outline)
| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Abre un archivo de código y pulsa el icono de lista en la ActivityBar | Lista clases/funciones/métodos |
| ☐ | Haz clic en un símbolo | Salta a su línea |

(Extracción por regex; soporta JS/TS, Python, Rust, Go, Java. Sin dependencias.)

### 5.3 A4 · Formatear documento
**Requiere:** `prettier`/`black`/`rustfmt`/`gofmt` según el lenguaje + `run_command`.

| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Abre un archivo y pulsa `Mayús+Alt+F` (o paleta → "Formatear documento") | El archivo se reformatea |
| ☐ | Ajustes → Editor → "Formatear al guardar" ON, y guarda con `Ctrl+S` | Formatea al guardar (solo guardado manual, no autosave) |
| ☐ | En un lenguaje sin formateador instalado | Avisa con un mensaje, sin romper |

---

## 6. M5 — Ergonomía

### 6.1 D3 · Vista previa Markdown/HTML
| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Abre un `.md` y ejecuta (paleta) "Vista previa (Markdown/HTML)" | Split: editor a la izquierda, preview a la derecha |
| ☐ | Escribe en el editor | La preview se actualiza **en vivo** |
| ☐ | Abre un `.html` y activa la preview | Se renderiza en un iframe aislado (sandbox) |

### 6.2 D4 · Bienvenida + recientes
| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Cierra la carpeta / arranca sin workspace | Aparece la pantalla de **Bienvenida** |
| ☐ | Abre una carpeta; ábrela y ciérrala un par de veces | Aparece en **Recientes**; clic reabre |
| ☐ | Quita una de recientes (X) | Desaparece de la lista |

### 6.3 D5 · Editor de atajos
| # | Pasos | Resultado esperado |
|---|-------|--------------------|
| ☐ | Ajustes → "Atajos de teclado" | Lista de comandos con su combinación |
| ☐ | Clic en la combinación de un comando y pulsa una nueva (con Ctrl/Alt) | Se reasigna en caliente; el atajo viejo queda libre |
| ☐ | Prueba el nuevo atajo | Ejecuta el comando |
| ☐ | "Restaurar por defecto" | Vuelve todo a los atajos originales |

---

## 7. Checklist final rápido

- [ ] Las 3 versiones sincronizadas + tag `v0.7.0` pusheado
- [ ] CI verde (sin errores de Rust; MSI + `.msi.sig` subidos)
- [ ] Gateway desplegado (para B1 ghost text y B3 RAG)
- [ ] Modelos en Ollama: `qwen2.5-coder`, `nomic-embed-text`
- [ ] **`run_command` funciona** (probar B4 o A4 → si falla, el binario no lo trae)
- [ ] M0 paleta · M1 Ctrl+K + agente · M2 ghost/@/RAG · M3 Git · M4 problemas/outline/formato · M5 preview/bienvenida/atajos

> Si algo falla, anota: (1) qué función, (2) qué esperabas, (3) el error exacto
> (consola del IDE con F12 / DevTools, o el log del CI). Con eso lo depuramos.
