# Mobile F6 — abrir en Desktop (LXO-50)

Task, Attempt, Attention y Review ofrecen «Abrir en Desktop». Mobile envía exclusivamente la identidad durable del origen, vista y, cuando existe, revisión/archivo/línea. El host resuelve Task y Project con las lecturas de Core y pide `deep_link_generate`: no construye un URL a partir de rutas ni del caché del teléfono.

## Contrato e integración

Capability/action `core_desktop_link`; respuesta efímera `orch_core_desktop_link` con `rid`, `protocol: 1`, `ok`, `link` (DTO canónico de Core) y `open_status`: `opened`, `unavailable`, `stale`, `not_requested`. La sesión remota y su propietario se validan por el gateway igual que el resto de lecturas observacionales. La nueva acción no admite URL, credenciales, root ni operaciones de edición/control. Una Attention resuelta falla antes de generar el enlace.

El host usa el receptor de LXO-32 y espera su acuse después de resolver el destino y mostrar la ventana. Sin receptor o si falla, conserva el enlace preparado y responde `unavailable`. No ejecuta comandos Take Over ni transfiere sesiones. La apertura no cambia la navegación Mobile.

Una revisión obsoleta no se abre automáticamente. Mobile muestra el aviso y permite copiar/compartir el enlace para revisarlo explícitamente en Desktop. Los fallos de autorización, identidad o existencia no exponen mensajes crudos del host. El verificador rechaza parámetros extra, credenciales en URL, identidad distinta, revisiones sustituidas y rutas absolutas/peligrosas antes de mostrar el enlace, copiarlo o compartirlo.

El enlace preparado vive en memoria y se descarta al cambiar de destino/host o perder autorización/existencia. Una desconexión de transporte conserva la copia preparada para compartirla; sin haberla preparado no se inventa una cuando el host está offline. Los eventos no se persisten ni se repiten en el transcript. Review conserva su apertura compatible con Desktop F5 cuando el host no anuncia la capability nueva.

## Validación reproducible

Pruebas de lógica: `npm test` en `apps/mobile`; relé: `npm test -- --maxWorkers=1 src/lib/remoteDesktopLink.test.js` en `apps/desktop`; gateway: `python -m pytest core/gateway/test_remote_core_bootstrap.py core/gateway/test_remote_ws.py core/gateway/test_remote_hub.py core/gateway/test_remote_commands.py -q`.

Para Android nativo, usar un emulador aislado, nunca un dispositivo con datos reales:

1. Compilar el APK release con `EXPO_PUBLIC_API_BASE=http://127.0.0.1:8765` y la arquitectura del emulador.
2. Ejecutar `python apps/mobile/e2e/f6_gateway.py` desde la raíz. Solo escucha en loopback y usa una identidad de fixture.
3. Configurar `ANDROID_SERIAL`, `adb reverse tcp:8765 tcp:8765`, instalar el APK y empezar con los datos limpios de esa app de prueba.
4. Ejecutar `python apps/mobile/e2e/f6_drive.py <directorio-de-evidencia>`. Guarda capturas, resultados y las peticiones/efectos del relé.

El recorrido verifica Task, Attempt, Attention, Review con revisión exacta, copia, hoja nativa de compartir, retorno a la Task, revisión obsoleta sin abrir, Desktop no disponible y copia del enlace preparado estando offline.

**Límite de la evidencia nativa:** Android, gateway y host JavaScript son reales; Core y el acuse del abridor Desktop son fixtures. La resolución/autorización real de Core tiene sus pruebas Rust de LXO-32. Queda aceptación manual entre un teléfono físico y un Desktop instalado con su protocolo; no se presenta el fixture como esa comprobación.
