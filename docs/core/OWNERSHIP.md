# Quién posee un archivo: `work_at` (LXO-169, épica F6)

Una consulta de **solo lectura** para que el IDE (y la CLI o Mobile después) pregunte al Core qué Task/Attempt posee un archivo o un worktree y cuáles lo tocaron, **sin inferirlo** por la rama o por la ruta abierta. La usará el banner «AI WORK» del IDE (LXO-174), el sidecar (LXO-212) y la Review inline (LXO-213).

Implementación: `orch/ownership_read.rs`. Pruebas: `orch/ownership_read_tests.rs`.

## Petición

```json
{ "project_id": "p-1", "path": "src/lib.rs", "worktree_id": "wt-t2-a1", "revision": "0123abc" }
```

| Campo | Regla |
|---|---|
| `project_id` | Obligatorio. Debe existir. |
| `path` | Obligatorio. Ruta **relativa** al worktree. Mismas reglas que `file` en [DEEP_LINKS.md](DEEP_LINKS.md): sin `/` inicial, unidad de disco, `\`, controles, segmentos vacíos, `.` ni `..`, y sin doble codificación. Puede ser un archivo o una carpeta. |
| `worktree_id` | Opcional. El worktree del que se pregunta; debe ser de ese Project. Sin él se pregunta por el Project entero y **no hay dueño** (ver abajo). |
| `revision` | Opcional. El hash que el editor tiene abierto (7 a 64 hex). Se compara con el HEAD vigente del worktree. |

Solo una Person autenticada, y la autorización va **antes** que la validación y que la búsqueda. Antes del corte Task/Attempt, `core_model_inactive`.

La ruta es un **nombre**, no un patrón: viaja a `git diff` como pathspec literal. `*`, `src.*` o `:(top)x` no devuelven «todo».

## Respuesta

```json
{ "v": 1, "project_id": "p-1", "path": "src/lib.rs",
  "workspace": { "worktree_id": "wt-t2-a1", "state": "active", "branch": "lx/…", "host": "local" },
  "owner": { "state": "owned", "attempt": { "id": "t2-a1", "task_id": "t2", "n": 1, "status": "running", "provider": "claude", "model": null, "link": "lixbon://project/p-1/task/t2/attempt/t2-a1?view=overview" }, "candidates": [] },
  "touched_by": [ { "attempt_id": "t2-a1", "task_id": "t2", "status": "running", "provider": "claude", "is_current_attempt": true,
                    "evidence": { "source": "live_branch", "base_commit": "…", "head_commit": "…", "provenance": "verified" },
                    "link": "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=src/lib.rs&revision=…" } ],
  "touched_truncated": false,
  "evidence": { "completeness": "complete", "scanned": 1, "skipped": [], "skipped_total": 0, "not_scanned": 0 },
  "revision": { "requested": "0123abc", "current": "…", "state": "current" } }
```

### Dueño actual y historia de toques son cosas distintas

* **`owner`**: el Attempt **vivo** (no final) que usa el worktree nombrado. Es posesión del *workspace*, no del archivo: el dueño lo es aunque todavía no haya tocado la ruta.
  * `owned`: hay uno.
  * `none` con `reason`: `no_workspace` (no se nombró worktree), `worktree_removed`, `no_live_attempt` (todos los Attempts que lo usaron terminaron).
  * `ambiguous`: más de uno vivo, con todos en `candidates` y **sin elegir ninguno**. La regla «en serie» de [WORKTREE_SHARED.md](WORKTREE_SHARED.md) y la base de datos lo impiden hoy; el caso está resuelto y probado por si algún día cambia.
* **`touched_by`**: los Attempts del Project cuya evidencia estructurada cambia la ruta, el más reciente primero (orden determinista, hasta 20, con `touched_truncated`).

### Evidencia (`provenance: verified`)

Es git ejecutado por el Core (`git diff --name-only base head -- <ruta>`) sobre un rango que el Core registró:

| `source` | Cuándo | Rango |
|---|---|---|
| `live_branch` | El Attempt es el **actual** de su Task y su worktree está en esta máquina | base registrada del worktree → HEAD vivo de la rama |
| `review` | Cualquier otro Attempt con una Review | `base_commit` → `head_commit` de su última Review (inmutable) |

Por eso la historia **sobrevive al worktree**: si se quita, la Review conserva el rango y los commits siguen en el repositorio.

**Que no haya evidencia no es «no lo tocó».** Un Attempt sin rango utilizable va a `evidence.skipped` con su motivo y `completeness` pasa a `partial`:

| `reason` | Significa |
|---|---|
| `no_evidence` | No es el Attempt actual y no tiene Review: ya no tiene una rama propia que leer. |
| `no_base` | No se registró el commit base. |
| `branch_unavailable` | La rama ya no existe. |
| `host_unavailable` | Su worktree está en otra máquina: ahí no se puede ejecutar git. |
| `git_unavailable` | Git falló sobre ese rango. |

Se miran como mucho los 60 Attempts más recientes del Project; el resto se cuenta en `not_scanned` (y también hace `partial`).

### Revisión

Con `revision`, `revision.state` dice si el editor está al día con el worktree: `current` (coincide por prefijo con el HEAD vivo), `stale` (el worktree ya está en otro) o `unknown` (sin worktree nombrado, en otra máquina, quitado o sin rama: no se da por buena). No filtra `touched_by`: la historia no depende de qué revisión tenga abierta el editor.

### Enlaces

Cada dueño y cada candidato trae un `link` `lixbon://` canónico (ver [DEEP_LINKS.md](DEEP_LINKS.md)): el dueño abre el Attempt; el candidato abre **su diff de esa ruta en la revisión con la que se miró**. Si el enlace no se puede construir, `link` es `null`.

## Qué NO hace

* No traduce una ruta absoluta del editor a un worktree: el IDE obtiene el `worktree_id` de `resource_inventory`. Una ruta local no es identidad.
* No es blame ni historial por línea; no indexa todo el historial del repositorio.
* No escribe ni cambia la posesión (Take Over y Return son LXO-170).
* No infiere por modelo ni por nombre de rama.

## Pruebas

`ownership_read_tests.rs`: terminado ≠ dueño; dueño vivo sin haber tocado el archivo; varios Attempts sin elegir uno; reintento sin evidencia → `partial`; Review inmutable con el worktree quitado; otra máquina; revisión `current`/`stale`/`unknown`; rutas peligrosas y patrones de git; ids ajenos; autorización antes que la forma; ambigüedad.
