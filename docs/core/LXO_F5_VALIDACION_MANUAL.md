# Validación manual de la CLI F5 contra Desktop

Receta y resultado de la validación manual de `lxo` (LXO-158, LXO-159, LXO-160, LXO-161, LXO-162, LXO-163 y LXO-217)
contra un Desktop real, con Codex real, hecha el 2026-11-16. Las pruebas automáticas usan un Core o un proveedor
simulados; esto cubre el tramo Desktop → Core → proveedor.

## Montaje

1. **Corte activo.** `lxo task create` es idempotente solo sobre el Core cortado. Arranca Desktop con
   `LIXBON_AGENTIC_CUT=1`; sin él falla con «persistencia sin soporte idempotente» (el corte por defecto es LXO-235).
2. **Perfil aislado.** `USERPROFILE` apunta a una carpeta de pruebas, de modo que el Core vive en
   `<USERPROFILE>\.lixbon` y no toca el perfil real. Con ese cambio hacen falta además `CARGO_HOME` y `RUSTUP_HOME`
   explícitos para compilar.
3. **Proveedor.** Con otro `USERPROFILE` Codex no tiene sesión y se queda en `awaiting_terminal_approval`
   (hasta LXO-252 la terminal no era accesible desde Orquestar; ahora está en la pestaña Terminal del detalle del run). Apunta `CODEX_HOME` a la carpeta real de Codex. Ojo: Codex resuelve su home con la API del sistema, no con `USERPROFILE`; un perfil aislado no basta para dejarlo sin sesión, y un `CODEX_HOME` vacío cancela el Attempt en vez de dejarlo esperando.
4. **Project.** No hay botón para registrarlo. Desde la consola del webview (F12):
   `await window.__TAURI_INTERNALS__.invoke('orch_project_add', { path: '<repo>', name: '<nombre>' })`.
5. **Repo desechable sin remoto.** Para `integrate merge`, con `user.name` y `user.email` fijados en el repo (si no,
   el merge falla y el resultado es `outcome: error` sin motivo).
6. **Aprobaciones.** Orquestar → Core → pestaña Attention → Aprobar o Rechazar. La lista se recoloca al resolver
   una fila: comprueba el Attempt antes de cada clic.

```powershell
$env:USERPROFILE = '<carpeta-de-pruebas>'
$env:LIXBON_AGENTIC_CUT = '1'
$env:CODEX_HOME = '<carpeta real de .codex>'
$lxo = '<apps\desktop\src-tauri\binaries\lxo-x86_64-pc-windows-msvc.exe>'   # con USERPROFILE ya cambiado
```

## Qué se comprobó y cómo

| Comando | Comprobación | Resultado |
|---|---|---|
| `task create` | misma `--request-id` dos veces | `Committed` y `Replayed`, sin Attempt |
| `attempt start` | sin aprobar; aprobado en Desktop | `pending_approval` sin proceso ni worktree; al aprobar, worktree propio y `running` |
| `attempt retry` / `resume` | último Attempt; Attempt anterior | nuevo Attempt `pending_approval`; el anterior da código 12 |
| `attempt queue` | `--confirm`, repetir, listar, cancelar | `Queued`, `Replayed`, `Cancelled` y `AlreadyCancelled`; se entrega al acabar el turno |
| `attempt steer` | Attempt en `running`; Attempt que espera una respuesta | `Delivered`; código 10 (`not_running`) |
| `attempt stop` y `stop --send` | `--confirm`, repetir | `Stopped` y `Delivered`; repetir da `Replayed`; sin procesos vivos |
| sin `--confirm` | queue, steer, stop, stop & send | código 2 (`usage`) |
| `attempt fork` | dry-run, real, repetir | sin efectos; Task y Attempt nuevos con procedencia; `Replayed` |
| `race` | dry-run, real, `status`, `cancel --attempt` | 2 candidatos en worktrees propios; cancel solo con `--confirm` |
| `compare` | 1 Attempt; 2 Attempts; `--race` | código 2; comparación con provenance; comparación del Race |
| `review` | consulta y `--accept` | Proof Pack con HEAD exacto; decisión registrada |
| `integrate merge` | antes de aceptar, dry-run, `--confirm`, repetir | `review_required`; `can_merge.ok`; `merged`; `already_merged` |

## Qué no se probó

`integrate pr` (no hay remoto), `review --reject` y el HEAD movido (código 7), `race --follow`, Race con
proveedores distintos, Steer sobre Claude (declara `steer: unsupported`) y el corte sobre un perfil con datos previos.
El commit de la rama que se revisó e integró lo hizo la persona que probaba, no el agente.

## Limpieza

Cierra Desktop, borra la carpeta de pruebas, el repo desechable y sus worktrees (`<repo>.lixbon-wt`), y no
reutilices el `CODEX_HOME` compartido en otro perfil.
