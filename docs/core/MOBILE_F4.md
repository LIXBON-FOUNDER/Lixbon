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

## Validación en dispositivo pendiente

1. Conectar Mobile al IDE actualizado y abrir un Attempt. Comprobar proveedor,
   sesión, canal y diferencias entre capacidades disponibles, ausentes y bloqueadas.
2. Cambiar el estado del proveedor en el escritorio y actualizar desde el teléfono.
   Confirmar que el historial del Attempt conserva sus Events.
3. Consultar un ContextPackage completo, otro con recortes o redacción y otro ausente.
   Verificar que el teléfono muestra los metadatos del paquete guardado. Para el caso
   alterado, usar una copia aislada de la base de pruebas.
4. Abrir Uso con varios proveedores. Comprobar cuota, modelos, coste declarado,
   datos ausentes, autenticación requerida y límites de consulta.
5. Cortar la conexión. Confirmar que los datos conservados se marcan antiguos.
   Volver a conectar, cambiar de IDE y repetir después de volver de segundo plano.
6. Repetir con fuente ampliada y lector de pantalla. Verificar que los botones
   Actualizar siguen siendo accesibles y que los estados se leen sin depender del color.

La aceptación manual de estos casos queda pendiente en los PRs. El merge lo
realiza Gabriel después de su revisión.
