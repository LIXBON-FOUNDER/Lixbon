# Lixbon móvil (Android · Flutter)

App de Lixbon para Android en **Flutter**. Mismo diseño que la web (tokens de
`docs/DISENO_WEB.md`, Bruno Ace SC + Bricolage Grotesque embebidas en
`fonts/`, temas claro/oscuro) y misma cuenta: el historial se comparte con la
web (`source=web`).

**La compilación está centralizada en GitHub Actions** (como el Rust del
desktop): no hace falta Flutter ni Android Studio en local.

## Qué incluye

- **Login / Registro / Olvidé mi contraseña** e **inicio de sesión con Google
  y Apple** (los botones aparecen solo si el gateway tiene el proveedor
  configurado — `GET /api/auth/oauth/providers`).
- **Chat** con streaming SSE, markdown, selector de modelo y modo investigar
  (búsqueda web con fuentes).
- **Historial**: buscar, abrir, renombrar y eliminar (mantener pulsado).
- **Uso**: plan vigente, mensajes/día, tokens/mes y gráfica de 30 días.
- **Cuenta**: perfil, verificación de correo, tema, privacidad, regenerar API
  key, borrar historial, cerrar sesión, eliminar cuenta y **Documentación**
  (abre `lixbon.com/docs`).

La app se autentica con una **API key Bearer** propia (`"Lixbon Mobile"`,
rotada en cada login) guardada en el Keystore de Android vía
`flutter_secure_storage`.

## Compilar (CI)

`.github/workflows/mobile.yml`:

- **Manual**: pestaña Actions → "Compile & Release Android App" →
  *Run workflow* → el APK queda como artifact `lixbon-android`.
- **Release**: `git tag mobile-v0.1.0 && git push --tags` → compila, comprueba
  que el tag coincide con `version:` de `pubspec.yaml` y publica un release
  (borrador) con `Lixbon-0.1.0.apk`.

La carpeta `android/` **no se versiona**: la genera el CI con
`flutter create --platforms=android .` y la ajusta `tool/patch_android.py`
(permiso INTERNET, activity de callback `lixbon://` para el OAuth, minSdk 23
y etiqueta "Lixbon"). Solo se versionan `lib/`, `pubspec.yaml`, `fonts/` y
`tool/`.

### Desarrollo local (opcional)

Si algún día se instala Flutter:

```bash
cd apps/mobile
flutter create --platforms=android --org com.usuario --project-name lixbon .
python tool/patch_android.py
flutter pub get
flutter run
```

Para apuntar a un gateway local: **mantén pulsado 1 s el pie "lixbon.com"**
en la pantalla de login y escribe la URL (p. ej. `http://192.168.1.50:8000`).

## OAuth: configuración del gateway (Railway)

El flujo corre en el servidor (`core/gateway/routers/oauth.py`); la app solo
hace PKCE por `lixbon://oauth` y canjea un código de un solo uso. Variables:

| Var | Valor |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Console → OAuth client tipo **Web**, redirect URI `https://lixbon.com/api/auth/oauth/google/callback` |
| `APPLE_OAUTH_CLIENT_ID` | Services ID de Apple Developer (return URL `https://lixbon.com/api/auth/oauth/apple/callback`) |
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Team ID, Key ID y PEM de la key `.p8` (los saltos pueden ir como `\n`) |
| `OAUTH_STATE_SECRET` | opcional; si falta se genera al arrancar |

Apple requiere cuenta de Apple Developer (99 USD/año). Sin variables, los
botones sociales no aparecen. En backend hace falta `PyJWT[crypto]` (ya está
en `requirements.txt`) solo para Apple.

## Pendiente antes de Play Store

- Icono/splash propios (el CI usa los de la plantilla de Flutter).
- Firma de release con keystore propio (hoy firma debug: instalable
  directamente, pero no publicable en Play Store).
