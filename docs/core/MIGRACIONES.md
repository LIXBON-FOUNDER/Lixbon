# Migraciones del almacén del Core

Las migraciones viven en `apps/desktop/src-tauri/src/store/migrations/NNN_nombre.sql`, las embebe
`build.rs` y las aplica `store::migrate`. Solo avanzan; una por slice; se fusionan en orden numérico
(el marco rechaza una migración pendiente anterior a una ya aplicada).

## Numeración vigente

| N.º | Nombre | Slice | Estado |
|---|---|---|---|
| 001 | `core` | B (SQLite + marco) | publicada |
| 002 | `authority_fence` | C2b (valla de autoridad) | publicada |
| 003 | `projects` | D (registro de proyectos) | en revisión (PR de D) |
| 004 | `events` | E (Event Log; E1a) | en revisión (PR de E1a). Ver `EVENTOS.md` |
| 005 | `clients` | F1 (LXO-85) | publicada. Ver `CLIENT_IDENTITY.md` |
| 006 | `attention` | G (LXO-87) | en revisión (PR de LXO-87). Ver `ATTENTION.md` |
| 007 | `task_attempt` | F3 · corte Task/Attempt | **reserva orientativa**, sin escribir. Diseño y borrador en `CORTE_TASK_ATTEMPT.md` (LXO-112) |

La numeración inicial (002 proyectos · 003 eventos · 004 clientes · 005 attention) quedó obsoleta
cuando C2b ocupó la 002 con la valla: D, E, F1 y G pasaron a 003..006. Los números aún no escritos son una **reserva
orientativa**: cada slice toma el siguiente número libre al fusionarse. La tabla se verifica contra
`src/store/migrations/` antes de elegir número (la 005 figuró como «reservada» mucho después de existir).

## Los comentarios de una migración publicada NO se tocan

El checksum de una migración es el **SHA-256 de todo su texto sin `\r`, comentarios incluidos**
(`Migration::checksum`). El almacén guarda ese valor al aplicarla y se niega a abrir una base cuya
migración cambió (`ChecksumMismatch`). Corregir un comentario de una migración ya publicada
invalidaría las instalaciones existentes, así que no se hace: la corrección va en documentación
externa (este archivo).

Verificado, no supuesto: la prueba
`un_comentario_cambia_el_checksum_asi_que_una_migracion_publicada_no_se_toca_ni_por_documentacion`
(`store/projects_tests.rs`) comprueba que dos migraciones idénticas salvo un comentario tienen checksum
distinto y que el almacén rechaza la base. La prueba `las_migraciones_publicadas_no_se_editan` fija los
checksums de 001, 002 y 003.

### Comentarios obsoletos que se conservan a propósito

* **`001_core.sql`, líneas 12 y 26** — dicen «002 proyectos (D) · 003 eventos (E) · 004 clientes (F) ·
  005 attention (G)» y «cuando el slice E cree la tabla `events` (migración 003)». Hoy es: 002 =
  `authority_fence`, 003 = `projects`, y eventos será la 004 (o la siguiente libre). Se conservan tal
  cual porque editarlos cambia el checksum de la 001 (`b4bfd527…`), que ya está persistido en las
  bases existentes.
* **`002_authority_fence.sql`, líneas 15–16** — ya explican el desplazamiento («esos slices pasan a
  003..006»); son correctas.

La referencia vigente es esta tabla.

## Reglas

* Una migración ya publicada no se edita (ni código ni comentarios); se crea una nueva.
* Migraciones posteriores a la valla (003 en adelante): solo las aplica `Store::migrate_authoritative`,
  tras `decide_boot` (ver `AUTORIDAD.md`).
* `STRICT` en todas las tablas; marcas de tiempo en milisegundos epoch; identificadores en `TEXT`.
