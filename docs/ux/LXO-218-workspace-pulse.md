---
id: LXO-218-workspace-pulse
titulo: Workspace Pulse — resumen compacto de salud por fila del navegador
tipo: validacion-ux
estado: prototipo-evaluado
ticket: LXO-218
componente: apps/desktop/src/ade/preview/pulseModel.js
pruebas: apps/desktop/src/ade/preview/pulseModel.test.js, apps/desktop/src/ade/preview/WorkspacePulse.test.jsx
tags:
  - lxo-218
  - pulse
  - sidebar
  - procedencia
  - desktop
  - ux
---

# Workspace Pulse (LXO-218)

**Tipo:** validación de producto/UX. Prototipo en la vista previa del ADE (datos simulados, nada lee el Core) y decisión
documentada. No sustituye el estado y no bloquea F5.

## 1. Qué es

Una línea de resumen en cada fila del navegador (Project → Task → Intento) para saber cómo va el trabajo sin abrirlo.
Referencia North Star: `Working · 6m · 12 files · tests 118/141 · 1 Attention · Claude · Desktop`.

Reglas que el prototipo cumple y las pruebas fijan:

1. **El estado sigue primero.** Pulse no repite ni reemplaza el estado: va detrás, en la misma línea.
2. **La Attention conserva su marcador.** El `!` ámbar queda en la primera línea; el texto del Pulse nunca la menciona.
3. **Lo desconocido no se transforma en 0 ni en 100 %.** Sin dato se pinta `—` (con su texto «Sin dato» para el lector).
   Un total de pruebas 0 o incoherente es desconocido. No hay porcentajes ni «progreso» en ninguna señal.
4. **Procedencia visible.** `verified` (lo midió el Core) sin marca; `agent_reported` con subrayado punteado y «Lo dice el
   agente» en el tooltip y para el lector; `unknown` en gris con `—`. Es el mismo vocabulario que Compare y el Proof Pack.
5. **Sin saltos.** La altura de la fila no cambia con o sin Pulse (medido: 52/54 px en ambos casos); un evento de fondo
   cambia el texto de la fila pero no reordena, no remonta el nodo y no mueve el foco.

## 2. Las cinco variantes

No son estados nuevos: agrupan los estados del Intento solo para decidir **qué pregunta responde** el Pulse.

| Variante | Estados que agrupa | Pregunta | Prioridad de señales |
|---|---|---|---|
| working | starting, working | ¿cuánto lleva? | host, duración, tests, archivos, proveedor, origen |
| waiting | waiting, queued, paused, offline | ¿cuánto lleva esperando? | host, duración, archivos, tests, proveedor, origen |
| review | review_ready | ¿está comprobado? | host, tests, archivos, duración, proveedor, origen |
| failed | failed | ¿qué se rompió? | host, tests, duración, archivos, proveedor, origen |
| final | completed | ¿está comprobado? | host, tests, archivos, duración, proveedor, origen |

Un dato desconocido solo se enseña en review/failed/final (donde «¿se comprobó?» importa); en curso se omite para no
llenar la fila de guiones. Sin worktree (solo lectura) no hay archivos; en starting/queued no hay archivos ni pruebas.

## 3. Evaluación con un Workspace denso

Medida en el navegador sobre la vista previa (sidebar de 280 px; «Simular → Workspace denso (40 filas)» añade filas
deterministas: 55 en total, las cinco variantes, procedencias mezcladas, Tasks con dos Intentos).

| Configuración | Filas con recorte | Señales visibles por fila | Altura de fila |
|---|---|---|---|
| Sin Pulse (línea de antes) | 10 de 55 (ya recortaban proveedor/minutos) | — | 52–54 px |
| Pulse completo (4 señales en una línea) | **49 de 55 (89 %)**; se perdían las pruebas en 33 filas | 3,2 | 52–54 px |
| **Pulse con presupuesto (36 caracteres)** | **0 de 55** (también con «peor caso») | **1,4** | 52–54 px |

Conclusión de la medición: **con 280 px solo caben una o dos señales por fila.** El Pulse completo de la referencia North
Star no entra en una línea de este navegador. Por eso el prototipo reparte un presupuesto de caracteres (`LINE_BUDGET`)
por la prioridad de cada variante y se para en la primera señal que no cabe; lo que tiene dato y no cabe va al tooltip de la
fila y al lector de pantalla (`hidden`), nunca se recorta a medias. Coste: 50 de 55 filas esconden alguna señal.

## 4. Teclado y lector de pantalla

- Cada fila es un único `button`; no hay controles anidados, ni `aria-live`, ni `role=status` dentro de las filas: un
  cambio de fondo no anuncia nada.
- Lo visible va en `aria-hidden`; cada señal trae su texto completo con procedencia («Pruebas: 138 de 141 pasan, 3
  fallan. Lo dice el agente»), y las señales ocultas por anchura se leen igual.
- Las pruebas que fallan no dependen del color: el texto accesible dice cuántas fallan.
- El interruptor «Pulse» (panel de Filtros) usa `aria-pressed`.

## 5. Lo que NO es verdad todavía en el Core real

- `task_list_v2` y `attempt_brief` traen `started_at`/`ended_at`/`created_at`, proveedor y origen: **duración, proveedor y
  origen sí se pueden dar con datos reales**.
- **Archivos y pruebas no están en esas lecturas.** Archivos solo salen de Compare/Proof Pack por Intento (git en vivo), y
  las pruebas son siempre `unknown/not_collected` (COMPARE.md). En la vista previa la procedencia de archivos/pruebas es
  simulada (`PULSE_EVIDENCE` en `previewData.js`).
- «Attention N» no se incluye en el Pulse a propósito: ya tiene marcador propio.

## 6. Decisión

**Recomendación: CHANGE (no «ship» tal cual, no «drop»).** Está pendiente de la revisión de UX (la issue lleva
`needs:ux-review`); esto es lo que sostienen los datos.

1. Publicar en el ADE real solo un Pulse **reducido de una línea** con lo que el Core ya da con respaldo: duración,
   proveedor y origen. El estado y la Attention no cambian.
2. **No** publicar archivos/pruebas en el sidebar real hasta que el Core exponga un resumen estructurado por Task/Attempt
   (extensión de `task_list_v2`, fuera de este PR). Mientras tanto viven en el Proof Pack y en Compare.
3. Mantener el resumen completo en el tooltip y para el lector; el presupuesto de línea es parte del contrato.
4. Dejar la vista previa con Pulse como banco de pruebas (interruptor y «Workspace denso»).

No resuelto: el presupuesto es por caracteres y se midió a 280 px; un sidebar redimensionable necesitaría medir la anchura real.
