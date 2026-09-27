# Orquestador de Lixbon · guía del coordinador

Vas a repartir un objetivo entre agentes hijos. Cada hija corre en su propia terminal dentro de
Lixbon, en su rama y su worktree, y te avisa al terminar cada fase. Tú decides, esperas, revisas
y fusionas. El usuario lo ve todo en el modo Orquestador de Lixbon.

## Antes de lanzar nada

1. `lxo status --json`: dice tu papel, los agentes disponibles y la profundidad máxima.
2. Si no eres una tarea (`role: external`), crea el run con
   `lxo run create --objective "<objetivo en una frase>" --agent <tu agente: claude|codex|opencode…>`.
   Una sola vez por objetivo.
3. **Haz commit** de lo que quieras que vean las hijas: parten de tu último commit, no de los
   cambios sin guardar.

## Reparte el trabajo

- Divide en tareas **independientes** que no editen los mismos archivos. Mejor 2–4 hijas en
  paralelo que cadenas largas.
- Lanza cada una con un encargo completo y autocontenido: qué hacer, dónde, criterios de
  terminado y cómo verificarlo. La hija no ve tu conversación.

```
lxo spawn --agent claude --name "API de login" --task "<encargo completo>"
lxo spawn --agent codex  --name "Tests de login" --task "<encargo completo>"
```

- `--agent` acepta los agentes de `lxo status` (claude, codex, opencode, cursor, gemini, lixbon).
  Sin él se usa el agente por defecto que eligió el usuario.
- `--no-worktree` solo para tareas de lectura (investigar, revisar): comparte tu carpeta.
- Lanza toda la tanda **antes** de esperar.

## Espera y atiende

```
lxo wait --timeout-ms 900000
```

Bloquea hasta que llega algo y lo marca como leído. Tipos de mensaje:

- `phase`: una hija terminó una fase. Informativo; sigue esperando.
- `question`: una hija está bloqueada esperándote. Responde en cuanto puedas:
  `lxo reply <id-de-la-pregunta> "<respuesta>"`.
- `done`: una hija terminó (`succeeded` o `failed`, con su resumen).
- `exited`: el agente de una hija se cerró sin terminar. Revisa con `lxo show <tarea>` y decide
  si relanzarla con un encargo corregido.

Un `wait` vacío (timeout) no es un fallo: la respuesta incluye `open_children` con las hijas que
siguen en marcha. Vuelve a esperar. Para mandar instrucciones nuevas a una hija en marcha:
`lxo send <tarea> "<mensaje>"` (la hija lo lee en su siguiente `lxo check`).

## Revisa y fusiona

Por cada hija terminada:

1. `lxo diff <tarea>` (añade `--json` para leer `stat` y `diff`). Comprueba que cumple el encargo.
2. Si está bien: `lxo merge <tarea>` fusiona su rama en **tu** rama/carpeta (`--squash` para un
   único commit). Tu checkout tiene que estar limpio. Si hay conflictos, el merge se aborta y no
   cambia nada: resuélvelos tú o lanza una hija que lo haga.
3. Si prefieres revisión humana: `lxo pr <tarea>` sube su rama y abre un PR contra tu rama.
4. Cuando ya no la necesites: `lxo release <tarea>` borra su worktree (y su rama si está
   fusionada).

Otras: `lxo list` (árbol del run), `lxo show <tarea>`, `lxo stop <tarea>`.

## Termina

Cuando todas las hijas estén resueltas (fusionadas, con PR o descartadas), verifica el
resultado conjunto (build, tests) y resume al usuario, por tarea: resultado, evidencia y lo que
quede pendiente. Si tú eres a su vez una tarea hija, después cierra con `lxo done` según tu guía.
