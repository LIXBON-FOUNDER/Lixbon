# LXO-224 · Protocolo de validación de navegación y orientación

**Tipo:** protocolo de sesiones; no contiene resultados de participantes
**Estado:** materiales listos; validación humana **BLOCKED** hasta completar dos sesiones individuales con desarrolladores
**Pregunta:** ¿puede una persona encontrar un trabajo activo, bloqueado o pendiente de revisión sin perder contexto ni cambiar accidentalmente de target?

## 1. Propósito y límite de la evidencia

Este protocolo permite validar la orientación espacial del Desktop, la navegación Project → Task, la lectura separada de status y Attention, la ubicación del trabajo, el teclado/foco y la comprensión de estados de conexión. Cada observación debe indicar si procede de la superficie F2 conectada a un Core aislado o de un fixture North Star.

La sesión no modifica Tasks, Projects, Attempts, Core, worktrees ni Linear. Los escenarios de esta guía usan IDs `fx-*` y datos ficticios. No se deben sembrar fixtures en un Core de producción ni usar trabajo, rutas, nombres de host o credenciales reales como material de la sesión.

### Frontera F2 y North Star

| Tema | F2 productivo | Fixture North Star |
|---|---|---|
| Navegación | Projects y Tasks del Core; registrar los IDs realmente mostrados y la consulta disponible en el build. El shell LXO-95 usa `project_id`/`task_id` durables y consultas read-only. | Puede mostrar los 3 Projects y 11 Tasks de esta guía con IDs `fx-*`. Es una maqueta conceptual. |
| Attempts | **F2 no tiene Attempts como entidad ni navegación. Nunca se deben mostrar ni abrir Attempts en escenarios F2, sin importar las fuentes o contratos que exponga el build; en F2 son N/A.** | Probar exclusivamente el patrón conceptual futuro de 0/1/N Attempts en North Star/F3; etiquetar cada pantalla `NORTH STAR / FIXTURE · F3`. |
| Status | Registrar el valor del Core y el texto renderizado. No inferirlo desde Attention, unread ni Attempts. El build puede exponer solo un subconjunto de filtros/estados. | Usar los estímulos `working`, `waiting`, `review`, `failed` y `final` de la tabla. No presentarlos como datos de Core. |
| Attention | LXO-95 no presenta Attention simulada ni un Inbox global. Solo validar una señal si el build la lee de una fuente autoritativa y el origen se puede registrar. La ausencia en el shell actual no se rellena con mocks. | Los ejemplos de Attention son estímulos visuales ficticios, nunca prueba del Core. |
| Unread | La documentación del Core separa Attention de unread/Activity y no define columnas de lectura por persona/dispositivo. No mostrar ni inventar un badge o contador. Si antes de la sesión se identifica una fuente autoritativa distinta, registrar contrato, query y propietario; si no, unread es **N/A** como señal visible. | No mostrar unread en el fixture base. Preguntar qué puede saberse sin una señal de lectura y registrar cualquier confusión con status o Attention. |
| Host, origin y worktree | Son datos de ubicación/procedencia, no identidad del target. Validar solo los campos realmente entregados por el build; ausente/unknown no equivale a missing. | Se pueden mostrar valores `fx-*` y cambiar una ruta para comprobar que el ID del target permanece estable. |
| Mutaciones | ADE F2 es read-only para Projects/Tasks. No crear, cerrar, reintentar, resolver, integrar ni ejecutar Commands durante la sesión. | Controles de simulación sirven para discutir el concepto, no para afirmar comportamiento productivo. |
| Loading, stale, degraded y reconnect | Probar runtime solo con un perfil aislado y una transición segura que ya esté preparada. No inyectar fallos sobre internals ni detener el proceso Core/WebView2. Sin seam seguro, marcar la evidencia runtime **BLOCKED**. | Se pueden presentar capturas/estados preparados para evaluar si la persona entiende el mensaje y la preservación del target; el resultado es conceptual, no runtime F2. |

**Regla de atribución:** una respuesta correcta ante un fixture demuestra comprensión de ese estímulo, no que F2 o Core ya tengan esa capacidad. No trasladar un PASS de North Star a F2/F3 ni al revés.

## 2. Contexto de aceptación utilizado

- **LXO-224:** navegación ORCA-like Project → Task → Attempt en North Star; compresión de 1 Attempt y expansión de N; estados normalizados; separación status/Attention/unread; Jump Palette; metadata host/origin/worktree; estados loading/empty/stale/degraded; teclado/foco; búsqueda/navegación con al menos dos desarrolladores; decisiones posteriores para North Star y handoff claro a F2/F3.
- **LXO-95 y `marlin/LXO-95-resultados.md` (2026-10-20):** contexto de navegación F2 read-only por IDs durables. El reporte describe una consulta autenticada cuyo corte más reciente no contenía Tasks activas y deja bloqueados los estados runtime de error, disconnected, degraded, stale y reconnect por falta de una seam segura. También distingue el shell activo actual de las listas completas/finales y del detalle ampliado asignados a LXO-97/LXO-98. Es evidencia histórica dependiente del fixture, no resultado de esta sesión ni estado garantizado para otro build.
- **LXO-97 / LXO-98 / LXO-101 / LXO-204:** orientación y filtros de sidebar, destino verificable por ID, metadata de ubicación, y vistas de Project/Task; Attempt nesting sigue fuera de F2.
- **`docs/core/ATTENTION.md`:** Attention es estado pendiente del Core; unread/Activity es una señal distinta y futura. El esquema de Attention no es fuente de lectura.
- **Referencia North Star:** `C:\Users\USUARIO\lixbon-wt\design-unified-mockup\docs\mockup\DISENO.md` y `VALIDACION_2026-10-13.md`. La maqueta documenta datos simulados; no es producto conectado ni fuente de evidencia F2.

Antes de cada campaña, el moderador debe anotar el SHA/build realmente usado y confirmar que estas fronteras siguen aplicando. Si el contrato o el build difiere, pausar ese escenario y registrar la discrepancia; no resolverla mediante una suposición.

## 3. Participantes, duración y privacidad

- **Participantes requeridos:** dos desarrolladores, en sesiones separadas, con el mismo guion y fixtures. Usar únicamente los códigos anónimos `D01` y `D02`; asignarlos al iniciar cada sesión. No escribir nombres, correo, empleador ni información personal en notas.
- **Equipo de sesión:** un moderador; un observador/notetaker es opcional. Quien modera no debe indicar dónde hacer clic ni corregir la respuesta antes de terminar el escenario.
- **Duración prevista:** 40–50 minutos por persona, incluida la introducción y el cierre.
- **Datos:** solo los fixtures `fx-*`. Ocultar notificaciones y otras ventanas con datos privados. No capturar tokens, contenido de clientes, rutas personales ni conversaciones reales. Guardar notas con acceso restringido y compartir únicamente resultados agregados/anónimos.
- **Grabación:** por defecto no grabar. Si se propone captura de pantalla/audio, pedir permiso explícito por separado; si la persona no acepta, continuar con notas manuales. No iniciar la grabación antes de obtener consentimiento.
- **Retiro:** la persona puede omitir una pregunta o terminar la sesión en cualquier momento, sin justificarlo.

### Texto de consentimiento para leer

> Estamos evaluando la navegación y las etiquetas, no tu desempeño. Usaremos datos ficticios y una vista de solo lectura; esta sesión no modifica Projects, Tasks ni el Core. Puedes pensar en voz alta, pedir una pausa, omitir una tarea o terminar cuando quieras. Tomaremos notas con un código anónimo; no registraremos tu nombre ni datos personales. No grabaremos salvo que aceptes una solicitud separada. ¿Aceptas participar con estas condiciones?

**Registro:** `Consentimiento verbal: [sí / no]` · `Grabación separada: [sí / no / no solicitada]`. Si no acepta participar, detener la sesión y no crear observaciones de usuario.

## 4. Preparación y preflight

Completar antes de cada participante. Si un control crítico falla, no improvisar sobre datos reales: marcar el escenario afectado **BLOCKED**.

- [ ] Confirmar que hay dos desarrolladores disponibles y reservar una sesión individual para cada uno. Sin dos sesiones no se satisface la aceptación humana.
- [ ] Elegir y marcar el modo de cada escenario: `F2 aislado`, `North Star fixture` o `captura conceptual`. No mezclarlos en una sola conclusión.
- [ ] Registrar SHA/build, versión Desktop/WebView2, resolución/escalado, sistema operativo, idioma, host de prueba, origin, worktree de la prueba y versión/hash del fixture. Usar etiquetas sanitizadas; no guardar rutas personales.
- [ ] Confirmar que el perfil Core es aislado y ya está provisionado por la persona dueña del entorno. El moderador no crea ni modifica datos en Core durante la validación. Si no existe un fixture aislado y poblado, las tareas runtime F2 quedan bloqueadas.
- [ ] Confirmar que las consultas y vistas F2 a probar son read-only. No usar botones de Operation/Run como sustituto de Project/Task.
- [ ] Preparar una copia reiniciable del fixture por participante; el estado inicial y los mismos IDs deben coincidir en ambas sesiones.
- [ ] Preparar, si hay entorno North Star, las escenas conceptuales 0/1/N Attempts de F3 y los estados de conexión con una marca visible `NORTH STAR / FIXTURE · F3`.
- [ ] Preparar cualquier captura o estado stale/degraded/reconnect por un método reversible y aislado. Si la única opción es modificar internals, detener el Core integrado, corromper almacenamiento o forzar una falla en producción, no ejecutar: marcar runtime **BLOCKED**.
- [ ] Verificar que no aparezcan nombres reales, secretos, actividad de otras personas ni notificaciones privadas. Cerrar ventanas ajenas al escenario.
- [ ] Confirmar teclado funcional y que se conocen los atajos publicados por ese build. No introducir un atajo que no esté documentado o visible.
- [ ] Reiniciar la vista al estado inicial antes de D01 y D02 por separado; limpiar solo estado local del fixture, nunca una carpeta o almacén sin identificar.

**Comprobación condicional de unread:** antes de mostrar cualquier unread UI, el responsable debe proporcionar la fuente autoritativa separada (schema/API/query), su propietario y la semántica de lectura por persona/dispositivo. En el contexto actual no se encontró esa fuente para ADE; por tanto, el escenario base no lleva badge, contador ni estado de lectura.

## 5. Fixture aislado

Los nombres, estados, IDs, Attempts y ubicaciones siguientes son inventados para la sesión. `fx-*` identifica entidades dentro del fixture, no entidades reales del Core. Los valores de Attention y Attempts son estímulos ficticios de North Star/F3. Ningún escenario F2 muestra ni navega Attempts, sin importar la fuente o contrato que exponga el build.

| Project ID | Project | Task ID | Task | Status de estímulo | Attention de estímulo (North Star) | Attempts (North Star/F3 únicamente) |
|---|---|---|---|---|---|---:|
| `fx-p-001` | Atlas Console | `fx-t-001` | Navegación por teclado | working | none | 0 |
| `fx-p-001` | Atlas Console | `fx-t-002` | Restaurar foco tras diálogo | waiting | active: question | 1 |
| `fx-p-001` | Atlas Console | `fx-t-003` | Contraste de roles | review | active: review | 3 |
| `fx-p-001` | Atlas Console | `fx-t-004` | Buscar de nuevo tras refresh | final | none | 1 |
| `fx-p-002` | Orion Sync | `fx-t-005` | Reconectar datos stale | working | none | 1 |
| `fx-p-002` | Orion Sync | `fx-t-006` | Preservar target en refresh | failed | active: failed | 2 |
| `fx-p-002` | Orion Sync | `fx-t-007` | Cache de inicio | final | none | 0 |
| `fx-p-003` | Harbor Billing | `fx-t-008` | Preservar foco durante update | waiting | none | 4 |
| `fx-p-003` | Harbor Billing | `fx-t-009` | Buscar de nuevo tras refresh | review | none | 1 |
| `fx-p-003` | Harbor Billing | `fx-t-010` | Resumen de exportación | final | active: review | 0 |
| `fx-p-003` | Harbor Billing | `fx-t-011` | Ubicación desconocida | working | none | 2 |

Para el escenario de ubicación, preparar estos metadatos ficticios:

| Task | Host | Origin | Worktree/location | Variación preparada |
|---|---|---|---|---|
| `fx-t-003` | `fx-host-local` | `fixture://atlas` | `fx-worktree/atlas/roles` | Mostrar metadata completa. |
| `fx-t-005` | `fx-host-east` | `fixture://orion` | `fx-worktree/orion/reconnect` | Después de seleccionar, cambiar solo la location a `fx-worktree/orion/reconnect-v2`; mantener `fx-t-005`. |
| `fx-t-006` | `fx-host-west` | `fixture://orion` | `fx-worktree/orion/stale-cache` | Comparar metadata con el Project correcto. |
| `fx-t-011` | unknown | unknown | unknown | Mantener unknown; no sustituir por missing ni deducirlo del nombre. |

`fx-t-004` y `fx-t-009` comparten título a propósito: el Project padre y el Task ID distinguen el target. Las ubicaciones `fx-*` son etiquetas de escenario, no rutas que deban resolverse en el disco.

## 6. Guion de moderación

### Apertura

Leer literalmente: “Gracias. Primero mirarás una navegación de Desktop. Usa el método que te resulte natural y di en voz alta qué esperas que ocurra. Yo observaré; intentaré no ayudarte. Si algo no responde como esperas, dime qué harías. Las tareas están terminadas cuando me lo indiques.”

No explicar el árbol, las etiquetas ni los estados antes de que la persona los vea. Si solicita ayuda, preguntar primero: **“¿Qué probarías si yo no estuviera aquí?”** Registrar cualquier ayuda dada y no contar ese escenario como completado sin asistencia.

### Tareas y prompts

| # | Escenario / modo | Instrucción para leer | Observar y preguntar después |
|---:|---|---|---|
| 1 | Orientación espacial · F2 o North Star, marcar cuál | “Abre Atlas Console y encuentra una tarea que esté esperando. Muéstrame dónde estás ahora.” | Registrar primer destino, rastro Project → Task, retroceso/cambio de sección y si puede nombrar Project y Task. Preguntar: “¿Qué te confirma que sigues dentro de ese Project?” |
| 2 | Project → Task y títulos similares · ambas pistas separadas | “En Harbor Billing, encuentra ‘Buscar de nuevo tras refresh’. Cuando termines, dime qué tarea elegiste y cómo comprobaste que pertenece a Harbor Billing.” | El target es `fx-p-003 / fx-t-009`, no `fx-t-004`. Registrar IDs visibles/consultados, errores de selección y si label/path reemplazó al ID en su explicación. Preguntar: “¿Qué cambiaría si el título o la ubicación cambiara?” |
| 3 | Status, Attention y unread · North Star conceptual; F2 por separado | “Compara ‘Restaurar foco tras diálogo’, ‘Preservar foco durante update’ y ‘Resumen de exportación’. ¿Qué sabes del estado de cada una? ¿Cuál necesita atención ahora? ¿Cuál sabes que aún no has visto?” | No sugerir respuesta. En F2 registrar status bruto y texto, y si existe una Attention autoritativa visible. No mostrar unread inventado. Si no hay fuente de lectura, la respuesta válida del sistema es que no permite saber unread. Preguntar: “¿Qué evidencia separa estas señales?” |
| 4 | Target durable y metadata · North Star o F2 si el build la entrega | “En Orion Sync encuentra ‘Reconectar datos stale’. Describe el host, origin y worktree que ves. Ahora cambia la location del escenario y vuelve a cargar. ¿Sigue siendo el mismo trabajo?” | El fixture mantiene `fx-t-005`; solo cambia la location. Registrar selección antes/después, ID, foco/scroll y si la persona trata host/branch/path como identidad. Preguntar: “¿Qué dato usarías para volver a este target?” |
| 5 | Teclado y foco · ambas pistas por separado | “Sin usar el mouse, ve a Harbor Billing y selecciona ‘Buscar de nuevo tras refresh’. Abre la búsqueda o Jump Palette solo si el build la ofrece, ciérrala y continúa con el mismo target.” | Registrar teclas y orden, foco visible, entrada/salida de overlay, retorno de foco, lectura de selección por teclado, trampas y atajos que chocan con campos de texto. Mientras conserva el foco en la fila, presentar una actualización de fondo preparada y preguntar: “¿Dónde quedó tu selección?” |
| 6 | Loading, stale, degraded y reconnect · runtime aislado o captura conceptual | Presentar por separado: (a) loading inicial; (b) datos stale con marca de última actualización; (c) degraded/read-only; (d) desconectado y reconnect exitoso. Decir: “Cuéntame qué está disponible, qué no puedes asumir y qué harías ahora.” | Registrar comprensión de estado actual vs viejo, mensaje/acción esperada, target/foco/scroll antes y después, y si distingue error de lista vacía. Para captura o North Star, el veredicto será conceptual. Si falta un seam aislado, runtime queda **BLOCKED**, aunque la captura se entienda. No provocar fallos en el Core integrado. |
| 7 | 0/1/N Attempts · North Star/F3 conceptual únicamente, al final | Mostrar `fx-t-001` (0), `fx-t-002` (1) y `fx-t-003` (3) con el encabezado visible `NORTH STAR / FIXTURE · F3`. Decir: “Explícame cómo entiendes esta agrupación y qué cambia entre estos tres casos.” | Preguntar si la Task sigue siendo el target al expandir N. Registrar orientación, densidad y vocabulario; no preguntar ni sugerir que esto exista en F2. Este escenario nunca puntúa como comportamiento productivo F2. |

### Preguntas neutrales de seguimiento

Usar solo después de la instrucción de la tarea, sin señalar controles:

- “¿Qué esperabas que ocurriera?”
- “¿Qué te hizo elegir ese elemento?”
- “¿Qué te indica dónde estás?”
- “¿Qué parte te resultó ambigua?”
- “¿Qué dato usarías para comprobar el target?”
- “¿Qué sabes y qué no sabes a partir de esa señal?”
- “¿Cambió algo que no esperabas mientras trabajabas?”
- “¿Qué cambiarías primero para que esto fuera más claro?”

No convertir opiniones en hechos del producto. Guardar observaciones como conducta/explicación, no como aprobación del entrevistador.

## 7. Checks de accesibilidad, teclado y foco

Aplicar los checks en la tarea 5 y registrar el método de entrada. No declarar conformidad WCAG a partir de una inspección informal.

- Completar Project → Task sin mouse mediante el mecanismo publicado por ese build; registrar cada tecla necesaria y si la persona la descubre.
- Confirmar foco visible en cada paso y orden lógico de tabulación. Si el árbol usa flechas, verificar que Enter/Espacio seleccione solo el elemento enfocado.
- Abrir/cerrar búsqueda, palette o diálogo con el mecanismo disponible; Escape debe cerrar el overlay sin borrar la selección y devolver foco al iniciador cuando corresponda.
- Una actualización de fondo no debe cambiar silenciosamente Project, Task, foco ni scroll. Registrar foco y IDs antes/después.
- Estados no deben depender solo de color: anotar el texto, icono/forma y anuncio accesible disponibles. No asumir que un color se entiende igual para todos.
- Si la persona usa lector de pantalla o alto contraste y acepta, anotar tecnología/preferencia de forma general, sin perfil personal. Verificar nombres accesibles, estado seleccionado/expandido y aviso de conexión si el entorno lo permite. Si no se evalúa, indicar `no ejecutado`, no PASS.
- Atajos no documentados, colisión con inputs o ausencia de una función en el build actual se registran como tales. No instalar extensiones ni añadir cambios de configuración para forzar el escenario.

## 8. Evidencia y criterios de veredicto

### Por escenario

- **PASS:** la persona completa sin ayuda la intención central, llega al Project/Task correcto, explica la señal relevante y conserva orientación/foco según lo esperado. El modo y la fuente de datos están registrados.
- **PARTIAL:** completa con una repetición neutral o con dudas recuperables; no hay target equivocado ni una inferencia peligrosa, pero la señal, el camino o el estado no queda claro.
- **FAIL:** selecciona un target incorrecto, no puede recuperar orientación, status y Attention se presentan/interpretan como equivalentes, se atribuye unread sin fuente, pierde foco de forma que cambia el target, o cree que F2 permite una operación/Attempt que no existe.
- **BLOCKED:** el escenario no se puede ejecutar o evidenciar con seguridad por falta de participante, fixture, build, autorización read-only, metadata, fuente autoritativa o seam de runtime. No es un fallo de participante ni un PASS.
- **N/A:** una condición no aplica al contrato actual, por ejemplo unread sin fuente autoritativa o Attempts en F2. Explicar la razón; nunca contar N/A como PASS.

### Agregado de campaña

Mantener veredictos separados para `North Star conceptual`, `F2 observado` y `runtime de estados`. La campaña de participantes permanece **BLOCKED** mientras no haya notas de dos desarrolladores. Con dos sesiones completas, usar:

- **PASS:** ambas personas completan las tareas críticas sin ayuda, sin confusión de target y sin inferencias fuera de la fuente; toda afirmación F2 tiene evidencia F2. North Star puede aprobarse por separado.
- **PARTIAL:** no hay fallos críticos, pero aparece al menos un parcial, evidencia incompleta o gate no ejecutable; reportar qué decisión de diseño sigue abierta.
- **FAIL:** una observación reproducible muestra selección incorrecta, pérdida de foco que cambia target, o confusión crítica de señales/límites. Registrar el caso concreto; no suavizarlo por preferencia general.
- **BLOCKED:** no se completaron las dos sesiones o faltó una precondición/material para el gate. No declarar cierre de LXO-224 ni extrapolar al build/usuario que no se observó.

Una sesión aislada puede tener su propio registro `D01` o `D02`, pero no autoriza un veredicto agregado. Los casos runtime que sigan sin seam segura permanecen BLOCKED aunque los estados conceptuales resulten comprensibles.

### Evidencia mínima por observación

1. Código anónimo, fecha/hora aproximada y consentimiento; sin nombre.
2. Modo (`F2 aislado`, `North Star fixture`, `captura conceptual`) y versión/SHA/build.
3. Project ID y Task ID esperados/observados; consulta/fuente cuando aplique.
4. Estado bruto y label renderizado; origen de Attention; source/schema/query de unread o razón N/A.
5. Host/origin/worktree como valores sanitizados, incluyendo `unknown` explícito si corresponde.
6. Secuencia de navegación/teclas, primer error o pausa, cantidad/tipo de ayuda, target/foco/scroll antes y después.
7. Para estados de conexión: método de preparación, hora de última actualización mostrada, estado del target y si se pudo repetir la transición de forma segura.
8. Veredicto, observación concreta y cita breve anonimizada/parafraseada. Adjuntar captura solo con consentimiento y solo de fixture sintético.

## 9. Plantilla para capturar una sesión

Copiar una sección por persona y una subsección por escenario. Dejar los campos vacíos o `no observado` hasta hacer la sesión; esta plantilla no contiene resultados.

```text
LXO-224 — Registro de sesión

Participant ID: [D01 / D02]
Fecha/hora aproximada: [pendiente]
Consentimiento: [pendiente]
Grabación: [no / sí, autorización separada pendiente]
Modo(s): [F2 aislado / North Star fixture / captura conceptual]
Moderador / observador: [roles, sin nombres en copia compartida]

Build / SHA Desktop: [pendiente]
Versión WebView2 / sistema / resolución / escala: [pendiente]
Host de sesión / origin / worktree de prueba: [etiquetas sanitizadas]
Fixture version/hash y estado inicial: [pendiente]
Tecnología de acceso usada, si aplica: [general, opcional]

Escenario #: [pendiente]
Acceptance item: [LXO-224 / F2 / North Star / runtime]
Expected Project ID / Task ID: [pendiente]
Observed Project ID / Task ID: [pendiente]
Query / fuente autoritativa: [pendiente / no disponible]
Status bruto → label visible: [pendiente]
Attention source + item/target: [pendiente / no visible]
Unread source/schema/query: [pendiente / N/A: no existe fuente confirmada]
Attempts: [N/A en F2 / 0, 1 o N en North Star/F3]
Host / origin / worktree: [sanitizados / unknown]
Secuencia de acciones/teclas: [pendiente]
Primera selección / retrocesos / ayuda neutral: [pendiente]
Foco y scroll antes → después: [pendiente]
Estado de conexión / preparación segura: [pendiente]
Observación concreta: [pendiente]
Respuesta/cita anonimizada o paráfrasis: [pendiente]
Evidencia asociada, solo fixture: [pendiente / ninguna]
Veredicto: [PASS / PARTIAL / FAIL / BLOCKED / N/A]
Razón del veredicto: [pendiente]

Notas de privacidad/eliminación: [pendiente]
```

## 10. Bloqueos y cierre

**Estado al preparar este protocolo:** no se han realizado sesiones con desarrolladores. La validación humana de LXO-224 está **BLOCKED** hasta obtener dos participantes y completar ambos registros; este documento no afirma entrevistas, outcomes, decisiones ni aceptación UX.

Los gates de loading/stale/degraded/reconnect en runtime F2 también permanecen **BLOCKED** si no se dispone de un perfil aislado y una transición preparada segura. Una captura conceptual puede informar el diseño, pero no despeja ese gate. Unread es **N/A** en el escenario actual porque no se identificó fuente autoritativa separada; si la fuente aparece, se documenta antes de mostrar cualquier indicador.

Al terminar las sesiones, resumir fricciones y decisiones con IDs anónimos; separar hallazgos F2 de North Star/F3 y proponer el destino productivo correspondiente. La actualización del North Star y cualquier cambio de issues se hacen en el flujo dueño de esos artefactos, no como resultado implícito de completar este protocolo.
