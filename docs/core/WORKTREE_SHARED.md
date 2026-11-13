# Worktree `shared` entre Attempts (LXO-248) — diseño

Estado: **implementado** (migración 026, almacén, provisión, comandos `attempt_share_worktree` y `attempt_share_candidates`, Resource Manager con
`resource_inspect.shared.by`, y el selector de Desktop con los ocupados deshabilitados). Este documento fija la semántica elegida, lo que el código y el esquema ya imponían y el reparto en incrementos; el detalle
de uso está en [RESOURCES.md](RESOURCES.md) § Worktree compartido.

## Decisión de semántica

**En serie, dentro del mismo Project** (elegida por la persona responsable el 2026-11-13, entre «en serie en el mismo Project», «solo dentro
de la misma Task» y «concurrente con dueño exclusivo de escritura»):

* Un Attempt nuevo puede reutilizar el worktree de otro Attempt del **mismo Project**.
* **Nunca dos Attempts vivos (no finales) sobre el mismo worktree.** No hay escritura concurrente que gobernar.
* El Attempt que **comparte** no es dueño: no crea, no borra, no archiva. Solo el que **creó** el worktree (y solo mediante el Resource
  Manager) puede quitarlo.
* La limpieza se **niega** mientras algún Attempt que use el worktree no sea final.

## Lo que ya existe (no hay que construirlo)

| Pieza | Dónde | Qué impone hoy |
|---|---|---|
| Un reintento **de la misma Task** reutiliza el worktree de la Task | `worktree_provision.rs` (`attach_to_task_worktree`, `reused: true`) | No lo crea y `release_worktree` con `reused` **no borra nada** |
| Un solo Attempt vivo por worktree | `store/worktrees.rs` (`in_use`, usado por `worktree_attach_recorded`) | adjuntar un segundo Attempt vivo es `WorktreeConflict` |
| Quitar un worktree exige que ningún Attempt activo lo use | `worktree_transition_recorded` (`Remove`) | la limpieza ya no puede borrar uno en uso |
| Solo se borra lo creado; rama con `branch -d` nunca `-D` | `worktree_provision.rs`, `git.rs` | ver «Verificación» |

## Lo que lo impide hoy: el esquema

Un worktree pertenece a **una** Task, y la base de datos lo hace cumplir:

* `worktrees.task_id NOT NULL` y `worktrees.attempt_id UNIQUE` con `id = 'wt-' || attempt_id` (migración 010): un worktree lo registra UN
  Attempt y lo posee UNA Task.
* Trigger `attempts_worktree_exists` (migración 010): `attempts.worktree_id` solo puede apuntar a un worktree **activo de SU Task**
  (`w.task_id = NEW.task_id`).
* `worktree_attach_recorded` rechaza adjuntar un Attempt cuya Task no es la del worktree.

Compartir entre Tasks distintas exige **una migración nueva** (la siguiente libre es la 026; comprobar el directorio antes de elegir, ver
`MIGRACIONES.md`), no solo lógica de Rust.

## Incrementos propuestos (un PR cada uno, ninguno depende del siguiente para ser seguro)

1. **Migración**: relajar `attempts_worktree_exists` de «misma Task» a «mismo Project», conservando «worktree activo». Sin datos nuevos:
   lo existente sigue cumpliendo la regla más estricta. Pruebas del esquema (incluida la antigua: otra Task de otro Project sigue rechazada).
2. **Almacén**: `worktree_attach_recorded` acepta un Attempt de otra Task **del mismo Project**; mantiene `in_use`. Evento
   `worktree.attached` con el origen (qué Task lo posee) para que Activity y Resource Manager lo vean.
3. **Provisión `shared`**: un Attempt de una Task nueva se adjunta sin crear (`reused: true`). `release_worktree` sigue sin borrar nada. El
   `cwd`/rama/base de la Task nueva salen del worktree compartido.
4. **Resource Manager**: `resource_inspect` lista **todos** los Attempts que usan el worktree y quién es el dueño; `resource_clean` y
   `resource_delete_worktree` se niegan con un motivo claro mientras otro Attempt no final lo use (ya lo impide el almacén: aquí es el
   mensaje y la prueba E2E), y limpiar desde la Task que **comparte** no borra el worktree del dueño.
5. **Mando**: **un comando aparte, `attempt_share_worktree`**, en vez de ampliar `task_create` (cuyo contrato dice que host y worktree no son input del
   RPC y que es idempotente en una sola transacción). La persona crea el Attempt (nace pendiente), comparte y entonces aprueba: así el enlace es una
   transacción del almacén con todas sus comprobaciones, y el worktree queda reservado desde que se enlaza. El selector de la interfaz usa
   `attempt_share_candidates` (lectura) para listar los worktrees activos del mismo Project y deshabilitar los ocupados.
7. **Revisar e integrar**: quien comparte no se revisa ni se integra desde sí mismo (`share_not_reviewable`); se hace desde el Attempt dueño, que incluye lo
   que se hizo en esa carpeta. Es la consecuencia de que quien comparte no sea dueño: si su Task tuviera rama propia, su limpieza borraría la del dueño.
6. **Mutation testing** del invariante «solo se borra lo creado» sobre el camino `shared` (cada mutación debe romper una prueba).

## Riesgos que hay que probar, no suponer

* Un Attempt que comparte termina o falla: su `release` no debe quitar el worktree del dueño (`reused`).
* El dueño pide limpiar mientras un Attempt que comparte sigue vivo: se niega, sin borrar nada.
* El Attempt que comparte queda `exited` por un reinicio del Core: el worktree sigue activo y el siguiente puede adjuntarse.
* Rama: varios Attempts sobre la misma rama. `branch -d` solo borra lo integrado; no hay que inventar ramas por Attempt.
* Dos peticiones simultáneas de adjuntar al mismo worktree: la segunda es `WorktreeConflict` (la base de datos, no un candado en Rust).

## Race (decisión)

Un Race no ofrece worktree compartido, y **no es una carencia sino la consecuencia de la regla en serie**: sus candidatos corren a la vez, y la
base de datos no deja que dos Attempts vivos usen un mismo worktree. Cada candidato recibe el suyo. Lo que sí se puede hacer a mano es compartir
el worktree del origen con **un** candidato pendiente (`attempt_share_worktree`): lo ocupa desde que se enlaza; un segundo candidato recibe
`share_conflict` mientras el primero no termine. Lo fija `race_e2e_tests::en_un_race_solo_un_candidato_puede_compartir_el_worktree_del_origen`.

## Fuera de alcance (igual que en la issue)

Asignación de puertos y servicios entre Attempts paralelos (LXO-222). Con la semántica «en serie» no hay Attempts paralelos sobre un mismo
worktree, así que no se plantea aquí.

## Verificación hecha (sin código de producción)

Mutation testing manual del invariante «solo se borra lo creado» (Windows):

| Mutación | Resultado |
|---|---|
| `release_worktree` borra un worktree `reused` (no creado por la llamada) | matada |
| `git::delete_branch` usa `-D` en vez de `-d` | matada (3 pruebas) |
| la rama deja de constar aunque `branch -d` no la borrara | matada |
| si el **registro** del worktree falla, no se deshace lo creado en disco | **sobrevivía**; añadida `si_el_registro_falla_se_deshace_lo_que_esta_llamada_creo` (persistencia que falla) y ahora muere |
