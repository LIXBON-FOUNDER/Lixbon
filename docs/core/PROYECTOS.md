# Registro de proyectos del Core (slice D)

Separa la **identidad lógica** de un proyecto (`Project`) de su **ruta** en esta máquina
(`ProjectLocation`). Es local por máquina y está preparado para Team (`remote_project_id` y
`team_project_id` existen y quedan vacíos). Código: `orch/projects.rs` (política), `store/projects.rs`
(filas) y la migración `003_projects.sql` (dos tablas, nada más). No es el corte Task/Attempt.

## Qué es un proyecto
Un **repositorio git con checkout**. Un worktree enlazado (`<repo>.lixbon-wt/…`) pertenece al mismo
proyecto que su repositorio: la ubicación que se guarda es la del checkout *principal*
(`git worktree list`, primera entrada).

| Tabla | Contenido |
|---|---|
| `projects` | `id` (UUID v7), `name`, huella (`fingerprint` JSON), `settings` (JSON, sin uso aún), `state` = `active` \| `archived` |
| `project_locations` | `(machine, path)` normalizada, `display_path`, `is_primary`, `state` = `ok` \| `missing`, `last_seen` |

* `project_locations.project_id` es FK real; una ruta pertenece a un solo proyecto; como mucho una
  ubicación principal por proyecto y máquina (índice parcial).
* La huella: commits raíz (`git rev-list --max-parents=0`, máx. 16), remotos normalizados **sin
  credenciales** (`usuario:token@` se elimina antes de guardar) y rama por defecto.
* **Nada se escribe dentro de un repositorio**: solo se ejecuta git de lectura (hay una prueba que
  compara archivo a archivo antes y después).

## Reconocimiento: nunca une en silencio
`project_add {path}`:

1. Misma ruta (o un worktree del mismo repo) → ese proyecto.
2. Otra ruta que coincide por huella → **`needs_confirmation`** con los candidatos; se resuelve con
   `join` (mismo proyecto, ubicación nueva) o `new` (otro proyecto).
3. Sin coincidencias → proyecto nuevo.

Un candidato exige comparten algún commit raíz **y** (remotos en común, o alguno sin remoto):

| Caso | Resultado |
|---|---|
| Mismos commits raíz, remotos distintos y ambos presentes (un **fork**) | proyectos distintos, sin preguntar |
| Mismos commits raíz y un remoto en común | se pregunta (`mismo_remoto`) |
| Un clon **sin remoto** | siempre se pregunta (`sin_remoto`) |
| Repositorio **movido** (la ubicación vieja ya no existe) | se pregunta (`ubicacion_desaparecida`) |
| Repositorio sin commits | no se reconoce por huella: solo por ruta |

`project_locate {project_id, path}` dice dónde está ahora un proyecto; si el repo de esa ruta no
comparte commits raíz pide `confirm`. Una ruta que ya es de otro proyecto es un conflicto.

## Ciclo de vida
`active` → `archived` (oculto, historial intacto; se restaura con `archived=false`). Una ubicación
cuya carpeta ya no existe pasa a `missing` al listar o al intentar lanzar, y vuelve a `ok` si
reaparece. **No se lanza trabajo nuevo** en un proyecto archivado ni con todas sus ubicaciones
`missing` (`spawn` y `run_create`); sin proyecto o sin registro disponible no se bloquea nada.

## Quién puede qué
Leer (`projects`, `lxo projects`) es para cualquiera. Registrar, archivar, relocalizar e importar
(`project_add`, `project_archive`, `project_locate`, `projects_import_recents`) solo desde la interfaz
(`Caller::User`): lo decide una persona.

## Asignación a tareas (`Task.project_id`, `serde(default)`)
* `run_create` resuelve el proyecto del repositorio sin preguntar: misma ruta → ese; sin
  coincidencias → nuevo; **ambiguo → la tarea queda sin proyecto** (no se une en silencio).
* La hija hereda el proyecto de su padre.
* **Relleno perezoso** (`backfill_projects`): tras arrancar, en un hilo y con presupuesto de 4 s,
  agrupa por repositorio las tareas sin proyecto. Idempotente; `meta.projects_backfilled` solo se
  anota si la pasada terminó. Los repos ambiguos o inexistentes se dejan sin proyecto (`lxo projects`
  los cuenta como «sin proyecto»). Pasa por `mutate`: es una mutación normal del estado.
* **Importación de recientes** (`projects_import_recents`): una sola vez
  (`meta.projects_recents_imported`); lo ambiguo se omite y se informa.

## Orden de bloqueos
Estado → almacén (como `mutate`); el registro calcula lo que necesita del estado **antes** de entrar
al almacén, y ningún subproceso git corre con el almacén tomado.

## Medidas
`git rev-list --max-parents=0 HEAD` en el repositorio de Lixbon (507 commits en `HEAD`, 790 en
total): 86–227 ms por llamada en Windows, incluido el lanzamiento del proceso. Identificar un
repositorio lanza cuatro llamadas a git de lectura (≈0,4–0,9 s en total); por eso el relleno tiene
presupuesto y se hace fuera del camino crítico del arranque.

## Fuera de este slice
Eventos (E), clientes (F1), Attention (G), el corte Task/Attempt, raíz de worktrees administrada
(`projects.settings` la usará el slice I), y toda interfaz de proyectos más allá de la importación de
recientes.
