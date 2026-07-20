# Lixbon móvil (Android)

App Android de Lixbon en **React Native + Expo**: chat con streaming,
historial compartido con la web, uso del plan y gestión de cuenta. Mismo
diseño que la web (tokens de `docs/DISENO_WEB.md`, Bruno Ace SC + Bricolage
Grotesque embebidas en `assets/fonts/`, temas claro/oscuro).

## Filosofía de compilación

Igual que el Rust del desktop: **la app compila solo en CI** — no hace falta
Android Studio ni SDK en local. La carpeta `android/` no se versiona: la
genera `npx expo prebuild --platform android` en GitHub Actions
(`.github/workflows/mobile.yml`) y el APK sale firmado con la keystore de
debug (instalable, no Play Store).

- **Release**: subir la versión en `package.json` (única fuente: `app.config.js`
  la lee de ahí) y empujar el tag `mobile-vX.Y.Z` (el CI comprueba que
  coincidan). Sale: artifact `lixbon-android`, release borrador en GitHub y
  subida a `/api/versions/upload` (tarjeta Android de `/aplicaciones`).
- **Desarrollo local** (opcional): `npm install && npx expo start` y abrir con
  Expo Go en el teléfono (misma red). El OAuth con esquema `lixbon://` solo
  funciona en el APK compilado; en Expo Go el gateway acepta `exp://`.

## Estructura

```
App.js                  raíz: fuentes, providers, gate de auth y tab bar propia
src/theme.js            tokens de diseño (espejo de apps/web/src/styles/base.css)
src/api.js              cliente HTTP del gateway (Bearer API key, 401 → logout)
src/sse.js              streaming del chat vía XHR (fetch de RN no streamea)
src/oauth.js            PKCE + Custom Tab para Google/Apple
src/state.js            contextos: prefs (AsyncStorage), sesión (SecureStore), chat
src/components/         iconos de trazo propios, UI de marca, diálogos/toasts
src/screens/            Auth, Chat, Historial, Uso, Cuenta
assets/fonts/           Bruno Ace SC + Bricolage Grotesque (embebidas)
```

## Detalles útiles

- **Sesión**: API key propia `"Lixbon Mobile"` (el login pasa `key_name`),
  guardada en el Keystore vía `expo-secure-store`; se rota en cada login.
- **Historial compartido**: el chat envía `source: 'web'` → misma cuenta,
  mismas conversaciones que la web.
- **Cambiar de servidor (dev)**: mantener pulsado el pie «lixbon.com» de la
  pantalla de login.
