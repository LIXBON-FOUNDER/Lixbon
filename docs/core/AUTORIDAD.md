# Autoridad del estado del Core: de `state.json` a SQLite (C2b)

Este documento describe **cómo una instalación pasa a tener SQLite como única fuente
de verdad del estado**, qué archivos intervienen, qué pasa si algo falla y qué
limitaciones se conocen. El diseño completo y la matriz de caídas están en
`LIXBON-C2-diseno.md` §11; el código, en `apps/desktop/src-tauri/src/orch/`
(`authority.rs`, `boot_authority.rs`, `mirror.rs`, `mutation.rs`, `store_boot.rs`) y
`src/store/authority.rs`.

## Regla

```
bootstrap_snapshot   → puede recuperarse con la política de bootstrap (degradar a state.json)
sqlite_authoritative → un fallo de SQLite BLOQUEA el arranque; no hay fallback a state.json
```

## Archivos (carpeta `~/.lixbon/core/` y `~/.lixbon/orch/`)

| Archivo | Qué es | Papel |
|---|---|---|
| `core/lixbon.db` | SQLite | **Fuente de verdad** una vez promovida. La fila `legacy_state` es el estado. |
| `core/authority.json` | Marcador externo | Registra **solo el estado del protocolo** (`promoting` / `authoritative`). No contiene estado de dominio ni se actualiza por mutación. Existe para el caso en que la base no se pueda consultar. |
| `orch/state.json` | Espejo | Tras la promoción es un **espejo operativo, de diagnóstico y pieza de recuperación**. No es una garantía de compatibilidad descendente. Nunca se importa de vuelta. Su `_mirror` no se cree: el contenido se comprueba (ver «El espejo»). |
| `core/backups/*pre-authority*` | Copias | La base y `state.json` justo antes de promover (verificadas). Sin política de retención todavía. |
| `orch/state.json.{invalido,cambiado,divergente}-<ms>` | Copias diagnósticas | Se conservan antes de bloquear o de sustituir algo ajeno. |

`authority.json` (esquema `v: 1`): `state`, `promotion_id`, `db`, `db_id`,
`source_hash`, `source_bytes`, `sqlite_bootstrap_rev`, `sqlite_target_rev`,
`created_at`, `writer` y, al confirmarse, `confirmed_at`.
Los `sqlite_*_rev` numeran **publicaciones de la fila de SQLite**; no son el
historial de mutaciones de `state.json`, que no tiene `rev`. La identidad del legado
son sus bytes exactos (`source_hash`, `source_bytes`).

## La promoción

```
LEGACY ─ validar el legado y la base · identidad · copia verificada `pre-authority`
FENCED ─ migración 002: C1 y C2a ya no pueden abrir la instalación
         publicar authority.json = promoting {promotion_id, db_id, source_*, sqlite_*_rev}
PROMOTING ─ COMMIT (una transacción: fila, modo y metadata de autoridad)
COMMITTED ─ publicar authority.json = authoritative
AUTHORITATIVE
```

* La valla (migración **002**) va **después** del preflight y de la copia —si el legado
  no es promocionable, la instalación sigue siendo LEGACY— y **antes** de `promoting`
  —no hay ventana en la que C1/C2a puedan arrancar e ignorar el marcador—.
* **FENCED** es recuperable: `user_version = 2`, sin marcador y SQLite todavía de
  bootstrap. C2b repite las validaciones y continúa; **nunca degrada a C1**.
* **La valla es un invariante del almacén**, no solo del orden de `boot_authority.rs`:
  `Store::promote_to_authoritative` rechaza (`NotFenced`, sin cambiar nada) una base que
  no cruzó la 002. `sqlite_authoritative ⇒ valla aplicada`.
* **El orden de slices se conserva también al recuperar.** `Store::open_boot_under_lock`
  valida contra la lista COMPLETA del binario pero solo APLICA hasta un techo: sin cruzar →
  solo lo anterior a la 002; cruzada (FENCED, `promoting` o ya autoritativa) → como máximo la
  002. **Nunca** aplica nada posterior a la valla, ni siquiera con un registro interno de
  autoridad válido: ese registro no basta si `authority.json` lo contradice, y el marcador lo
  observa `orch` después de abrir (ver «Gate de las migraciones posteriores a la valla»).
* **Una sola validación de la identidad de la promoción** (`store::check_promotion_identity`),
  compartida por el marcador, la metadata interna de SQLite y el plan que el Store escribe:
  `promotion_id` no vacío; sin legado => `source_hash = "none"` y `source_bytes = 0`; con legado,
  SHA-256 hexadecimal de 64 caracteres y `source_bytes > 0`; revisiones válidas con
  `target = bootstrap + 1`. El Store no puede escribir una autoridad que luego rechazaría al leerla
  (`PromotionPlan::new` y `promote_to_authoritative` la aplican, y exigen `db_id`).
  Una base solo tiene registro de autoridad válido (`AuthorityFacts::authority_valid`) con
  `db_id` no vacío, modo `sqlite_authoritative`, identidad válida, fila presente y
  `row_rev >= sqlite_target_rev`. Ese registro —no solo el modo— es una condición INTERNA
  necesaria (y la comprueba `Store::migrate_authoritative`) para aplicar migraciones posteriores
  a la 002, pero no es suficiente. Con el modo pero la metadata corrupta, el arranque se queda
  en la 002 y bloquea; no migra primero y descubre después que C2b estaba corrupto. Con el
  marcador ausente y esa metadata inválida, **no** se reconstruye `authority.json`.
* **Revisiones.** `sqlite_target_rev = sqlite_bootstrap_rev + 1` se calcula con
  `checked_add` en todas las fronteras (plan, marcador, metadata de la base y escritura
  autoritativa). Una revisión negativa o `i64::MAX`, o un `target` que no cuadre, no se
  promociona ni se da por buena: bloquea. El marcador también debe ser coherente consigo
  mismo (`source_hash = "none"` ⇒ `source_bytes = 0`; con legado, no vacío; `confirmed_at`
  solo en `authoritative`; `db = lixbon.db`).
* Antes de la valla, un fallo de la copia o de la propia valla degrada a `state.json`
  y se reintenta en el siguiente arranque. Con la valla cruzada, bloquea.

## Gate de las migraciones posteriores a la valla (003 en adelante)

**Invariante:** una migración `> FENCE_VERSION` solo se ejecuta cuando la instalación ya es
inequívocamente apta para seguir como autoritativa: SQLite con registro interno válido **y**
`authority.json` coherente con él (o ausente y reconstruido desde SQLite). Un marcador inválido,
futuro, malformado, `promoting` incompatible o contradictorio con SQLite bloquea el arranque
**antes** de que ninguna migración de D en adelante toque la base.

Orden (único, en `boot_authority.rs`):

```text
1. abrir        techo = valla; el registro interno de SQLite NO basta para migrar
2. decide_boot  marcador + base + legado; cualquier contradicción BLOQUEA aquí
3. marcador     reconstruir (ausente) / confirmar (promoting coherente) / nada
4. 003+         Core::apply_post_fence_migrations -> Store::migrate_authoritative
```

* **Frontera `orch → store`:** el almacén no conoce `Marker`. Recibe la lista completa para
  validar y se queda en la valla; `orch` es quien, tras `decide_boot`, pide
  `migrate_authoritative`. El almacén añade su propia comprobación (valla cruzada +
  `authority_valid`, si no `NotAuthoritative` sin tocar la base). Una prueba de arquitectura
  fija que solo `store_boot.rs` y `boot_authority.rs` pueden llamarla.
* **Marcador antes que migración:** el marcador se deriva solo de la metadata de autoridad, que una
  migración posterior no toca. Una caída entre 3 y 4 deja una instalación coherente que el
  siguiente arranque termina de migrar; una migración que falla deja la base en la 002 con el
  marcador ya correcto, nunca una base migrada sin marcador.
* **Una promoción que termina bien migra en el mismo arranque** (LEGACY/FENCED → AUTHORITATIVE →
  003+): el código de D nunca ve un esquema a medias. La promoción en sí deja la base en la 002.
* **Un fallo de la migración BLOQUEA** (nunca vuelve a `state.json`): la transacción se deshace
  entera, la copia previa `pre-migracion-vN` ya está hecha y el arranque siguiente reintenta.
* **Sin bajada implícita:** una base que ya tiene la 003 se abre con la lista completa; con un
  binario que no la conoce, `DatabaseNewer` (bloqueante) sin modificar nada.
* Pruebas: `orch/migration_gate_tests.rs` (con una 003 ficticia inyectada en el catálogo del
  Core) y `store/authority_tests.rs`.

## El espejo: se comprueba, no se cree

`state.json` lleva `_mirror {rev, doc_sha256, ...}`, pero eso es **metadata declarada
dentro del propio archivo**. `doc_sha256` es el SHA-256 del contenido canónico (sin
`_mirror`, claves ordenadas, sin espacios) y en cada arranque se **recalcula**:

| `state.json` | Resultado |
|---|---|
| íntegro, `_mirror.rev == rev` y el contenido es el de SQLite | vigente; no se toca |
| íntegro y `_mirror.rev < rev` (caída entre COMMIT y espejo) | se regenera, sin copia |
| el contenido no corresponde a su `_mirror` (editado), aunque `rev` sea menor o igual | copia `state.json.divergente-<ms>` y se regenera desde SQLite |
| mismo `rev` pero otro contenido, `rev` mayor, sin `_mirror`, ilegible | copia `state.json.divergente-<ms>` y se regenera |
| ausente o vacío | se regenera |

Un cambio solo de formato o de orden de claves no es una modificación. SQLite gana siempre.

## Qué bloquea el arranque (y qué hacer)

| Situación | Qué significa |
|---|---|
| `state.json` ilegible (vacío, truncado, no UTF-8, sin forma de estado) | No se interpreta como estado vacío. Se conserva `state.json.invalido-<ms>`; nada se modifica. |
| Falta `state.json` pero existe una instantánea de C1 o rastros | La instantánea puede estar desfasada (nadie la actualiza); no se promociona sola. Recupera un `state.json` válido (ver «Recuperación manual»). |
| `state.json` cambió tras publicar `promoting` | Se conserva `state.json.cambiado-<ms>`. No se promociona lo nuevo. |
| Marcador presente y la base no se puede abrir | No se vuelve a usar `state.json`: puede estar obsoleto. |
| Marcador y base se contradicen (base restaurada, `db_id`/promoción distintos, base perdida) | Hace falta restaurar un conjunto coherente de artefactos. |
| Marcador inválido o de una versión del protocolo desconocida | Fail-closed. |

Ningún mensaje sugiere borrar `authority.json`: **borrarlo no es un downgrade**. Si la
base abre como autoritativa, el marcador se reconstruye y SQLite sigue mandando.

## No hay downgrade

* No existe retorno automático de `AUTHORITATIVE`.
* Una restauración `pre-authority` futura deberá ser una operación **offline y
  explícita** que restaure un conjunto coherente (base + marcador + `state.json`) y lo
  valide antes de arrancar. No está implementada.

## Limitaciones conocidas

1. **Binarios anteriores a C1.** *Después de la promoción, ejecutar un binario anterior
   a C1 sobre el mismo directorio de datos no está soportado. Puede leer el espejo como
   autoridad y producir efectos externos basados en estado obsoleto. Las escrituras de
   estado podrán detectarse/descartarse, pero los efectos externos no pueden
   revertirse.* No existe tripwire posible: todos esos binarios cargan `state.json`
   con `unwrap_or_default()` y lo reescriben (un archivo ilegible arrancaría con estado
   vacío), no abren la base y no toman `core.lock`; tampoco hay versión mínima exigible.
   La app instalada y las compilaciones de desarrollo **comparten** `~/.lixbon/orch/`.
2. **C1 y C2a sí quedan protegidos**: la migración 002 sube la versión de la base y
   esos binarios se niegan a arrancar (`DatabaseNewer`, bloqueante, antes de leer
   `state.json`).
3. **Durabilidad.** Se separan cuatro garantías:
   * *Atomicidad ante caída de proceso*: COMMIT de SQLite y `rename`/`MoveFileExW`
     atómicos. Es lo único que prueba el arnés de caídas (`abort()` en cada punto).
   * *Durabilidad ante fallo del SO / pérdida de energía*: mitigación, **no** garantía
     absoluta; ninguna prueba la simula. SQLite usa WAL con `synchronous=FULL`.
   * *Unix*: `fsync` del archivo, `rename` y `fsync` de la carpeta. En macOS,
     `File::sync_all` usa `F_FULLFSYNC`; el COMMIT de SQLite no (salvo
     `PRAGMA fullfsync`). Sin verificar en Linux/macOS.
   * *Windows*: `FlushFileBuffers` y `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`,
     encapsulado en `orch/fsio.rs`. Depende de que el sistema de archivos y el disco
     honren el vaciado.
4. El espejo es síncrono bajo el lock del estado (dos escrituras por mutación) hasta
   que una medición demuestre que es un problema.

## Recuperación manual provisional (NO forma parte del protocolo)

`recover-from-snapshot` es un slice aparte. Solo para desarrollo o emergencia, una
persona puede extraer la instantánea (que puede estar desfasada):

```
sqlite3 lixbon.db "SELECT doc FROM legacy_state WHERE id = 1" > state.json
```

y colocarla como `orch/state.json`; en el siguiente arranque entra como cualquier
legado legible. No tiene interfaz, no está soportado y no ofrece garantías.

## Pruebas

* `authority_tests.rs`: marcador, clasificación del legado, `decide_boot` y una
  **prueba de propiedad** sobre más de 100 000 combinaciones (marcador × base × legado ×
  rastros × indicios × `sqlite_bootstrap_rev`) que impide añadir un camino que devuelva
  la autoridad a `state.json`.
* `boot_tests.rs`: promoción, bloqueos, espejo y fallos de SQLite.
* `crash_tests.rs`: arnés de caídas con subprocesos (promoción, valla, mutaciones,
  `state.json` alrededor de la intención).
* `mutation_tests.rs`: la frontera de mutación y la prueba de arquitectura que mantiene
  el almacén, la promoción y Win32 detrás de su frontera.
* `store/authority_tests.rs`: la valla como invariante del almacén (promover sin valla →
  error y cero cambios), `migrate_authoritative` (solo con la base autoritativa; la apertura
  nunca pasa de la valla) y las revisiones en el límite.
* `migration_gate_tests.rs`: el gate de la 003 (ver arriba), con mutaciones comprobadas.
* **CI** (`.github/workflows/desktop-ci.yml`): en cada PR a `master` que toque
  `apps/desktop/**` corre, en **Windows y Ubuntu**, `cargo test --lib` del Core, las
  pruebas de `lxo`, vitest y el build del frontend. Windows ejercita la rama
  `MoveFileExW` de `publish_durable`; Ubuntu, la de `rename` + `fsync` de carpeta.
