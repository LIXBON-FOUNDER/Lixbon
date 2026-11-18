# Deep links `lixbon://` (LXO-168, épica F6)

Un enlace nombra una entidad por **identidad durable** (Project, Task, Attempt), nunca por una ruta de esta máquina. Sirve para que CLI, Mobile, el navegador y la propia app abran el mismo sitio en Desktop.

Este documento es el contrato del esquema **versión 1**. Lo implementan `orch/deep_link.rs` (forma: parser, validador y generador, sin acceso al almacén) y `orch/deep_link_read.rs` (resolución contra el Core). Registrar `lixbon://` en el sistema operativo y navegar es de Desktop (LXO-173); este documento no lo cubre.

## Forma

```text
lixbon://project/<project_id>[/task/<task_id>[/attempt/<attempt_id>]]
        [?view=<vista>][&file=<ruta relativa>][&line=<n>][&revision=<sha>][&v=1]
```

| Parte | Regla |
|---|---|
| esquema | `lixbon`, sin distinguir mayúsculas. Nada de usuario, puerto ni fragmento (`#`). |
| `project/<id>` | Obligatorio. Los segmentos van en este orden y sin barras sobrantes. |
| ids | 1 a 200 caracteres de `A-Z a-z 0-9 . _ -`; `.` y `..` no valen. No se admite `%`: un id jamás va codificado. |
| `view` | `overview` · `activity` · `diff` · `review` · `artifact`. `diff`, `review` y `artifact` necesitan un Attempt. |
| `file` | Ruta **relativa** (hasta 1024 caracteres), codificada con `%XX` en UTF-8 y **una sola vez**. Solo con `diff`, `review`, `artifact` o sin `view`. |
| `line` | Entero de 1 a 10 000 000. Necesita `file`. |
| `revision` | Hash hexadecimal de 7 a 64 caracteres (se normaliza a minúsculas). Necesita un Attempt. |
| `v` | Versión del esquema. Ausente = 1. `v=1` se acepta y no se escribe en la forma canónica. |

Todo el enlace mide como mucho 2048 caracteres. Los espacios de los extremos se ignoran (es lo que se arrastra al copiar); cualquier otro espacio o carácter de control lo invalida. **Una clave desconocida o repetida invalida el enlace**: nada se ignora en silencio.

### Rutas peligrosas

`file` se rechaza si, ya decodificado, es absoluto (`/…`, `C:…`), contiene `\`, controles, segmentos vacíos, `.` o `..`, o conserva una secuencia `%XX` (doble codificación: un consumidor que decodificara otra vez vería otra ruta). Cubre `../`, `%2e%2e`, `a%2f..%2fb`, `%252e%252e` y los equivalentes con `%5c`.

Que `file` sea seguro en su forma **no autoriza abrirlo**: la ruta solo se resuelve después de autorizar el Project/Task/Attempt y siempre contra el ProjectLocation o Worktree de ese destino.

### Forma canónica

`parse(generate(x)) == x` y `generate(parse(s))` es la única forma canónica de `s`: segmentos fijos, claves en el orden `view, file, line, revision`, `revision` en minúsculas, `file` con todo lo que no sea `A-Z a-z 0-9 - . _ ~ /` en `%XX` mayúsculas y sin `v`.

## Códigos de error

Estables; llegan como `código: mensaje`. El mensaje nunca repite el texto recibido.

| Código | Cuándo |
|---|---|
| `link_malformed` | No cumple la forma de arriba. |
| `link_version_unsupported` | `v` es mayor que la que entiende este Core. Se distingue de `link_malformed` aunque traiga claves desconocidas. |
| `link_not_found` | El Project, la Task o el Attempt no existen, o la vista pedida no está disponible (sin Review, sin Artifacts, sin Worktree). |
| `link_target_mismatch` | Las entidades existen pero no son coherentes: la Task no es del Project o el Attempt no es de la Task. |
| `link_stale` | La `revision` del enlace ya no es la vigente del Attempt. Es un resultado, no un fallo: ver abajo. |
| `link_unauthorized` | Quien pregunta no es una Person autenticada. Un enlace **no otorga permisos**. |
| `link_host_unavailable` | El Worktree que necesita la vista vive en otra máquina. |

## Consultas

Solo lectura, solo una Person autenticada, y solo después del corte Task/Attempt (antes, `core_model_inactive`).

### `deep_link_resolve { url }`

Valida la forma, comprueba contra el almacén que las entidades existen y son coherentes y dice qué hay que abrir. Nunca abre nada ni otra revisión.

```json
{ "v": 1, "status": "ready", "canonical": "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=src/a.rs&line=3",
  "target": { "project_id": "p-1", "task_id": "t2", "attempt_id": "t2-a1", "view": "diff", "file": "src/a.rs", "line": 3, "revision": null },
  "revision": { "requested": null, "current": null, "state": "not_requested" } }
```

`target.view` es `null` si el enlace no trae `view`: elegir la vista por defecto es del cliente (el ADE abre la entidad; el IDE, el archivo). Que el destino exista y sea coherente no abre nada.

Con una `revision` en el enlace, `revision.state` dice:

* `current`: coincide (por prefijo) con la vigente → `status: "ready"`.
* `stale`: hay otra vigente → `status: "stale"` (código `link_stale`) con `{ requested, current }`.
* `unknown`: el Core no conoce ninguna revisión de ese Attempt, así que no puede confirmarla → también `status: "stale"`.

**El cliente enseña el contexto y ofrece abrir la vigente, no la abre solo.** `current` sale de la rama viva del Attempt si su Worktree está en esta máquina y, si no, de su última revisión registrada.

### `deep_link_generate { project_id, task_id?, attempt_id?, view?, file?, line?, revision? }`

Construye el enlace canónico desde entidades y responde con la misma forma que `deep_link_resolve` (el enlace está en `canonical`). Pasa por la misma resolución: no emite un enlace a algo que no existe, no es coherente o no está disponible. `revision` se acepta en mayúsculas y sale normalizada.

## Qué NO hace

* No registra el manejador del sistema operativo ni navega (LXO-173).
* No resuelve `file` contra el disco ni comprueba que exista: eso es de quien lo abre, ya autorizado.
* No concede permisos ni crea la entidad que nombra (los permisos compartidos son de F9).

## Pruebas

* `orch/deep_link_tests.rs`: ida y vuelta, forma canónica estable, rutas con `../` y codificadas, formas ambiguas y versiones.
* `orch/deep_link_read_tests.rs`: resolución contra el almacén (coherencia, vistas, revisión vigente y obsoleta, host, autorización).
