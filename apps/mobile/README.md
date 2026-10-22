# Lixbon móvil (Android)

App Android de Lixbon en **React Native + Expo**: chat con streaming,
historial propio, control remoto del IDE/CLI, uso del plan y gestión de
cuenta. Usa el sistema de estilos del IDE (`apps/desktop/src/styles/base.css`):
superficies por peldaños sin bordes, radio de 7px, acento reservado para el
estado, Hanken Grotesk + JetBrains Mono + Bruno Ace SC embebidas en
`assets/fonts/`, temas oscuro/claro.

Rama de trabajo: **`mobile`** (ver `docs/RAMAS_Y_RELEASES.md`).

## Filosofía de compilación

Igual que el Rust del desktop: **la app compila solo en CI** — no hace falta
Android Studio ni SDK en local. La carpeta `android/` no se versiona: la
genera `npx expo prebuild --platform android` en GitHub Actions
(`.github/workflows/mobile.yml`) y el APK sale firmado con la keystore de
debug (instalable, no Play Store).

- **Release**: PR de `mobile` a `master`, subir la versión en `package.json` (única fuente: `app.config.js`
  la lee de ahí) y empujar el tag `mobile-vX.Y.Z` (el CI comprueba que
  coincidan). Sale: artifact `lixbon-android`, release borrador en GitHub y
  subida a `/api/versions/upload` (tarjeta Android de `/aplicaciones`).
- **Desarrollo local** (opcional): `npm install && npx expo start` y abrir con
  Expo Go en el teléfono (misma red). El OAuth con esquema `lixbon://` solo
  funciona en el APK compilado; en Expo Go el gateway acepta `exp://`.

## Estructura

```
App.js                  raíz: fuentes, providers, gate de auth, armazón, paleta y comandos
src/theme.js            tokens del IDE y acentos elegibles (buildTheme)
src/pins.js             conversaciones fijadas (por usuario) y grupos por fecha
src/share.js            exportar una conversación a Markdown (hoja de compartir)
src/api.js              cliente HTTP del gateway (Bearer API key, 401 → logout)
src/sse.js              streaming del chat vía XHR (fetch de RN no streamea)
src/oauth.js            PKCE + Custom Tab para Google/Apple
src/state.js            contextos: prefs (AsyncStorage), sesión (SecureStore), chat
src/components/         primitivas del IDE (ui.js), barra de título, paleta, barra de
                        estado, sidebar, diálogos e iconos
src/screens/            Auth, Chat y Remoto (secciones), Uso, Cuenta y Personalizar (apiladas)
src/observe/            bootstrap observacional del Core (LXO-107): snapshot compacta por
                        /remote, cursor de Events, caché no autoritativa y estados de conexión
src/supervision/        prototipo de supervisión: reglas (model), datos de ejemplo
                        (fixtures), estado (store) y pruebas (`npm test`)
assets/                 fuentes embebidas + iconos de la app (desde favicon.svg)
```

El armazón replica el del IDE: **barra de título** (☰, isotipo, selector
Chat · Remoto, buscar, cuenta), el panel activo sobre un fondo con luz
ambiente y una **barra de estado** en mono bajo el compositor. La lupa abre
la **paleta de comandos** (conversaciones, comandos y «preguntar», con
prefijos `>` `#` `?`). El ☰ abre el panel lateral con el historial agrupado
por fecha y las fijadas (mantener pulsado: fijar, renombrar, compartir,
eliminar).

**Personalizar** (panel lateral o Cuenta): tema, 7 acentos, tamaño de texto,
densidad, enviar con Enter, barra de estado, luz ambiente y animaciones; se
guarda en AsyncStorage (`uiPrefs`). Cada respuesta tiene Copiar y, la última,
Regenerar (usa `POST /api/conversations/{id}/rewind` para no duplicar el
turno guardado).

## Supervisar con datos reales (F2)

La sección **Supervisar** muestra el estado real del Core del IDE que eliges:
`src/screens/ObserveScreen.js` y `src/observe/`. Es solo lectura. Sigue tras
la misma puerta que el prototipo (desarrollo o *Ajustes › Desarrolladores*)
hasta validarla en dispositivo.

- **IDE (host)**: una sesión `/remote` es un IDE. Se usa el que elijas en la
  cabecera o en el menú lateral; si no eliges, el primero en línea. Si el
  elegido se desconecta no se salta a otro, se dice.
- **Conexión** (`useObserve.js`): socket propio a la sesión, sin repetir el
  transcript del chat, y el bootstrap del Core de LXO-107.
- **UX de conexión** (`connection.js`, `ConnectionBanner.js`, LXO-111):
  - estados en línea, conectando, reconectando, desactualizado (también la
    caché), sin conexión (servidor, IDE o Core), sesión no autorizada y
    versiones incompatibles;
  - hora de la última sincronización, «Reintentar», un código de diagnóstico
    estable y texto para lectores de pantalla;
  - offline nunca usa el rojo de los fallos;
  - `actionGate` solo deja mandar algo en línea: ninguna acción futura puede
    aparentar éxito sin conexión.

El prototipo con datos de ejemplo (`SupervisionScreen.js`, `src/supervision/`)
sigue en el repo, pero sin montar.

## Prototipo de supervisión (Sprint D)

Sección **Supervisar** con datos de ejemplo para validar Mobile como superficie
de supervisión y decisión, sin editor ni terminal. Aparece en desarrollo
(`__DEV__`) o al activar *Ajustes › Desarrolladores › Prototipo de
supervisión*; se abre desde el selector del menú lateral o la búsqueda.

- **Inicio**: Atención (lo que te espera, derivado del estado de las tareas,
  no de los avisos), Trabajo activo, Avisos, Uso y Hosts. El título cambia de
  host.
- **Tarea**: host, destino (proyecto · rama), política y agente siempre a la
  vista; últimos eventos del agente (pausar/reanudar), intentos y «Abrir en
  Desktop».
- **Decisiones**: responder una pregunta, aprobar o rechazar, aceptar una
  revisión o pedir cambios. La política elevada y las revisiones grandes o en
  zonas delicadas van a Desktop; una revisión generada sobre otro commit no se
  acepta hasta regenerarla.
- **Escenario** (⋮ arriba a la derecha): en línea, desactualizado o sin
  conexión. Desactualizado pide actualizar antes de decidir; sin conexión las
  respuestas quedan **en cola** (visibles como tales) y aprobar o revisar
  espera. Nada de eso se pinta como fallo.
- **Avisos**: leer no resuelve la atención, y la vista previa del push enseña
  que no viaja el comando, la pregunta ni el diff.

Las reglas viven en `src/supervision/model.js` y están probadas en
`src/supervision/supervision.test.js` (`npm test`; también en el CI de PRs,
`.github/workflows/mobile-ci.yml`, junto con el empaquetado de Metro).

### Revisarlo en local (emulador)

La app usa módulos nativos que Expo Go no trae (keyboard-controller,
reanimated 4), así que se prueba con una build de desarrollo:

1. Android Studio con JDK 17 y un AVD **Pixel 6 · API 34 · Google APIs
   x86_64** (el mismo perfil que `mobile-e2e.yml`). Para tamaños comunes,
   un segundo AVD **Small Phone** (360 × 640 dp) y, en el Pixel 6, *Tamaño de
   fuente* al máximo.
2. `npm install` y `npx expo run:android` con el emulador abierto (genera
   `android/`, instala y deja Metro con recarga en caliente).
3. Iniciar sesión y abrir Supervisar desde el menú lateral.

## Detalles útiles

- **Sesión**: API key propia `"Lixbon Mobile"` (el login pasa `key_name`),
  guardada en el Keystore vía `expo-secure-store`; se rota en cada login.
- **Historial compartido**: el chat envía `source: 'web'` → misma cuenta,
  mismas conversaciones que la web.
- **Cambiar de servidor (dev)**: mantener pulsado el pie «lixbon.com» de la
  pantalla de login.

## Bootstrap observacional del Core (LXO-107)

`src/observe/` arranca la vista observacional desde la snapshot compacta del Core
y sigue los cambios por el Event Log desde su cursor. Pasa por la sesión
`/remote`: el IDE lee el Core con su identidad Desktop de F1 y devuelve solo lo
permitido, y el móvil se autentica con su cuenta. La caché (AsyncStorage) nunca es autoridad
y se pinta como desactualizada. Estados: `connecting`, `online`, `stale`,
`offline`, `unauthorized`, `version_mismatch`. Por ahora hay un indicador mínimo
en la pestaña Orquestar; las pantallas son LXO-108 a LXO-111. Contrato y
amenazas: [`docs/core/MOBILE_BOOTSTRAP.md`](../../docs/core/MOBILE_BOOTSTRAP.md).
