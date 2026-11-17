# Mobile F4

LXO-48 agrupa las capacidades del proveedor (LXO-139), el ContextPackage guardado
(LXO-140) y el uso normalizado de proveedores (LXO-208). Las tres funciones usan
queries existentes del Core, con respuestas resumidas a través del host Desktop.

| Issue | Entrada en Mobile | Query del Core |
| --- | --- | --- |
| LXO-139 | Supervisar → Tarea → Intento → Capacidades | attempt_detail_v2, provider_capabilities |
| LXO-140 | Supervisar → Tarea → Intento → ContextPackage | attempt_detail_v2, context_package_get |
| LXO-208 | Supervisar → Uso de proveedores | usage_report |

Los hosts anuncian capacidades de protocolo separadas. Una versión anterior
muestra un aviso para actualizar el escritorio. Las respuestas son efímeras
en el relé y la memoria del teléfono se separa por host y destino.

Las capacidades y los metadatos de sesión proceden del Core. Un perfil bloqueado
queda señalado y reanudar requiere una sesión nativa vinculada y reanudable.
La ficha distingue esa estrategia del ContextPackage, cuyo resumen conserva
procedencia, checksum, recortes y redacción. Un paquete inválido pierde sus
campos de contenido en la respuesta. Los adjuntos pendientes de verificación
quedan señalados. Usage conserva las métricas desconocidas y el estado de
consulta de cada proveedor.

## Validación automatizada

Las pruebas de Mobile comprueban las matrices, el texto de transferibilidad
y las métricas desconocidas. Las pruebas del host usan fixtures de los contratos
del Core y verifican la eliminación de contenido privado. La prueba
remoteF4.test.js conecta el enlace de petición de Mobile al handler del host,
con RPCs simulados, y comprueba las tres lecturas y cambios posteriores.
La suite WebSocket del gateway comprueba que las tres respuestas cruzan el
relé y quedan excluidas del replay al reconectar.

Desde la raíz del repositorio se ejecutan las pruebas correspondientes.

~~~powershell
npm.cmd --prefix apps/mobile test
npm.cmd --prefix apps/desktop test -- remoteCore remoteF4
python -m pytest -q core/gateway/test_remote_ws.py core/gateway/test_remote_core_bootstrap.py core/gateway/test_remote_hub.py
~~~

## E2E Android reproducible

`apps/mobile/e2e/f4_drive.py` recorre la app nativa instalada, desde el login
hasta Supervisar → Task → Attempt y Uso. Usa UIAutomator y deja capturas,
`results.json` y `relay-evidence.json`. El gateway de pruebas monta las rutas
WebSocket de producción y un host que llama a `handleCoreAction` de Desktop;
solo las respuestas RPC del Core y la cuenta son fixtures. Se complementa con
las pruebas Rust del Core, sin credenciales ni proveedores reales.

Casos: capacidades disponibles, bloqueadas y no soportadas; ContextPackage
válido, parcial con redacción y recortes, corrupto y ausente; varios proveedores
con datos desconocidos o no soportados y rate limit; desconexión del host con
datos antiguos, reconexión y pausa del polling durante el segundo plano.
El host de pruebas rechaza cualquier RPC fuera de las queries permitidas y
comprueba que el objetivo completo y los errores privados no salgan del host.

Preparar el APK release x86_64 siguiendo `.github/workflows/mobile-e2e.yml`,
con `EXPO_PUBLIC_API_BASE=http://127.0.0.1:8765` y HTTP local permitido solo
en el manifiesto generado para pruebas. Instalar las dependencias de Python
del repositorio, las de Desktop y Mobile, y tener Node en PATH. Desde la raíz,
en dos terminales, con un emulador desechable:

~~~powershell
# Terminal 1: servidor ligado exclusivamente a loopback.
python apps/mobile/e2e/f4_gateway.py

# Terminal 2: seleccionar explícitamente el emulador de pruebas.
$env:ANDROID_SERIAL = 'emulator-5580'
adb reverse tcp:8765 tcp:8765
adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
adb shell pm clear com.usuario.lixbon
python apps/mobile/e2e/f4_drive.py .dev/f4-e2e-out
~~~

La prueba empieza con los datos de la app borrados en ese emulador. No debe
ejecutarse sobre un teléfono con datos personales. La comprobación manual con
TalkBack, un dispositivo físico y proveedores reales queda como cobertura
adicional; los fixtures no validan el comportamiento de binarios externos.

La regresión `answer_e2e_tests::waiting_world` espera todas las peticiones del
adapter antes de responder: esperar solo el estado del primer permiso dejaba
una carrera que podía producir un `attempt.resumed` prematuro en el test.

## Integración con F5

La rama de integración de LXO-48 incluye los commits revisables de LXO-164 y
LXO-165 (PRs #243 y #244). La resolución del merge reúne las capabilities del
host, las respuestas del enlace móvil y las rutas de Uso, Pregunta y Aprobación
de lanzamiento. También conserva ambas familias de pruebas WebSocket.

Orden de revisión de F4: #245, #246, #247 y el PR de LXO-48. El PR de integración
incluye F5 en su historial para resolver los conflictos antes del merge en
master. La aceptación de los PRs de F5 sigue a cargo de Gabriel.
