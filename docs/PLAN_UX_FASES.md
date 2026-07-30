# Plan por fases · Identidad y funciones (CLI + IDE)

> Fuente de verdad del trabajo de producto sobre las dos superficies de trabajo
> de Lixbon: el **CLI** (`apps/cli`) y el **IDE de escritorio** (`apps/desktop`).
> Complementa a `docs/DISENO_WEB.md` (tokens visuales) y a `docs/PLAN_IDE.md`
> (arquitectura del IDE, ejes A–D). Aquí se decide **cómo se siente** el
> producto y **qué sabe hacer**, no cómo está construido por dentro.

Última revisión: 2026-07-30.

---

## 1. Diagnóstico de partida

Lo que ya está bien y no se toca:

- El CLI tiene una arquitectura modular sana (`lixbon_cli/*.py` → `client_cli.py`
  generado) y una paleta propia derivada del ícono.
- El IDE tiene tokens compartidos con la web (Bruno Ace SC / Bricolage
  Grotesque, crema `#F6F7ED`, tinta `#171717`) y un modo oscuro definido.
- El modo agente, el PTY, Git y las extensiones funcionan.

Lo que falla y motiva este plan:

| Síntoma | Causa real |
|---|---|
| La barra de estado del CLI no se veía nunca | `prompt_toolkit` borra la fila reservada con `erase_down()` en su primer render; el CLI la pintaba antes y nadie la repintaba después |
| Tras cerrar sesión, el CLI entraba «sin modelos» | Cualquier fallo de red y un `401` acababan en el mismo sitio: lista vacía y ningún mensaje accionable |
| Pocos comandos y poco selector | Casi todo se hacía escribiendo argumentos exactos; el selector solo se usaba en 4 sitios y no sabía filtrar |
| «Parece una app de Flutter» | Superficies planas con radios grandes, mucho contenedor y poco ritmo tipográfico: nada de eso es *marca*, es plantilla |

---

## 2. Reglas de identidad (aplican a CLI, IDE, web y móvil)

Estas siete reglas son el criterio para aceptar o rechazar cualquier pantalla
nueva. Una interfaz «bien hecha con imagen propia» no es una interfaz con más
adornos: es una que **repite las mismas decisiones** en todas partes.

1. **Densidad antes que aire decorativo.** Somos una herramienta de trabajo:
   la información va junta y ordenada, no separada por tarjetas huecas.
2. **Nada de cajas dentro de cajas.** Como máximo un nivel de contenedor. Las
   zonas se separan con reglas horizontales y espaciado, no con bordes anidados.
3. **El acento verde-oliva se gana.** Solo marca: identidad, selección activa,
   acción del agente que toca el disco. Si todo es acento, nada lo es.
4. **Jerarquía por tono, no por tamaño.** Crema → gris → gris apagado. Tres
   niveles, siempre los mismos: contenido, metadato, susurro.
5. **Verbos en pasado para lo que hizo el agente** (`editó`, `ejecutó`), en
   columna alineada. El transcript se hojea, no se lee.
6. **Radios contenidos.** El radio pastilla (`999px`) es solo para botones de
   acción y chips; las superficies usan 10–14 px. Los radios enormes en paneles
   grandes son la firma visual de las plantillas.
7. **Un solo idioma de interacción.** Todo lo que sea «elegir entre opciones»
   se resuelve con el mismo selector (flechas + ratón + filtro), en las cuatro
   superficies.

---

## 3. Fases

| Fase | Alcance | Estado |
|---|---|---|
| F0 | Correcciones que bloquean el uso diario | ✅ hecha |
| F1 | CLI: lenguaje de interacción y catálogo de comandos | ✅ hecha |
| F1.5 | Móvil: teclado, cabecera de chat, historial unificado y comandos en remoto | ✅ hecha |
| F2 | CLI: funciones de trabajo real | ⬜ pendiente |
| F3 | IDE: identidad visual propia | ⬜ pendiente |
| F4 | IDE: funciones que hoy obligan a salir del IDE | ⬜ pendiente |
| F5 | Continuidad entre superficies | ⬜ pendiente |
| F6 | Calidad, pruebas y documentación | ⬜ pendiente |

---

### F0 · Correcciones que bloquean el uso diario ✅

**Objetivo.** Que nada de lo que se ve en pantalla sea mentira.

Entregables:

- **Barra de estado que no desaparece.** `term.py` gana un *painter*
  registrable (`set_status_painter`) y `attach_status_repaint(app)`, que engancha
  el repintado al evento `after_render` de cualquier `Application` de
  `prompt_toolkit`. Se aplica al prompt principal, al selector y a los prompts
  de credenciales; durante el *streaming* se repinta cada 400 ms.
- **Sesión inválida detectada.** `_load_account_quietly()` devuelve
  `ok` / `auth` / `offline` en lugar de tragarse el error. Con `auth` se limpia
  la clave local y se pide sesión de nuevo; con `offline` se avisa y se sigue.
- **Errores accionables.** `_report_api_error()` traduce 401/403 («usa /login»),
  402 (créditos) y 429 (ritmo) en vez de mostrar el `detail` crudo del gateway.
- **`/logout`** que borra la clave de la máquina, con confirmación.
- **APK móvil emparejado**: el repo estaba en `0.3.1` pero el último tag
  publicado era `mobile-v0.3.0`, así que `/aplicaciones` mostraba fielmente la
  3.0. Se publicó el tag `mobile-v0.3.1`.

Criterios de aceptación:

- La barra se ve al arrancar, con el prompt abierto, durante una respuesta y
  después de un selector.
- `lixbon` tras un logout desde la web pide credenciales, no entra «sin modelos».
- `/aplicaciones` muestra v0.3.1 cuando el CI termine.

---

### F1 · CLI: lenguaje de interacción y catálogo de comandos ✅

**Objetivo.** Que elegir sea siempre igual y que no haya que memorizar sintaxis.

Entregables:

- **Selector unificado** (`ui.select`): filtro incremental al escribir en listas
  largas, `↑↓` / `Ctrl+P` / `Ctrl+N`, `PgUp` / `PgDn`, `Inicio` / `Fin`, rueda del
  ratón, *hover* y clic, contador `n/total`, indicadores de scroll, insignias
  (`actual`) y cabeceras de grupo no seleccionables. Degrada a texto plano con
  atajos numéricos en Git Bash.
- **Catálogo de comandos agrupado** (`conversación`, `agente`, `cuenta`,
  `sistema`), con el grupo visible en el autocompletado.
- **`/help` navegable**: elegir una fila ejecuta el comando; los que exigen
  argumento explican su uso en lugar de fallar.
- **Comandos nuevos**: `/logout`, `/cost`, `/tools`, `/diff`, `/run`, `/init`,
  `/history`, `/save`, `/web`, `/bar`, `/config`, `/doctor`.
- **`LIXBON.md`**: contexto permanente del proyecto que `/init` genera y que el
  CLI carga solo al entrar en la carpeta (equivalente a un `CLAUDE.md`).
- La barra solo anuncia lo que está **activo** (`web`, `LIXBON.md`); los estados
  apagados no ocupan espacio.

Criterios de aceptación:

- `/model` con 20 modelos se resuelve escribiendo tres letras.
- Ningún comando de `COMMAND_SPECS` se queda sin handler (verificado en CI).

---

### F1.5 · Móvil: teclado, cabecera, historial y comandos en remoto ✅

**Objetivo.** Que la app deje de ser una vista reducida del chat de la web y
hable el mismo idioma que el CLI.

Entregables:

- **Teclado.** Con `edgeToEdgeEnabled` la ventana ya no se redimensiona sola, así
  que `adjustResize` dejó de tapar el hueco: el compositor quedaba **debajo** del
  teclado y no se veía lo que se escribía. Se envuelve el chat, el chat remoto,
  el login y los diálogos en `KeyboardAvoidingView` con `behavior="padding"`
  (React Native mide el teclado con `WindowInsets.ime()` y descuenta la barra de
  navegación, por eso el inset inferior del compositor **suma** en vez de
  duplicar).
- **Cabecera de conversación** (`ui.ChatHeader`): título + subtítulo con el
  contexto real (modelo, origen, host, estado) y menú `⋮` de opciones. El bloque
  central también es pulsable: el `⋮` es un atajo, no el único camino.
- **Historial unificado.** El *sidebar* pedía `?source=web` fijo, y por eso el
  historial del CLI y del IDE **no aparecía nunca**. Ahora lista todas las
  superficies con chips `Todo / App / CLI / IDE` y un distintivo de origen por
  conversación. El gateway expone `source` en `/api/conversations`; seguir una
  conversación del CLI desde el móvil **no** le cambia el origen.
- **Comandos en el chat remoto.** El host publica en el `hello` los comandos que
  acepta (`REMOTE_COMMANDS`), la app los ofrece mientras se escribe `/…` y el
  host responde con un evento `notice` que se pinta como salida del equipo, no
  como algo dicho por el modelo. Un host antiguo no publica nada y la app cae a
  su catálogo de reserva.

Criterios de aceptación:

- Escribir en el chat con el teclado abierto muestra siempre el texto.
- Una conversación empezada en el CLI se abre desde el móvil y sigue marcada CLI.
- `/model` desde la app cambia el modelo del host y contesta con el nombre nuevo.

---

### F2 · CLI: funciones de trabajo real ⬜

**Objetivo.** Cerrar el bucle *pedir → aplicar → verificar → deshacer* sin salir
de la terminal.

Entregables propuestos:

1. **`/undo`** — instantánea de los archivos que toca el agente antes de
   escribir, y reversión del último turno. Se guarda en `~/.lixbon/snapshots/`
   por conversación, con límite de tamaño y purga automática.
2. **`/checkpoint` y `/restore`** — puntos de guardado manuales del workspace,
   con selector para elegir a cuál volver.
3. **`/resume`** — retomar conversaciones anteriores desde el historial del
   gateway (`source=cli`), con selector y vista previa del primer mensaje.
4. **`/plan`** — modo de solo lectura donde el agente propone un plan numerado y
   no toca disco hasta que se aprueba con el selector.
5. **`/test`** — detecta el runner del proyecto (`pytest`, `npm test`, `cargo
   test`) y lo ejecuta dejando el resultado en el contexto, sin escribir el
   comando a mano.
6. **`/paste`** — pega la imagen del portapapeles como adjunto (Windows: API de
   `CF_DIB`; Linux: `xclip -t image/png`).
7. **Perfiles de sesión** — `~/.lixbon/profiles/*.json` con modelo, modo y
   ventana de contexto, seleccionables con `/profile`.

Criterios de aceptación:

- Un turno del agente que rompe un archivo se revierte por completo con `/undo`.
- `/plan` no escribe en disco bajo ninguna circunstancia.
- Ningún comando nuevo añade dependencias fuera de la biblioteca estándar.

Riesgos: las instantáneas pueden crecer sin control en repos grandes → límite
duro por archivo y por sesión, y exclusión de las carpetas de
`IGNORED_TREE_DIRS`.

---

### F3 · IDE: identidad visual propia ⬜

**Objetivo.** Que el IDE se reconozca como Lixbon en una captura de pantalla,
sin leer el logo.

Auditoría previa (obligatoria antes de tocar CSS): recorrer `shell.css`,
`views.css`, `chat.css` y `editor.css` anotando cada radio, sombra y borde que
no venga de un token.

Entregables propuestos:

1. **Escala de radios y elevación como tokens** (`--radius-surface: 12px`,
   `--radius-control: 8px`, `--radius-pill`), y eliminación de los valores
   sueltos. El `--radius-box: 22px` deja de usarse en paneles grandes.
2. **Retícula del shell**: barra de actividad, panel lateral, editor y panel
   inferior alineados a una rejilla de 4 px, con una única línea divisoria de
   1 px (`--border-soft`) en vez de bordes por componente.
3. **Barra de estado inferior con el mismo idioma que la del CLI**: modelo,
   sesión, contexto, tokens, banderas activas. Misma sintaxis, mismo orden.
4. **Tipografía de trabajo**: Bricolage Grotesque solo para interfaz; los
   nombres de archivo, rutas y salidas van en `--font-mono`. Nunca al revés.
5. **Estados vacíos con contenido real** (atajos, últimos proyectos, qué hace el
   agente) en lugar de ilustraciones o texto gris centrado.
6. **Panel de acciones del agente** alineado en columnas verbo/objetivo/diff,
   idéntico al del CLI (`ToolGroup.jsx` ↔ `ui.render_action`).
7. **Movimiento con criterio**: 120–160 ms, solo en aparición de paneles y
   confirmaciones. Nada de rebotes ni escalas.

Criterios de aceptación:

- Cero valores de color, radio o sombra escritos a mano fuera de `base.css`.
- Modo claro y oscuro revisados pantalla por pantalla.
- Contraste AA en texto de interfaz.

---

### F4 · IDE: funciones que hoy obligan a salir del IDE ⬜

Entregables propuestos, por orden de valor:

1. **Paleta de comandos unificada** — que `CommandPalette.jsx` alcance también
   los comandos del agente, Git y las vistas, con el mismo filtro difuso.
2. **Revisión de cambios del agente** — vista de diff por turno con aceptar o
   descartar por archivo, no solo el diff global de `SourceControl`.
3. **A1 · LSP** (pendiente de `docs/PLAN_IDE.md`) — el único trabajo de Rust que
   quedaba: `go to definition`, `hover` y diagnósticos reales.
4. **D2 · split del editor** — dos editores lado a lado, también pendiente.
5. **Tareas del proyecto** — leer `package.json` / `Makefile` / `pyproject.toml`
   y ofrecer los scripts como botones del panel de ejecución.
6. **Historial de sesiones del agente** con reanudación, compartido con el CLI.
7. **Búsqueda semántica** sobre `codebaseIndex.js` para el contexto del chat.

Criterios de aceptación:

- Cada función nueva es alcanzable desde la paleta de comandos.
- Las tres versiones (`package.json`, `tauri.conf.json`, `Cargo.toml`) suben
  juntas, como manda la convención del proyecto.

---

### F5 · Continuidad entre superficies ⬜

**Objetivo.** Que empezar en el CLI y seguir en el IDE o en el móvil no cueste
nada.

- `LIXBON.md` reconocido también por el IDE y por el agente del escritorio.
- Historial de conversaciones compartido con filtro por origen (`cli`, `ide`,
  `web`, `móvil`), no cuatro historiales incomunicados.
- Ajustes con nombres idénticos en las tres superficies (modo, auto-aprobar,
  búsqueda web, ventana de contexto).
- `/remote` visible desde el IDE con el mismo QR y el mismo texto.

---

### F6 · Calidad, pruebas y documentación ⬜

- Pruebas del selector con entrada simulada (`create_pipe_input`): filtro,
  paginado, cabeceras deshabilitadas, cancelación. Ya existen como comprobación
  manual; falta fijarlas en `apps/cli/tests/`.
- Prueba de que todo comando de `COMMAND_SPECS` tiene handler y viceversa.
- Prueba de que `client_cli.py` regenerado coincide con las fuentes
  (`test_build_fresh.py` ya lo cubre; mantenerlo verde).
- `docs/VERIFICACION_IDE.md` ampliado con las pantallas nuevas.

---

## 4. Decisiones tomadas (y por qué)

- **La barra fija se queda con `DECSTBM`**, aunque sacrifique el scrollback
  nativo de la terminal, porque el estado del turno es información que debe
  estar siempre a la vista. Quien prefiera el scrollback lo apaga con `/bar off`.
- **Escribir filtra en lugar de navegar** en listas de más de seis opciones.
  Por debajo de ese umbral se conserva `j`/`k`, que en menús de dos líneas es
  más rápido y no compite con nada.
- **`LIXBON.md` viaja como mensaje `system`** en cada turno, no se inyecta en el
  historial: así no se compacta ni se pierde al hacer `/new`.
- **`/init` usa el modelo activo**, no uno fijo: el resultado depende del plan
  del usuario y eso es correcto.

## 5. Cómo verificar

```bash
# CLI: sintaxis, artefacto único y pruebas
python apps/cli/build.py
python -m pytest apps/cli/tests -q

# IDE
cd apps/desktop && npm run build
```

Para el recorrido funcional completo (gateway + web), seguir la receta de la
skill `verify`.
