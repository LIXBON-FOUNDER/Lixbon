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

## Detalles útiles

- **Sesión**: API key propia `"Lixbon Mobile"` (el login pasa `key_name`),
  guardada en el Keystore vía `expo-secure-store`; se rota en cada login.
- **Historial compartido**: el chat envía `source: 'web'` → misma cuenta,
  mismas conversaciones que la web.
- **Cambiar de servidor (dev)**: mantener pulsado el pie «lixbon.com» de la
  pantalla de login.
