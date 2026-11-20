# Panel · LXO-236

Consulta la misma pregunta a 2–4 candidatos, sin Fork, modificación de código ni
elección automática de una respuesta. Es una operación de Person autenticada
en Desktop o CLI. `confirm: true` confirma una sola vez el panel completo.
La policy `start` del Project/Attempt se vuelve a comprobar al solicitarlo.

`lxo panel --config panel.json --confirm` envía, por ejemplo:

```json
{
  "request_id": "consulta-1",
  "source_attempt_id": "t1-a1",
  "question": "Dónde se comprueba el HEAD antes de aceptar?",
  "candidates": [
    {"provider": "claude", "model": "sonnet", "effort": null},
    {"provider": "claude", "model": "opus", "effort": null}
  ],
  "max_candidates": 2,
  "max_cost_microusd": 1000000,
  "timeout_ms": 60000
}
```

El RPC `panel` devuelve `panel_id`; `lxo panel status <panel_id>` consulta el
resultado durable mediante `panel_status`. No se envía trabajo al reconectar.
Repetir `request_id` con el mismo contenido devuelve el panel; cambiar el
contenido produce `panel_request_conflict`. Un panel solicitado cuyo host se
interrumpió se conserva como requested: no se vuelve a cobrar automáticamente.

## Límites y adapters

Antes del primer lanzamiento se validan todos los candidatos, la revisión del
repositorio, el número máximo, la confirmación y el presupuesto. El coste se
expresa en microdólares enteros (100–100000000) y se reparte entre candidatos
redondeando hacia abajo. El plazo común va de 100 ms a 120 s; al vencer se
cancela y se solicita interrupt. Un timeout es dato ausente, nunca acuerdo.
Hasta cuatro paneles se coordinan simultáneamente.

`ProviderAdapter::panel_supported/start_panel` es un contrato separado de Start:
debe imponer un cap de gasto y el perfil de solo lectura. Por defecto rechaza.
Claude usa `explorar`, solo Read/Glob/Grep, Bash y edición deshabilitados, MCP vacío estricto, fuentes de settings deshabilitadas, permission-mode plan y
`--max-budget-usd` comprobado en la CLI instalada. Un ejecutable alternativo sin
sondeo verificable queda bloqueado. Codex actualmente no acredita un cap monetario
duro por esta vía y se rechaza antes de lanzar todo el panel. No se infiere una
garantía de solo lectura o coste por el nombre del proveedor.

Los paneles mixtos se prueban con adapters simulados que cumplen este contrato.
No se ha gastado cuota de proveedores reales para validar esta implementación.

## Informes, síntesis y procedencia

Cada panelista entrega JSON con answer, confidence (0–1), disagreements y points
(statement y evidence con path, line, quote). Un informe inválido es fallo parcial.
Los textos se redactan y acotan. Las citas solo se verifican contra blobs del HEAD
fijado, hasta 256 KiB, sin seguir symlinks del checkout ni permitir rutas externas.
Se exigen dos identidades de proveedor independientes, ambas con citas válidas,
para etiquetar una afirmación idéntica como corroborated. Dos modelos del mismo
proveedor no cumplen ese quorum; las configuraciones Claude comparten identidad
Anthropic. Esto corrobora atribuciones y evidencia, no convierte una conclusión
del modelo en verdad verificada. La procedencia sigue siendo agent_reported.

La síntesis es determinista: solo agrupa afirmaciones presentes en los informes,
con atribución por índice y proveedor. Un fallo no añade voto ni desacuerdo.
Se acota a 5500 bytes y señala synthesis_truncated si omite puntos.

Events: panel.requested (digest sin pregunta), panel.panelist_recorded (resultado
redactado por candidato) y panel.completed (síntesis). Cada payload respeta el
límite de 8192 bytes; los resultados se guardan juntos en una transacción. La
consulta de estado comprueba el propietario autenticado del panel.
