# ADR · Runtime persistente, daemon y ownership de procesos (LXO-181)

Estado: **decidida: alternativa B (daemon propio)**, aceptada por Esteban Presiga el 2026-11-23. Pendiente la revisión de
Gabriel Durango por el impacto en la estructura de Desktop. Esta ADR no implementa nada: compara alternativas y fija las
rebanadas siguientes de F7 (LXO-182..185). Lo marcado como *por medir* no está comprobado, y la rebanada 1 del §9 es la
que confirma o descarta B (§10).

## 1. Contexto: cómo es hoy

El Core vive **dentro del proceso de Desktop** (Tauri). Lo que hay en `master`:

| Pieza | Hoy | Dónde |
|---|---|---|
| Escritor único de la base | Un solo proceso con `core.lock` (`flock` en Unix, bloqueo equivalente en Windows) y SQLite en WAL, `busy_timeout=5000` | `store/lock.rs`, `store/mod.rs` |
| Cliente local (`lxo`) | HTTP en `127.0.0.1`, puerto aleatorio, credencial registrada; el puerto se publica en `~/.lixbon/orch.json` y el secreto nunca | `orch/server.rs` |
| Acoplamiento a Tauri | El Core usa `Arc<dyn Host>`; el `AppHandle` solo vive en `TauriHost`, `commands.rs` y `spawn_approval.rs` | `orch/host.rs`, `orch/tauri_host.rs` |
| Procesos de adapters | Un proceso por Attempt, en su propia sesión (Unix, `setsid`) o en un Job Object con `KILL_ON_JOB_CLOSE` (Windows) | `proctable.rs`, `adapter/process.rs` |
| Custodia de cierres sin probar | Registro **global del proceso** (`static Mutex`), reintentado por `reap()` en el apagado y por un barrido periódico | `adapter/supervisor.rs` |
| Providers | Claude: `stream-json` y `--resume`. Codex: `codex app-server` por stdio, con caída a `exec --json` | `adapter/claude`, `adapter/codex` |
| Identidad de máquina | `meta.machine_id`; cada Worktree guarda su máquina | `store/runtime.rs`, migración 013 |
| Acceso remoto | Relay Python del gateway: el host publica eventos y consume comandos, los controllers (móvil/web) al revés. Solo reenvía; una réplica; gracia de 45 s si el host reconecta | `core/gateway/remote_hub.py` |
| Instancia única | `tauri-plugin-single-instance` | `lib.rs` |

**Consecuencia que incumple un invariante de F7:** en Windows, cerrar Desktop suelta el último handle del Job y termina
el árbol del Attempt (`KILL_ON_JOB_CLOSE`); en Unix los procesos sobreviven al cierre pero el Core que los conocía ya no
existe, así que nadie los posee. Ni lo uno ni lo otro cumple «cerrar Desktop no mata trabajo declarado persistente» y
«ningún proceso queda sin owner recuperable».

## 2. Preguntas que cierra esta ADR

1. ¿Quién posee procesos, PTY y Attempts cuando Desktop se cierra?
2. ¿Nombre y protocolo del runtime?
3. Ciclo de vida: arrancar, parar, actualizar.
4. Escritor único de SQLite y bloqueo de instancia.
5. Compatibilidad de versiones cliente↔runtime.
6. Qué queda local al host y qué puede viajar por el gateway.
7. Cómo se recuperan los Attempts tras un reinicio.
8. Cómo conviven los adapters con procesos que ya tienen daemon propio (`codex app-server`).

## 3. Alternativas

### A. Core embebido + supervisor reforzado (Desktop sigue siendo el dueño)

Mantener el Core en Desktop y endurecer lo existente: custodia persistida, Jobs sin `KILL_ON_JOB_CLOSE`, minimizar a la
bandeja en vez de cerrar.

* **A favor:** cambio mínimo; sin proceso nuevo ni empaquetado nuevo.
* **En contra:** el dueño muere con la ventana (o hay que impedir cerrarla); sigue sin haber un lugar donde el Core
  espere a un cliente remoto con Desktop cerrado; Mobile y CLI siguen dependiendo de una ventana abierta.
* **Veredicto:** no cumple la invariante 2 sin trucos. Se descarta como destino, pero **parte de su trabajo (custodia
  persistida) se reutiliza** en B.

### B. Daemon propio (`lixbond`, nombre provisional) que contiene el Core

El Core se extrae a un binario sin interfaz. Desktop, `lxo` y el agente del gateway son **clientes** del mismo daemon.

* **A favor:** el dueño de los procesos vive aparte de la ventana; un único escritor por host sin cambiar el modelo;
  Desktop/CLI/Mobile remoto comparten la misma superficie (hoy ya hablan HTTP local); el trabajo de `Host` ya hecho
  aísla a Tauri.
* **En contra:** un proceso más que empaquetar, arrancar, actualizar y diagnosticar en tres sistemas; hay que decidir
  qué pasa con un daemon antiguo cuando Desktop se actualiza; superficie de ataque local nueva (mitigable, §6).
* **Veredicto:** **recomendada.**

### C. Delegar a los daemons de los providers

Que cada provider conserve sus procesos (`codex app-server`) y Lixbon solo se reconecte.

* **A favor:** menos código propio para Codex.
* **En contra:** Claude no ofrece nada equivalente y el contrato común de adapters exige comportamiento homogéneo;
  la identidad y el cierre pasarían a depender de cada provider; no resuelve PTY ni procesos de terminal de usuario.
* **Veredicto:** insuficiente como arquitectura. Sí es una **capacidad opcional** de un adapter (adjuntarse a una
  sesión viva cuando el provider lo permita), declarada en `Capability`, no la base.

### D. Supervisor mínimo separado, Core sigue embebido

Un proceso pequeño que solo posee procesos; el Core (en Desktop) le pide lanzar y adjuntar.

* **A favor:** el proceso nuevo es pequeño; los procesos sobreviven a Desktop.
* **En contra:** el estado de los Attempts (SQLite, en Desktop) y el estado de los procesos (supervisor) se separan en
  dos autoridades que hay que reconciliar siempre; con Desktop cerrado nadie puede decidir ni registrar el fin de un
  Attempt. Resuelve el síntoma y deja el problema de fondo.
* **Veredicto:** se descarta; es B con la mitad del valor y toda la complejidad de sincronización.

## 4. Decisión

**Alternativa B.** Un daemon por usuario y host que contiene el Core y es **el único dueño de la base, de los procesos
y de los PTY**. Todo lo demás son clientes.

```text
                        ┌───────────────────────────── host (una máquina) ─────────────────────────────┐
 Desktop (UI) ──┐       │                                                                              │
 lxo (CLI) ─────┼─ loopback HTTP/handshake ─►  lixbond  ── SQLite (core.lock, un escritor) ───────────┤
 agente gateway ┘       │                       │  └── supervisor: Attempts, PTY, Jobs/sesiones, leases  │
        ▲               │                       └── adapters (Claude, Codex, …)                         │
        │               └──────────────────────────────────────────────────────────────────────────────┘
        └── cliente remoto (Mobile/web/CLI) ── gateway (relay, sin estado) ── agente gateway (conexión saliente)
```

* **Quién posee los procesos:** el daemon. Cada Attempt vivo tiene una fila de ownership con `runtime_instance`,
  `lease_until` y `heartbeat`; un proceso sin lease vigente se verifica y se adopta o se termina, nunca se asume.
* **Nombre y protocolo:** `lixbond`, el protocolo que ya habla `orch/server.rs` (`/handshake`, `/rpc`, `/events`),
  versionado en el handshake. No se inventa un segundo protocolo.
* **Ciclo de vida:** Desktop y `lxo` hacen *attach-or-spawn* (se conectan al daemon publicado en `orch.json` o lo
  arrancan). Parar = orden explícita; **cerrar Desktop no para el daemon** salvo que no haya trabajo persistente.
  Actualizar = el daemon nuevo solo arranca si el anterior no tiene Attempts vivos o los traspasa de forma verificable.
* **Escritor único:** `core.lock` se conserva tal cual; el daemon lo toma. Un Core embebido que no consiga el lock
  falla con un error claro en vez de abrir la base.
* **Local por host:** rutas, ProjectLocation, procesos, worktrees y secretos del dispositivo. **Puede viajar:** eventos,
  queries y comandos autenticados (§6). La base no viaja nunca.
* **Adapters con daemon propio:** `codex app-server` sigue siendo un hijo del daemon. Adjuntarse a una sesión viva del
  provider es una capacidad opcional del adapter, no un requisito.

## 5. Modelo de fallos

| Fallo | Comportamiento esperado |
|---|---|
| Cae Desktop | Nada: el daemon sigue; los Attempts persistentes continúan. |
| Cae el daemon con procesos vivos | Al arrancar, recuperación por orden: lock → migraciones → leer ownership → verificar cada proceso por identidad (pid + hora de inicio, no por nombre) → adoptar, marcar `orphaned` o terminar. Dos recuperaciones seguidas dan el mismo resultado. |
| Un proceso no se puede cerrar con prueba | Se queda en custodia (hoy en memoria; pasa a persistirse); el worktree no se limpia hasta resolverlo. |
| Dos daemons a la vez | El segundo no obtiene `core.lock` y sale. |
| Cliente con versión incompatible | El handshake lo rechaza con un error explícito; no hay degradación silenciosa. |
| Pérdida del gateway | El host figura offline/stale, no `failed`; al volver, el cliente reanuda desde su cursor de eventos con idempotencia. |

## 6. Seguridad y versiones

* **Loopback con credencial** como hoy; la credencial del cliente se registra en el almacén, nunca en `orch.json`. El
  daemon rechaza clientes sin identidad (actor y dispositivo de LXO-85).
* **El gateway nunca es autoridad**: no decide estado, Attention ni resultado de un Attempt; toda mutación termina en el
  Core del host y usa su idempotencia. La conexión del host al gateway es **saliente** (no se abre un puerto entrante).
* **Remoto:** sesión autenticada extremo a extremo, revocación por dispositivo, protección contra repetición y logs del
  gateway sin payloads sensibles. El detalle del transporte es LXO-184; esta ADR solo fija las invariantes.
* **Versiones:** el handshake negocia `protocol` y `capabilities`; el esquema de la base lo gobierna el daemon. Un cliente
  más nuevo que el daemon no migra la base; un daemon más nuevo que el cliente lo rechaza con mensaje explícito.

## 7. Empaquetado (por medir)

* **Windows:** proceso de usuario lanzado desde Desktop y desde el inicio de sesión. Un Job Object sin
  `KILL_ON_JOB_CLOSE` para los Attempts persistentes. No se propone un servicio de Windows.
* **Linux:** unidad `systemd --user` opcional; sin systemd, attach-or-spawn.
* **macOS:** `launchd` de usuario opcional.
* El binario del daemon va en el paquete de Desktop. *Por medir:* tamaño, tiempo de arranque en frío y política de
  actualización cuando Desktop se instala encima de un daemon vivo.

## 8. Impacto

* **Desktop:** deja de contener el Core; `TauriHost` se convierte en un cliente de eventos. Es el cambio más grande.
* **CLI:** ya habla con el Core por HTTP local; solo cambia cómo descubre/arranca el daemon.
* **Mobile:** sin cambios hasta el gateway (LXO-184); gana poder controlar con Desktop cerrado.
* **Gateway Python:** deja de depender de que Desktop esté abierto; el agente que se conecta pasa a ser el daemon.

## 9. Camino de migración (rebanadas siguientes)

Cada rebanada se puede mergear y dejar el sistema funcionando.

1. **Extraer el Core a una biblioteca/binario headless** que arranque con un `Host` sin Tauri. Sin cambiar de
   proceso todavía. *Por medir:* qué más de `lib.rs` (49 referencias a `tauri::`) cuelga del Core.
2. **Supervisor con ownership persistente** (LXO-183): tabla de ownership, leases, custodia persistida, Jobs sin
   `KILL_ON_JOB_CLOSE` para trabajo persistente.
3. **Identidad de host** (LXO-182): `host_id` verificable, ProjectLocation ligada a host.
4. **Recuperación al arrancar** (LXO-185): orden, adopción verificada, inyección de fallos.
5. **Daemon real + attach-or-spawn** en Desktop y `lxo`.
6. **Gateway** (LXO-184): conexión saliente del daemon, reanudación con cursor.

Las rebanadas 2 y 3 son independientes entre sí. La 1 desbloquea la 5.

## 10. Criterio de no-go

Se abandona B (y se vuelve a A) si la rebanada 1 muestra que extraer el Core exige reescribir más de lo que hoy aísla
`Host`, o si el arranque en frío del daemon impide un attach-or-spawn razonable. Ambos se miden en la rebanada 1 antes
de comprometer las siguientes.

## 11. Preguntas abiertas

* ¿`lixbond` como nombre definitivo y como binario separado, o el mismo ejecutable de Desktop con un modo `--daemon`?
  (Un solo ejecutable simplifica la actualización; uno separado simplifica el uso sin interfaz gráfica.)
* ¿Qué significa «trabajo persistente»: opt-in por Attempt, o todo Attempt sobrevive al cierre de Desktop?
* ¿Se necesita `lxo` sin Desktop instalado (servidor/CI)? Cambia el empaquetado.
