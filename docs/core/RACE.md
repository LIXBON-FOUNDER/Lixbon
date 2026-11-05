# Race (LXO-215)

Race lanza **de 2 a 4 candidatos comparables a la vez** desde el mismo Attempt, con un `race_id` y una procedencia comunes. Es una operación
explícita, no un Fork repetido a mano. Implementación: `orch/race_runtime.rs` (sobre `fork_runtime`); contrato de los hechos en
[EVENTOS.md](EVENTOS.md).

## Qué es cada candidato

Un **Fork de verdad** ([FORK.md](FORK.md)): su propia Task, su Attempt `pending_approval`, su rama y su worktree, con identidad e historia
propias. Corren a la vez porque son **Tasks distintas**: no cambia «un solo Attempt activo por Task» (ATTEMPTS D19). Ninguno comparte
worktree y el origen no recibe ni un hecho. Todos nacen pendientes de la aprobación de la persona, como cualquier primer Attempt.

## Commands

| Command | clase | qué hace |
|---|---|---|
| `task_race { request_id, source_attempt_id, candidates[2..4], package?, confirm? }` | `HumanDecision` (Person de Desktop) | lanza el Race. Cada candidato: `{ provider?, model?, effort?, role?, title? }` (lo no pedido se hereda del origen) |
| `task_race_status { race_id }` / `{ source_attempt_id }` | lectura (ADE) | el Race con todos sus candidatos, o los Races de ese Attempt (los más recientes primero) |
| `task_race_cancel { race_id, attempt_id?, confirm? }` | `HumanDecision` | cancela UN candidato o todos los que no han terminado |

`deny_unknown_fields`: no se acepta `host`, `worktree`, perfil ni aprobación. **No hay elección de host ni de estrategia de worktree**: hoy hay un
solo host y cada candidato recibe el suyo.

## Flujo de `task_race`

1. **Todo lo comprobable sin escribir se comprueba antes**: Person autenticada, lanzador, `request_id`, 2–4 candidatos válidos, origen, y el
   ContextPackage (verificado **una vez** contra el origen y el Project). Un candidato inválido rechaza el Race entero; no es un fallo parcial.
2. `race_id = rc-<hash(identidad, request_id)>`: el mismo reintento cae en el mismo Race. La misma clave con **otra** petición (otros candidatos u
   otro paquete) → `request_conflict`, sin lanzar nada.
3. `race.requested` (idempotente) con el `digest` de lo pedido.
4. **Por cada candidato, en orden**: se valida la **policy** (`fork`) y el **límite de Tasks activas** ANTES de lanzar, y solo si no es un replay; luego el
   Fork con la clave `<race_id>-c<i>`, y se registra `race.candidate_recorded`.

### Límite de recursos

Un candidato nuevo no se lanza si ya hay **8 Tasks sin terminar** (`MAX_ACTIVE_TASKS`, contando las que esperan aprobación): `race_concurrency_limit`. Es
un tope fijo del Core, no se estima uso ni coste: no hay datos de coste por candidato en el Core.

### Fallo parcial

Un candidato que falla (proveedor desconocido o no disponible, límite, policy, paquete) queda registrado con un **código estable** y **no deshace a los
lanzados**. Los candidatos creados siguen siendo Attempts reales y se pueden comparar. La respuesta de esa llamada es un Race normal con
`summary.failed > 0`; el motivo se persiste como código (sin texto libre).

### Reintento idempotente

Repetir la misma petición **no duplica** a los candidatos ya creados (el ledger del Fork los devuelve `Replayed`) y **reintenta los fallidos**
(`status: Retried`, `replayed: <cuántos ya existían>`). Un fallo que se repite con el mismo código no deja otro hecho.

## `task_race_status`

`{ v, race_id, source_attempt_id, requested, strategy, package_id, created_at, candidates[], summary, compare, cancellable, limits }`.

* `candidates[i]`: `index`, `outcome` ∈ `launched` · `failed` · `not_attempted`, `provider`, `model`, `task_id`, `attempt_id`, `status` (el del Attempt **ahora**),
  `code` (del fallo). **También salen los fallidos**: nada se oculta. `not_attempted` es un candidato del que no hay hecho (el Race se interrumpió).
* `compare.attempt_ids`: los Attempts lanzados (2–4) para pasarlos tal cual a `attempt_compare` (relación `fork_family`, raíz el origen); `null` si hay menos de 2.
* `cancellable`: los lanzados que aún no han terminado.
* **No hay ganador, puntuación ni «mejor»**: «ganador» es una decisión posterior de la persona (Compare, Proof Pack, revisión). El Core no lo marca.

## Cancelar

`task_race_cancel` es **siempre explícito**: nada se cancela porque otro candidato termine. Por candidato: `pending_approval` → se rechaza; en marcha → se
detiene (si su proceso no muere, **no** se declara detenido y el resultado lo dice); ya terminado → `already_final` (no se toca). Lo ya escrito se conserva
en su worktree. Deja `race.cancelled`. Repetirlo no rompe nada.

## Policy

`task_race` se gobierna como la categoría `fork` y `task_race_cancel` como `stop` ([POLICY.md](POLICY.md)): con `deny` no se lanza nada; con `confirm` hace falta
`confirm: true`. La policy se **vuelve a comprobar antes de cada lanzamiento**, no solo al empezar.

## Hechos

| kind | class | contenido |
|---|---|---|
| `race.requested` | decision | `race_id`, `source`, `source_task`, `candidates`, `strategy`, `package_id?`, `digest` |
| `race.candidate_recorded` | state | `race_id`, `index`, `outcome` ∈ `launched` `failed`, `provider`, `model?`, `task_id?`, `attempt_id?`, `code?` |
| `race.cancelled` | decision | `race_id`, `scope` ∈ `one` `remaining`, `attempt_id?`, `stopped`, `rejected`, `failed` |

Y cada `attempt.forked` de un candidato lleva `race_id` y `race_index`. Nada de esto lleva el encargo, el contenido del paquete ni credenciales.
Los tres salen en Activity (`activity.race.*`).

## Lo que NO hay (honesto)

* **Host y estrategia de worktree por candidato**: no existen; cada candidato recibe su worktree.
* **Estimación de coste/uso por candidato**: el Core no la tiene; el límite es solo de Tasks activas.
* **Un Race necesita un Attempt origen** (de él salen el perfil y el contexto): no hay Race desde una Task sin ningún Attempt.
* **Mientras un Race corre no hay política de equilibrio**: no se reparte cuota entre candidatos ni se limita por proveedor.
* El límite de 8 es fijo, no configurable.
