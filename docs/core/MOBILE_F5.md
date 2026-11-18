# Mobile F5 · operaciones privadas

## Preguntas y aprobación inicial · LXO-164 / LXO-165

Las implementaciones de los PRs #243 y #244 ya están integradas en master.
`mobile_question` usa Attention + Attempt + request_id + asked_at y conserva
el borrador en memoria ante un resultado no confirmado. `mobile_launch_approval`
solo decide aprobaciones iniciales no elevadas, pendientes y vigentes. El Core
resuelve Attention como consecuencia; el teléfono no la marca resuelta.

## Revisión · LXO-166

`mobile_review` es un RPC privado del host. El gateway vuelve a autenticar una
sesión de Mobile del dueño en cada solicitud; ignora identidades aportadas por
el cuerpo. Las respuestas solo llegan al controller que las pidió y no entran
en el transcript, replay ni persistencia. Las solicitudes privadas no se
reenvían automáticamente tras una desconexión.

La lectura lleva `attention_id` y `attempt_id`. Para Attention sobre Task,
Mobile consulta una vez el intento actual y muestra su ID antes de decidir;
no cambia silenciosamente de intento si aparece otro. El Core comprueba que
la Attention `review_ready` siga activa y corresponda a esa Task/Attempt.

La decisión lleva `{ review_id, head_commit, verdict, confirm: true }`.
`review_id` identifica la solicitud de revisión (la Attention mostrada), no
una decisión que todavía no existe. Se vuelve a leer el Proof Pack y el HEAD
vivo y se ejecuta el Command `attempt_review` existente sobre el hash exacto.
Aceptar no integra ni crea PR; rechazar conserva el Attempt y el worktree.
La base Mobile de `review` exige confirmación; `deny` y `elevated` bloquean.
La autorización adicional en Tx solo permite review desde Mobile: ni merge,
ni PR, ni el RPC genérico `attempt_review` se abren a este cliente.

El diff móvil debe estar completo, con un máximo de 30 archivos y 32 KiB de
parches. Binarios, worktrees compartidos, un objetivo recortado o revisiones
incompletas obligan a continuar en Desktop. Provenance se conserva:
`verified`, `agent_reported` y `unknown` nunca se intercambian. El Core actual
no recopila resultados de pruebas ni verifica capturas o artefactos: se dice
explícitamente. Los locators de artefactos se excluyen del resumen privado.

Mobile exige reconocer «He revisado esta revisión», y muestra IDs y hash en
la confirmación. Un cambio de revisión, conexión, primer plano o generación
de lectura invalida esa confirmación. HEAD movido obliga a leer y reconocer
la revisión nueva. Un ACK del gateway no se presenta como decisión registrada.

`Open on Desktop` solicita al mismo host seleccionar el trío Project/Task/Attempt
verificado y activar el ADE. La respuesta de éxito solo se emite después de
actualizar la vista y enfocar la ventana. El enlace canónico de diff puede
copiarse como alternativa; registrarlo en el sistema operativo sigue siendo F6.

El límite de atomicidad Git/SQLite del Command de revisión se conserva: una
escritura externa inmediatamente posterior a la comprobación del HEAD no se
puede bloquear, y la aceptación sigue vinculada al hash exacto recibido.

## Validación

Los tests de Core usan repositorios, worktrees, decisiones y Attention reales,
con adapters falsos. Comprueban Accept/Reject, HEAD movido sin escritura,
policy elevada, superficie genérica cerrada y diff grande/binario. Las pruebas
de host emparejan el enlace real de Mobile con el handler privado; las de
WebSocket comprueban autenticación, aislamiento, revisión manipulada y replay.

La aceptación nativa conjunta y las evidencias de UI se completan en LXO-49.
