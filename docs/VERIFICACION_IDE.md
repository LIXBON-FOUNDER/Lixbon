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

## 6-bis. Reforma de UX del shell (2026-07-13)

Cambios de dónde vive cada cosa. **Ninguno toca Rust ni el gateway.**

### Panel inferior con pestañas (como VSCode)

Antes: **Problemas** se abría en el panel izquierdo y el Terminal era un dock
aparte. Ahora ambos son pestañas del **mismo dock inferior**.

| Acción | Resultado esperado |
|---|---|
| Clic en el icono ⚠ de la activity bar | Abre el dock inferior en la pestaña **Problemas** |
| Clic otra vez en el mismo icono | Pliega el dock |
| `Ctrl+\`` o icono de terminal | Abre el dock en la pestaña **Terminal** |
| Cambiar de pestaña Problemas ↔ Terminal | La sesión de PTY **sobrevive** (el buffer sigue ahí) |
| Ejecutar Run/Build o `git pull` | Fuerza el dock a la pestaña **Terminal** |
| Contador `0 · 0` de la status bar | Clic abre Problemas; muestra errores · avisos |

> El linter solo corre cuando la pestaña **Problemas** está a la vista (lanza un
> proceso `ruff`/`eslint`); con el Terminal delante no gasta nada.

### Ajustes y Consumo como ventana flotante

Antes ocupaban el centro y **echaban al usuario del editor**. Ahora se
superponen: al cerrarlos (**Esc**, clic fuera o la ✕) el código sigue donde
estaba, con las mismas pestañas abiertas.

- Se abren desde: activity bar (⚙ y 📊), menú **Ver**, paleta de comandos, y
  el chip del plan en la status bar (→ Consumo).
- Verificar: abre un archivo, entra a Ajustes, ciérralo → **la pestaña y el
  cursor siguen igual**.

### Ajustes por secciones

Era una columna con diez paneles seguidos. Ahora hay navegación lateral con un
buscador: **Cuenta · Apariencia · Editor · IA · Agente · Índice (RAG) · Atajos ·
Avanzado**.

- Verificar que cada ajuste sigue **persistiendo** (cámbialo, cierra la ventana,
  reábrela): tema, tamaño de letra, autoguardado, formatear al guardar,
  tabulador, ghost text + modelo, modelo de visión, ventana de contexto, modo
  agente, permisos de comandos, allowlist, RAG y atajos.
- El buscador filtra por nombre de sección y palabras clave (p. ej. «rag»,
  «tema», «comandos»).

### Desplegables propios

Los `<select>` nativos los pintaba Windows (fondo blanco, fuente del SO), así que
rompían el tema oscuro. Sustituidos por `components/Select.jsx`.

- Dónde: modelo de autocompletado, modelo de visión, ventana de contexto, modelo
  de embeddings y el **picker de shell** del terminal (este abre **hacia arriba**).
- Verificar: teclado completo (↑ ↓ para navegar, Enter selecciona, Esc cierra sin
  cerrar la ventana de Ajustes) y clic fuera para cerrar.

---

## 6-ter. A1 · Servidores de lenguaje (LSP) — 2026-07-13

**Qué resuelve.** La inteligencia de código que la gente busca en las extensiones
de VSCode no vive en la extensión: vive en su **servidor**. La extensión de
Python es un envoltorio de Pyright; la de Rust, de rust-analyzer. Esos servidores
hablan **LSP**, un protocolo abierto — así que hablamos con ellos directamente,
sin ejecutar una línea de código de extensión.

**Lo que aporta:** autocompletado real (con tipos, no con palabras del archivo),
errores en vivo, *hover* con documentación e **ir a definición (F12)**.

### Arquitectura

- **Rust** (`lsp_start` / `lsp_send` / `lsp_stop`) hace **solo de transporte**:
  lanza el servidor, desenmarca el framing (`Content-Length: …`) y emite cada
  mensaje por `lsp:msg:{id}`. Mismo patrón de proceso largo que el PTY.
- **`lib/lspClient.js`** habla JSON-RPC: handshake, ciclo de vida del documento,
  peticiones, y **responde a lo que el servidor nos pregunta** (`workspace/configuration`
  — sin esto Pyright se queda colgado al arrancar).
- **`store/lspStore.js`**: un proceso por servidor, no por archivo
  (typescript-language-server sirve .ts/.tsx/.js/.jsx a la vez). Arranque perezoso.
- **`editor/lspExt.js`**: completado, hover y F12 en CodeMirror.

### Los servidores se instalan solos

Al abrir el primer archivo de un lenguaje, si su servidor falta **se descarga e
instala solo** (ajuste *Instalar servidores automáticamente*, ON por defecto).
La status bar muestra «Instalando Pyright…» mientras tanto.

Se instalan **dentro del app-data de lixbon**: no son globales, no piden
permisos de administrador y no tocan el PATH. Si el usuario ya tiene uno
instalado por su cuenta, **ese tiene prioridad** (Rust resuelve app-data → PATH).

| Servidor | Automático | Prerequisito |
|---|---|---|
| Pyright (Python) | ✅ npm | **Node.js** |
| TypeScript / JavaScript | ✅ npm | **Node.js** |
| JSON · HTML · CSS · YAML | ✅ npm | **Node.js** |
| rust-analyzer | ✅ .zip de GitHub (Windows) | — |
| gopls (Go) | ❌ manual | toolchain de **Go** |
| clangd (C/C++) | ❌ manual | **LLVM** |

> Los dos manuales lo son por su naturaleza: `gopls` se **compila** con la
> toolchain de Go, y el release de `clangd` lleva la versión en el nombre del
> archivo (no hay URL estable). Ajustes → Lenguajes muestra el comando exacto.

> **Ojo Windows:** los servidores de npm quedan como `.cmd`, y `CreateProcess`
> **no ejecuta scripts** (solo `.exe`). Por eso Rust resuelve el PATH a mano con
> `PATHEXT` y lanza los `.cmd` vía `cmd /C`.

### Verificación

| Paso | Resultado esperado |
|---|---|
| Abrir una carpeta con un proyecto Python y un `.py` (Node.js instalado) | Status bar: «Instalando Pyright…» → luego Ajustes → Lenguajes muestra **Pyright · activo** |
| Ajustes → Lenguajes, botón **Instalar** | Instala ese servidor sin abrir ningún archivo |
| Sin Node.js instalado | El servidor npm falla con *«Necesitas Node.js instalado»* (no rompe el editor) |
| Escribir `import os` y luego `os.` | Autocompletado **con miembros reales** de `os` (no palabras del archivo) |
| Escribir un error (`x: int = "a"`) | Subrayado rojo + fila en **Problemas**, sin pulsar nada |
| Pasar el ratón sobre una función | Hover con su firma y documentación |
| Cursor sobre una función y **F12** | Salta a su definición (aunque esté en otro archivo) |
| Paleta → «Ir a definición» | Lo mismo |
| Cambiar de carpeta de trabajo | Los servidores se **matan** (se relanzan solos al abrir un archivo) |
| Apagar LSP en Ajustes | Vuelven ruff/eslint como fuente de Problemas |

> Con un servidor LSP activo, **él sustituye a ruff/eslint**: publicar dos veces
> los mismos errores solo duplicaría los avisos.

**Si algo falla:** abre DevTools (Ctrl+Shift+I) — el stderr del servidor se
reenvía a la consola con el prefijo `[lsp:<id>]`.

### Bug del tabulador (arreglado)

`indentWithTab` de CodeMirror **siempre re-indenta la línea entera**: al pulsar
Tab con el cursor a mitad de línea, el espacio aparecía al *principio*. Ahora Tab
inserta la indentación **en el cursor** (hasta la siguiente parada de
tabulación), y solo re-indenta líneas cuando hay una selección. Mayús+Tab sigue
quitando indentación.

- Verificar: cursor a mitad de línea + Tab → el hueco sale **donde está el
  cursor**. Seleccionar varias líneas + Tab → se indentan todas.

---

## 6-quater. Barra de estado (estilo VSCode) — 2026-07-13

**Criterio:** en la barra van los ajustes que se cambian **a menudo y en el
contexto del archivo abierto**. Los que se tocan una vez siguen en Ajustes.

### Izquierda

| Item | Qué hace |
|---|---|
| ● Conectado · 141 ms | Estado del gateway (como antes) |
| ⎇ `master*` | Rama actual; el `*` indica cambios sin confirmar. Clic → panel de Git. Solo aparece si la carpeta es un repo |
| ⟳ | Actualiza el estado de Git |
| ⊗ 0 ⚠ 0 | Errores y avisos del archivo. Clic → pestaña **Problemas** |
| «Instalando Pyright…» | Solo mientras un servidor se instala o arranca |

### Derecha

| Item | Qué hace |
|---|---|
| `Ln 9, Col 42` | Posición del cursor (y `(N sel.)` si hay selección) |
| **`Espacios: 2`** | **Menú de indentación**: espacios ↔ tabulaciones y tamaño 2/4/8. Es el acceso directo que pediste |
| `LF` / `CRLF` | **Menú de fin de línea**; cambiarlo reescribe el archivo |
| `javascript` | Lenguaje detectado |
| ● `Pyright` | Servidor de lenguaje del archivo (verde = activo). Clic → Ajustes → Lenguajes |
| `qwen2.5-coder` | Modelo de IA activo |
| **📊 Consumo · Plan Pro** | Abre la ventana de **Consumo** |
| `v0.7.0` | Versión |

### Bug de CRLF que salió al hacerlo (arreglado)

CodeMirror serializa con `\n` salvo que se le diga otra cosa: `doc.toString()`
**siempre** devuelve LF. Es decir, **abrir y guardar un archivo CRLF lo reescribía
entero a LF** — y git lo veía como un cambio de *todas* las líneas.

Ahora el fin de línea se **detecta al abrir** (`EditorState.lineSeparator`) y se
conserva al guardar (`state.sliceDoc()` en vez de `doc.toString()`).

- **Verificar:** abre un archivo con CRLF (la barra debe decir `CRLF`), toca una
  línea, guarda y mira `git diff` → **solo debe salir esa línea**, no el archivo
  entero.

---

## 6-quinquies. Cuenta y foto de perfil — 2026-07-13

**Requiere desplegar el gateway** (columna nueva + endpoints) y tener **R2
configurado** (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`). Sin R2, la subida responde 503 con un mensaje claro y
todo lo demás sigue funcionando.

### Dónde vive la imagen

En **R2**, no en el disco de Railway (que es efímero: se perdería en cada
redeploy). La fila `users` solo guarda `avatar_key`.

El bucket es **privado**, así que `GET /api/avatar/{token}` hace de **proxy**: la
credencial de R2 nunca sale del servidor. Ese GET es **público a propósito** — la
key lleva un token aleatorio de 128 bits (impredecible) y así la **misma URL vale
para la web (cookie) y para el IDE (Bearer)**: un `<img src>` no puede mandar
cabeceras de autenticación.

### Verificación

| Paso | Resultado esperado |
|---|---|
| IDE: clic en la foto (arriba a la derecha) | Menú con nombre, correo, plan, y acciones |
| «Subir foto» → elegir un PNG | La foto aparece en la barra de título al instante |
| Recargar la **web** → barra lateral y Ajustes → Perfil | **La misma foto** (mismo usuario, misma BD) |
| Subir desde la **web** → reabrir el IDE | La foto se ve también ahí |
| Subir un archivo de 5 MB | «La imagen pesa 5.0 MB y el límite son 3 MB» (no se sube) |
| Renombrar un `.txt` a `.png` y subirlo | Rechazado: el servidor comprueba la **firma** del archivo, no solo el tipo declarado |
| «Quitar foto» | Vuelve la inicial del nombre, en web e IDE |

> El plan del menú y el de la barra de estado (`Consumo · Plan Pro`) salen de
> `user.plan_name`: cambian solos con el plan y se pintan con su color.

---

## 7. Checklist final rápido

- [ ] Las 3 versiones sincronizadas + tag `v0.7.0` pusheado
- [ ] CI verde (sin errores de Rust; MSI + `.msi.sig` subidos)
- [ ] Gateway desplegado (para B1 ghost text y B3 RAG)
- [ ] Modelos en Ollama: `qwen2.5-coder`, `nomic-embed-text`
- [ ] **`run_command` funciona** (probar B4 o A4 → si falla, el binario no lo trae)
- [ ] M0 paleta · M1 Ctrl+K + agente · M2 ghost/@/RAG · M3 Git · M4 problemas/outline/formato · M5 preview/bienvenida/atajos
- [ ] UX: dock inferior con pestañas · Ajustes/Consumo en ventana flotante · Ajustes por secciones · dropdowns propios
- [ ] **A1 LSP**: servidor instalado → autocompletado real, errores en vivo, hover, F12 (ver §6-ter)
- [ ] Barra de estado: rama, indentación, LF/CRLF, Consumo (§6-quater)
- [ ] **Foto de perfil**: gateway desplegado + R2 configurado; se sincroniza web ↔ IDE (§6-quinquies)

> Si algo falla, anota: (1) qué función, (2) qué esperabas, (3) el error exacto
> (consola del IDE con F12 / DevTools, o el log del CI). Con eso lo depuramos.
