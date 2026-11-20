# Aceptación F5 · LXO-49

## Entorno y reproducción

Android API 34, Small Phone 720×1280, APK release Hermes x86_64. El APK debe
compilarse con `EXPO_PUBLIC_API_BASE=http://127.0.0.1:8765`. Usar un emulador
aislado, sin datos personales, y `adb reverse tcp:8765 tcp:8765`.

Desde la raíz, con las dependencias Python del gateway y Node instaladas:

```sh
python apps/mobile/e2e/f5_gateway.py
# En otra terminal, ANDROID_SERIAL apunta al emulador aislado:
python apps/mobile/e2e/f5_drive.py e2e-f5-out
python apps/mobile/e2e/f5_negative_drive.py e2e-f5-negative-out
```

La primera ejecución comienza con datos de app limpios y habilita Supervisar.
`--resume` omite login/pregunta y `--tail` recorre controles negativos y reconexión.
Los drivers generan results.json, capturas y evidencia del relay. No usar una
cuenta real: el gateway solo escucha loopback y utiliza credenciales de fixture.

El relay FastAPI y los handlers JS de Desktop son los de producción. El RPC Core
está simulado en esta prueba nativa; no demuestra persistencia real ni ejecución
de proveedores. Estas propiedades se prueban con SQLite, Git y worktrees reales
en los tests Rust `mobile_review`, `mobile_controls`, aprobación y respuesta.
Open on Desktop se valida mediante el callback del host y, por separado, un test
de AdeShell que abre el Workspace y selecciona Project/Task/Attempt exactos.

## Regresión local

- Mobile: 185 tests correctos.
- Desktop: suite completa, 107 archivos y 1698 tests correctos; después se añadió
  la navegación de AdeShell y se repitió ese archivo: 64 tests correctos.
- Contrato de consultas Core: 43 comprobaciones correctas; build Vite correcto.
- Gateway: 52 tests; persistencia: 13 tests en otro proceso, incluidos cuatro
  que verifican que las respuestas privadas F5 no se guardan como transcript.
- Core dirigido: revisión 4, controles 4, policies 39, aprobación 25 y preguntas
  18 correctos (una prueba de preguntas omitida).
- Regresión Core completa: 2148 correctos, 38 omitidos y dos timeouts de tests
  existentes de retry/cola. Ambos pasaron al repetirse aislados. No se presenta
  esta ejecución completa como verde. El fallo anterior de frontera de
  persistencia quedó corregido y su test dirigido pasó.

## CI y límites

Mobile CI se ejecuta también para bases encadenadas. Desktop CI y gateway CI
se aplican contra master; retargetear las ramas en orden antes del merge.
Esta suite F5 nativa es manual y no forma parte del workflow E2E anterior.
No se ha validado iOS, TalkBack ni dispositivo físico.
