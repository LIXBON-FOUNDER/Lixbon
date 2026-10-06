# Propuesta: dividir Phase 1 en encargos breves

**Estado:** borrador para decisión del usuario. No se han editado `ROADMAP.md`, `TASK-DIVISION.md`, los planes vigentes ni código.

## Alcance asumido

Interpreto el cambio pedido como reducir el tamaño y el coste de los encargos de planificación/ejecución del roadmap CLI Go, conservando su objetivo y requisitos actuales. Si el cambio esperado es agregar capacidad o cambiar la secuencia de producto, hay que ajustar esta propuesta antes de tocar el roadmap.

## Recomendación

Mantener las cinco fases, los 31 requisitos y las decisiones de Go/Python/Rust. Revisar solo Phase 1 y convertir sus pasos más grandes en unidades GSD pequeñas, con un entregable verificable por unidad. Como `task_level` está desactivado, añadir subpasos dentro de los cuatro planes actuales no reduciría por sí solo el contexto del agente; la opción más segura para limitar cuota es dividir los planes grandes en planes ejecutables cortos y conservar `plan_level`.

Usar un piloto pequeño antes de reescribir los cuatro planes: separar el trabajo mayor de 01-01-01 en unidades para procedencia/lock, preflight, runner aislado y comprobación de primer fallo. Revisar el consumo observado y ajustar el tamaño antes de dividir 01-02 y 01-04. El límite de aproximadamente 8k tokens sugerido por OpenCode es una heurística, no una cuota medida: la calibración del proyecto sigue con `sample_count=0` y confianza baja.

## Límites y orden de trabajo propuestos

1. Cada unidad debe tener un resultado principal, propiedad explícita de archivos, brief corto, dependencias reales, aceptación observable y condición de parada. Mantener el límite vigente de cinco archivos por unidad cuando aplique.
2. No superar tres agentes activos en total, contando al Codex coordinador; por tanto, máximo dos workers. Mantener implementador, validador y revisor distintos. Ejecutar validación/revisión después de integrar el cambio y de forma secuencial cuando ocuparían un cuarto agente.
3. Conservar la dependencia Phase 1: referencia → contratos y destinos en paralelo → medidas y aceptación → checkpoint humano. No iniciar fases 2–5 desde este cambio.
4. Congelar por escrito la interfaz de `reference_runner.py` antes de que la consuman 01-02 y 01-04. No declarar paralelismo de Phase 2–5 hasta verificar las rutas Go y sus interfaces.
5. Antes de ejecutar planes con worktrees, correr la comprobación de base de GSD. Solo fijar `worktree.baseRef: "head"` si el chequeo confirma divergencia de `origin/HEAD`; resolver también el uso previsto de `branching_strategy: none` frente a las plantillas configuradas.

## Cambios documentales que requeriría la aprobación

- `TASK-DIVISION.md`: tabla corta por unidad, propiedad, dependencias, límite de concurrencia y rol de revisión.
- `ROADMAP.md`: actualizar únicamente el número/lista de planes Phase 1 y sus enlaces; mantener objetivo, requisitos y fases 2–5.
- Planes Phase 1: dividir los pasos con más obligaciones —en especial 01-01-01 y 01-04-02— en planes con un entregable acotado. Confirmar IDs y archivos durante ese desglose; los sufijos propuestos en los informes de agentes son candidatos, no nombres GSD aprobados.
- `STATE.md`: cambiar el siguiente paso solo después de aprobar el desglose.
- `01-PLAN-CHECK.md`: decidir si se renombra al patrón canónico antes de ejecutar; GSD Core lo omite por llamarse `01-PLAN-CHECK.md`, aunque el informe se conserva como evidencia documental.

## Evidencia revisada

- GSD Core encuentra cuatro planes Phase 1 incompletos en tres olas: 01-01; 01-02 y 01-03; 01-04. Configuración actual: máximo tres agentes, paralelismo por plan activado y por tarea desactivado.
- Claude recomienda preservar el alcance y añadir encargos cortos, pero su agrupación E1–E6 no parte los dos pasos que OpenCode identifica como grandes.
- OpenCode recomienda dividir esos pasos, congelar el contrato del runner y revisar la base de worktrees y los cupos de revisión. Su cálculo de ~107k tokens es una estimación, no una medición del consumo real.
- La copia de `.planning` en el worktree hijo coincide con los 23 archivos originales; los dos informes están separados y los documentos fuente permanecen intactos.

## Decisiones pendientes

1. Confirmar que el cambio buscado es solo hacer Phase 1 más pequeña y recuperable frente a límites de cuota.
2. Aprobar el piloto de 01-01 antes de dividir el resto de Phase 1.
3. Confirmar que el máximo de tres cuenta al coordinador; esta propuesta lo cuenta.
4. Tras el piloto, elegir el tamaño final con evidencia de consumo real y no con la estimación actual.

## Informes de agentes

- Claude: `.planning/roadmap-change/CLAUDE-DESIGN.md` en el worktree hijo.
- OpenCode: `.planning/roadmap-change/OPENCODE-REVIEW.md` en el worktree hijo.
