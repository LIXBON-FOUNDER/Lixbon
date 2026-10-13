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
* La huella: commits raíz (`git rev-list --max-parents=0`, máx. 16), remotos normalizados y rama por
  defecto. **Ningún secreto del remoto se persiste en `fingerprint`**: en una URL de red se descarta
  todo hasta la última `@` (usuario y clave, aunque la clave lleve `/`, `?` o `#`), la consulta
  (`?access_token=…`) y el fragmento (`#…`); en una ruta local, donde esos caracteres son parte del
  nombre, no se toca. Hay pruebas hasta el archivo de la base.
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
`missing` (`spawn` y `run_create`).

Qué NO bloquea (compatibilidad): una tarea **sin** `project_id` (el registro no es requisito para lo
que nunca lo tuvo) y el almacén **realmente cerrado/degradado** (el registro es aditivo y no rompe los
flujos legacy). Qué SÍ bloquea, aunque no sea archivado ni `missing`: con un `project_id` conocido y el
almacén abierto, **un error al consultar el proyecto** o un `project_id` que ya **no existe** en el
registro. Un error de lectura nunca se convierte en «se puede lanzar»: las protecciones de archivado y
de ubicación desaparecida no deben poder saltarse justo cuando el registro está en problemas.

**La launchability se revalida tras la aprobación humana.** `plan → aprobación humana → revalidación →
efectos`. `plan_spawn` comprueba pronto (falla rápido), pero entre el pendiente y el «sí» de la persona
pueden pasar minutos: el proyecto puede archivarse, su carpeta desaparecer o relocalizarse. Por eso
`create_child` repite la comprobación AL PRINCIPIO, antes de crear la Task hija, el worktree o ningún
proceso: si falla, el lanzamiento queda `launch_failed` y no hay nada que limpiar. La aprobación no
congela una decisión antigua.

**`project_for_repo` no se traga errores.** Tres resultados que no se mezclan:

| Situación | Resultado |
|---|---|
| Identidad ambigua (se parece a un proyecto de otra ruta), o git no puede identificar el repo | `Ok(None)`: la tarea nace sin proyecto |
| Registro opcional no disponible (almacén cerrado/degradado: arranque legacy) | `Ok(None)`: compatibilidad, D no es requisito de los flujos legacy |
| Error real de un registro activo (almacén abierto y la consulta falla) | `Err`: `run_create` no crea ni el run ni la tarea |

## Quién registra y quién decide
**La garantía central: Lixbon nunca une dos identidades ambiguas en silencio.**

| Automático (sin preguntar) | De la persona (`Caller::User`) |
|---|---|
| Un repositorio **inequívocamente nuevo** (ninguna coincidencia de huella) durante `run_create` | `join`: «es el mismo proyecto» |
| El relleno de tareas existentes (`backfill_projects`), solo para repos inequívocos | Resolver una ambigüedad (`join` / `new`) |
| Reconocer la **misma ruta** (o un worktree del mismo repo) | `project_locate` (y su `confirm` forzado) |
| La hija hereda el proyecto de su padre | Archivar y restaurar |
| | La importación explícita desde la interfaz (`projects_import_recents`) |

Leer (`projects`, `lxo projects`) es para cualquiera. Los comandos de la columna derecha
(`project_add`, `project_archive`, `project_locate`, `projects_import_recents`) los rechaza el Core a
quien no sea la interfaz. Un repositorio ambiguo durante `run_create` o el relleno NO se registra ni se
une: la tarea queda sin proyecto hasta que la persona decida.

## Asignación a tareas (`Task.project_id`, `serde(default)`)
* `run_create` resuelve el proyecto del repositorio sin preguntar: misma ruta → ese; sin
  coincidencias → nuevo; **ambiguo → la tarea queda sin proyecto** (no se une en silencio).
* La hija hereda el proyecto de su padre.
* **Relleno perezoso** (`backfill_projects`): tras arrancar, en un hilo y con presupuesto de 4 s,
  agrupa por repositorio las tareas sin proyecto. **Procesa siempre las tareas que sigan sin
  proyecto**: es idempotente, no se salta pasadas. `meta.projects_backfilled` es solo una **marca
  diagnóstica** («hubo una pasada completa»); el relleno no la consulta, porque un salto global dejaría
  fuera las tareas ambiguas y los repositorios que reaparezcan después. Los repos ambiguos o
  inexistentes se dejan sin proyecto (`lxo projects` los cuenta como «sin proyecto»). Pasa por
  `mutate`: es una mutación normal del estado.
* **Importación de recientes** (`projects_import_recents`): el **Core es la única autoridad**. La
  interfaz envía `lixbon_recents` en cada arranque y el Core decide con
  `meta.projects_recents_imported` (en SQLite): con la marca responde `already_done` sin tocar nada; una
  base nueva o restaurada, sin la marca, vuelve a importar. `localStorage` solo conserva
  `lixbon_recents` (las rutas históricas), no una segunda decisión de migración. Lo ambiguo se omite y
  se informa.

## Bloqueos y E/S
* Orden de bloqueo: estado → almacén (como `mutate`); el registro calcula lo que necesita del estado
  **antes** de entrar al almacén.
* **Ninguna E/S externa corre con el mutex del almacén tomado** (ni `git`, ni `Path::exists`, ni
  nada del sistema de archivos, ni procesos): el almacén es uno para todo el Core y también lo usa la
  persistencia del estado, así que una ruta de red lenta bloquearía el guardado. Toda comprobación de
  disco sigue el ciclo **leer (SQL) → comprobar fuera → persistir solo las transiciones `ok ↔ missing`**
  (`projects_list`, la guarda de lanzamiento). La prueba
  `el_registro_no_hace_io_externo_bajo_el_bloqueo_del_almacen` escanea `orch/projects.rs` y falla si
  algún closure de `registry` / `with_store` toca el disco, git, un proceso, duerme o toma otro bloqueo.

## Medidas
`git rev-list --max-parents=0 HEAD` en el repositorio de Lixbon (507 commits en `HEAD`, 790 en
total): 86–227 ms por llamada en Windows, incluido el lanzamiento del proceso. Identificar un
repositorio lanza cuatro llamadas a git de lectura (≈0,4–0,9 s en total); por eso el relleno tiene
presupuesto y se hace fuera del camino crítico del arranque.

## Fuera de este slice
Eventos (E), clientes (F1), Attention (G), el corte Task/Attempt, raíz de worktrees administrada
(`projects.settings` la usará el slice I), y toda interfaz de proyectos más allá de la importación de
recientes.

## Optimizaciones futuras (no bloquean D)
* **`backfill_projects` en modo degradado.** Hoy, con el almacén cerrado y tareas pendientes, identifica
  cada repositorio con git y solo falla al intentar resolverlo (deja un aviso en el log en cada
  arranque). Debería salir ANTES de ejecutar git si el registro no está disponible. Es trabajo inútil,
  no un fallo de corrección: no cambia ningún dato.
