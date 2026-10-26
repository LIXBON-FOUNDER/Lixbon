# ADR · ContextPackage: experimentos A–D y contrato de portabilidad (LXO-132)

| | |
|---|---|
| **Estado** | Propuesta lista para el schema v1 de LXO-133. Las decisiones D37–D44 quedan abiertas hasta que la persona las confirme |
| **Épica** | `[CORE][F4]` Adapters + ContextPackage |
| **Entrega** | Investigación y ADR. **Ningún schema productivo, ninguna UI, ningún cambio de runtime** |
| **Prueba** | [`fixtures/context-package/`](fixtures/context-package/): `python -I -X utf8 docs/core/fixtures/context-package/experimentos.py todo resultados.v0.json` |
| **Datos** | [`resultados.v0.json`](fixtures/context-package/resultados.v0.json): todo lo que cita este documento |

## 1. Pregunta

Cuando una Task cambia de proveedor, de host o de sesión, ¿qué información tiene que viajar para que el siguiente
Attempt continúe sin perder lo importante, sin copiar secretos y sin fingir que reproduce el estado privado de un
proveedor? Y, si el proveedor puede reanudar su propia sesión, ¿cuándo basta con eso?

## 2. Método

**La tarea es real**: la propia LXO-205 (commits `e73a74da` → `b1cc12e3`, 15 archivos, +1738/−6, diff de 99 407 bytes).

| Pieza del paquete candidato | Origen |
|---|---|
| `objective`, `decisions`, `constraints`, `thread_summary` | texto de la Task y de la conversación que la hizo |
| `revision` | `git`: commits, lista de archivos con `+/−`, `sha256` y tamaño del diff |
| `test_results` | la ejecución real de `cargo test --lib` (1441 pasan, 0 fallan, 19 ignoradas) |
| `artifacts` | el commit y dos archivos con `sha256` y tamaño |

**Qué se mide**

* *Sin modelo*: tamaño de cada pieza; qué detecta la red de seguridad actual (`looks_secret` + `redact`) sobre el diff real
  y sobre secretos falsos con formas reales; los escenarios C y D con `git` (aplicar, comparar árboles).
* *Con modelos baratos* (Claude `haiku`, Codex `gpt-5.6-luna`): se entrega una variante del paquete a un agente nuevo y se
  le hacen 10 preguntas cuya respuesta solo sale del contexto correcto (el comando exacto, por qué un valor es
  desconocido, cuántas pruebas pasan, el commit final, qué archivos se añadieron, si se puede hacer push…). Cada respuesta
  es `correcta`, `desconocido` o `incorrecta` por una rúbrica automática; **«desconocido» no penaliza, adivinar sí**.

| Variante | Contenido |
|---|---|
| `nada` | solo el nombre de la Task (línea base) |
| `solo_resumen` | objetivo, decisiones, restricciones y resumen del hilo |
| `solo_refs` | objetivo + referencias verificables (commits, archivos, hashes); el agente puede leer el repositorio |
| `diff_inline` | objetivo + el diff completo dentro del prompt |
| `completo` | todo lo anterior salvo el diff: resumen **y** referencias **y** pruebas |

## 3. Resultados

### Escenarios A y B: misma CLI con sesión nueva, y otro proveedor

| Id | Escenario | Proveedor | Variante | Herramientas | Correctas | Desconocidas | Incorrectas | Entrada (tokens) | Coste |
|---|---|---|---|---|---|---|---|---|---|
| A1 | A | Claude haiku | `nada` | no | **0** | 10 | 0 | ≈0,3 K | 0,0006 USD |
| A2 | A | Claude haiku | `solo_resumen` | no | **7** | 3 | 0 | ≈0,7 K | 0,0010 USD |
| A3 | A | Claude haiku | `completo` | no | **10** | 0 | 0 | ≈1,2 K | 0,0015 USD |
| A4 | A | Claude haiku | `diff_inline` | no | **7** | 3 | 0 | ≈25,3 K | 0,0158 USD |
| A5 | A | Claude haiku | `solo_refs` | sí (lee el repo) | **8** | 1 | 1 | ≈0,8 K + 3 turnos | 0,0041 USD |
| B1 | B | Codex luna | `nada` | no | **0** | 10 | 0 | ≈0,3 K | — |
| B2 | B | Codex luna | `completo` | no | **10** | 0 | 0 | ≈1,2 K | — |
| B3 | B | Codex luna | `solo_refs` | sí (lee el repo) | **10** | 0 | 0 | 160 K (3 comandos de lectura, 48 s) | — |

(Codex no informa coste en `exec --json`; sí tokens: 23 K con `completo`, 160 K con `solo_refs` y herramientas, de los
cuales ≈22 K son el arranque de la CLI.)

Lo que enseña cada fila:

* **El paquete funciona entre proveedores**: el mismo `completo` da 10/10 en Claude (A3) y en Codex (B2), sin que
  ninguno vea la sesión del otro. No hizo falta traducir nada específico del proveedor.
* **Sin contexto no hay alucinación**: A1 y B1 contestan «desconocido» a las 10. La instrucción «no adivines» funciona.
* **El resumen solo no alcanza** (A2, 7/10): lo que pierde es justo la evidencia verificable, no el razonamiento:
  *cuántas pruebas pasaron* (q4), *cuál es el commit final* (q9) y *qué archivos se añadieron* (q10).
* **El diff entero no sustituye al resumen** (A4, 7/10, **10 veces más caro** que A3): sin `decisions` ni `constraints` el
  agente no sabe *por qué* (q5: la restricción de no hacer push), ni los resultados (q4) ni el commit (q9); el diff no
  trae nada de eso.
* **Las referencias solas obligan a buscar** (A5, B3): funcionan, pero cuestan 2,7× (Claude) y 7× en tokens de entrada
  (Codex) y siguen sin dar lo que no está en el repositorio (A5 falla q4 —resultados de pruebas— y q3 —una decisión—).
* **Un error de método que conviene recordar**: la primera ejecución de B1 sacó 10/10 *sin contexto*. Codex, aun con
  `-s read-only`, **puede leer todo el disco** y encontró la propia tarea. Con la instrucción «no uses herramientas» baja a
  0/10 y ninguna herramienta se usó (el arnés lo comprueba: `contaminado: false`). Consecuencia para el producto: el
  sandbox de lectura de Codex no aísla el contexto; el aislamiento se pide y se comprueba, no se supone.

### Escenario C: mismo proveedor, otro host

| Hecho medido | Valor |
|---|---|
| Commits de la pila que **no** están en ningún remoto | 5 (LXO-128, 129, 130, 131, 205) |
| ¿Resuelve el commit final en un host que solo tiene el remoto? | **No** |
| Tamaño para transportarlos | diff binario 99 407 B · `format-patch` 101 932 B · **`git bundle` 31 019 B** |
| Aplicar el diff sobre el commit base, ¿reproduce el árbol del commit final? | **Sí** (árbol `e3b8786a9a38…`) |
| Específico del host (no es identidad): | ruta del worktree, id de máquina, rama local no publicada, ProviderSession |

Un `head_commit` en el paquete **no es verificable** en otro host si el commit no se publicó. La evidencia se verifica
comparando el **árbol** (`git rev-parse HEAD^{tree}`), y el transporte de lo no publicado va en un adjunto (bundle).

### Escenario D: traspaso humano/agente con un worktree sucio

| Hecho medido | Valor |
|---|---|
| Con solo el commit, ¿el segundo agente reproduce el estado del primero? | **No** (había una edición, una preparada y un archivo nuevo) |
| Lo que falta | parche sin commit: **1 100 B** (525 B preparado + 575 B no preparado) + 1 archivo sin seguimiento con su `sha256` |
| Con parche + archivos, ¿se reproduce el árbol? | **Sí** |
| Aplicando lo preparado y lo no preparado **por separado**, ¿se reproduce también el índice? | **Sí** |

El estado sucio es 90 veces más pequeño que el diff completo y cabe en el paquete como adjunto; sin él, el traspaso
pierde trabajo sin avisar.

### Redacción

| Medida | Resultado |
|---|---|
| Líneas del diff real marcadas por `looks_secret` | 1 de 1996: un centinela de prueba (`sk-ant-api03-…`) en `usage_tests.rs` |
| Tras redactar el diff, ¿se sigue aplicando? | **Sí** (la línea es añadida, no contexto)… |
| …¿conserva el hash? | **No**: el archivo resultante es otro. Redactar un adjunto de código **rompe su verificación** |
| Cobertura sobre 13 secretos falsos con formas reales | **6 de 13 (46 %)** |
| No detectados | JWT, URL con credenciales (`postgres://u:p@h`), token npm, token Google OAuth, AWS secret key, Stripe (`sk_live_`), variable `.env` (`NOMBRE=valor`) |
| Falsos positivos sobre 5 textos que no son secretos (sha, uuid, ruta, hash de integridad, prosa) | 0 |
| ¿Salió el centinela del hilo en el paquete entregado? | No (se redactó antes de serializar) |

La red actual es una **red mínima pensada para ids y metadata**, no un detector para contenido libre. Sirve para el
texto corto del paquete; no es suficiente para exportar un diff ni una salida de pruebas.

### Tamaño

| Pieza | Bytes | ≈ tokens |
|---|---|---|
| `objective` | 114 | 29 |
| `decisions` (7) | 819 | 204 |
| `constraints` (3) | 250 | 62 |
| `thread_summary` | 299 | 74 |
| `revision` (15 archivos con `+/−`, hashes) | 1 623 | 406 |
| `test_results` | 155 | 39 |
| `artifacts` (3) | 348 | 87 |
| **Paquete `completo`** | **3 768** | **939** |
| Diff completo | 99 407 | 24 207 |

El paquete es ≈26 veces más pequeño que el diff y sin él cuesta ≈10 veces menos al agente que lo recibe.

## 4. Límites de este estudio

* **Una tarea, una pasada por variante.** Indica dirección, no estadística. Las diferencias de 7 frente a 10 son hechos
  concretos (qué pregunta falló y por qué), no promedios.
* **El resumen del experimento lo escribí a mano.** Es una cota superior de lo que un resumen puede dar. Cuánto
  conserva un resumen *generado* automáticamente **no se midió**; por eso D41 lo deja fuera de v1.
* **Solo hechos.** La rúbrica comprueba que el agente sabe qué se hizo y por qué, no que continúe bien el trabajo.
* **Dos modelos baratos** (haiku, luna). Modelos mayores aprovecharán mejor las referencias; los hechos que faltan en
  `solo_resumen` siguen faltando.
* **El resume nativo no se midió**: no hay una sesión previa equivalente. La política de D43 sale de las capabilities
  (LXO-128/134) y de lo medido sobre qué contiene el paquete, no de una comparación directa de coste.
* La redacción se evaluó con un port a Python de `looks_secret`/`redact` (mismas listas); el detector real es el de Rust.

## 5. Decisiones propuestas

| # | Decisión | Evidencia | Alternativa descartada |
|---|---|---|---|
| D37 | **El paquete son datos estructurados + referencias verificables, no un transcript ni un diff.** | A3 10/10 con ≈1 K tokens; A4 7/10 con 25 K | volcar el hilo o el diff: más caro y falla en lo que no está en el código |
| D38 | **Cuatro bloques con papeles distintos**: intención (`objective`, `decisions`, `constraints`, `thread_summary`), evidencia (`revision`, `test_results`, `artifacts`), estado sin commit (`uncommitted`) y procedencia (`source`). Ninguno basta solo | A2 pierde la evidencia; A4/A5 pierden la intención | un único campo de texto libre |
| D39 | **La evidencia se verifica por árbol y por hash, no por texto.** `revision` lleva `base_commit`, `head_commit`, `head_tree`, `diff_sha256` y la lista de archivos. Si los commits no están publicados, un adjunto `git bundle` (31 KB frente a 99 KB) | escenario C | confiar en el `head_commit` solo |
| D40 | **El estado sin commit es un bloque aparte**: parche preparado, parche no preparado y archivos sin seguimiento con `sha256`, todo como adjuntos. Se verifica reproduciendo el árbol y el índice | escenario D | que el siguiente agente «mire el worktree» |
| D41 | **El resumen sale de datos del Core, no de un modelo, en v1.** `thread_summary` es el `Thread.summary` existente (≤2000 caracteres, ya pasa por `looks_secret`); las decisiones y restricciones son listas que el Core ya registra. Generar un resumen con un modelo queda fuera hasta medirlo | límite de §4 | resumir con un modelo en v1: sin medir, y gasta cuota |
| D42 | **Se redacta el texto del paquete antes de serializar; los adjuntos de código no se redactan: se declaran y se verifican.** Un adjunto con un secreto detectado **no se exporta** (el paquete lo lista como `omitted: secret_detected`), en lugar de viajar alterado. La redacción por defecto exige además ampliar el detector (JWT, userinfo en URL, `NOMBRE=valor`, más prefijos) antes de exportar contenido libre | redacción: rompe el hash; cobertura 6/13 | redactar el diff: cambia el árbol y esconde que se alteró |
| D43 | **Política de continuidad.** *Resume nativo* cuando el adapter ofrece `resume`, es el mismo proveedor y host, la sesión es resumible y no expiró y el worktree no cambió fuera de ella: conserva razonamiento y salidas de herramientas que un paquete no puede llevar. *ContextPackage* cuando cambia proveedor o host, no hay resume o expiró, se pide un Attempt limpio (fork) o el worktree cambió por fuera. **Nunca se finge portabilidad de una ProviderSession entre proveedores** | A3 y B2: el paquete cruza proveedores; capabilities de LXO-128 | un paquete que intente reproducir el estado interno del proveedor |
| D44 | **Identidad y procedencia inmutables.** `package_id` = `sha256` del JSON canónico del contenido; `source` (proyecto, Task, Attempt, proveedor, huella de host y de sesión) lo fija el Core al crear el paquete y el receptor **no puede cambiarlo**: lo que añade el receptor va en un registro aparte (`received_by`) | invariantes 1 y 5 de LXO-133 | dejar que el cliente receptor reescriba el origen |

## 6. Contrato propuesto para el schema v1

```jsonc
{
  "schema_version": 1,                              // REQUERIDO
  "package_id": "sha256:…",                         // REQUERIDO · hash del contenido canónico (D44)
  "created_at": "2026-10-26T20:11:09Z",             // REQUERIDO
  "source": {                                       // REQUERIDO · lo fija el Core
    "project_id": "…", "task_id": "…", "attempt_id": "…",
    "provider": "claude",
    "provider_session": "fp:9f3a1c2e",              // huella, nunca la referencia opaca
    "host": "fp:b81d04aa"                           // huella, nunca la ruta ni el nombre
  },
  "objective": "…",                                 // REQUERIDO · ≤2000 caracteres
  "decisions": ["…"],                               // opcional · pero presente y vacío si no hay: ≤32 × 500
  "constraints": ["…"],                             // opcional · ídem
  "thread_summary": "…",                            // opcional · ≤2000 (el límite de Thread.summary)
  "revision": {                                     // REQUERIDO, o null con `reason` si el Attempt no tiene repositorio
    "base_commit": "e73a74da…", "head_commit": "b1cc12e3…", "head_tree": "e3b8786a…",
    "branch": "feat/lxo-205-usage-cross-provider",  // informativa: puede no existir en el receptor
    "files": [{ "path": "docs/core/ADAPTERS.md", "added": 61, "deleted": 1 }],     // rutas relativas al repositorio
    "diff_sha256": "…", "diff_bytes": 99407
  },
  "uncommitted": {                                  // opcional · el estado del worktree sucio
    "staged_patch": "att:…", "unstaged_patch": "att:…",
    "untracked": [{ "path": "NOTAS.md", "sha256": "…", "bytes": 49 }]
  },
  "test_results": { "command": "cargo test --lib", "passed": 1441, "failed": 0, "ignored": 19 },   // opcional
  "artifacts": [{ "kind": "commit", "uri": "b1cc12e3…" }],                                          // opcional · como `artifacts`
  "attachments": [                                  // opcional · blobs aparte, referenciados por hash
    { "id": "att:…", "kind": "git_bundle", "sha256": "…", "bytes": 31019 },
    { "id": "att:…", "omitted": "secret_detected" }
  ],
  "truncated": [{ "field": "thread_summary", "original_chars": 3120 }]                              // explícito, nunca en silencio
}
```

**Nunca viajan**: transcript, razonamiento del proveedor, salidas crudas de herramientas, `ProviderRef`/id de sesión,
variables de entorno, tokens, identificadores de cuenta, rutas absolutas ni el nombre de la máquina.

**Límites propuestos**: paquete ≤ 64 KiB sin adjuntos (el medido, completo, es 3,7 KiB: 17× de margen); adjunto ≤ 1 MiB
y ≤ 8 MiB en total; una lista que se pasa de su tope se recorta y consta en `truncated`.

**Obligatorio / opcional / redactado**

| Campo | Estado | Se redacta |
|---|---|---|
| `schema_version`, `package_id`, `created_at`, `source` | requerido, lo pone el Core | no (son ids y huellas) |
| `objective` | requerido | sí |
| `revision` | requerido (o `null` + motivo) | las rutas no; los mensajes de commit, sí |
| `decisions`, `constraints`, `thread_summary` | opcionales (vacíos explícitos) | sí |
| `test_results` | opcional | sí (la salida de pruebas puede traer entornos) |
| `uncommitted`, `attachments` | opcionales | **no se redactan: se omiten si hay secreto** (D42) |
| `artifacts` | opcional | los localizadores ya los valida `looks_secret` (LXO-116) |

## 7. Política de compatibilidad

* `schema_version` desconocida, campo requerido ausente, `package_id` que no coincide con el contenido, o un adjunto cuyo
  `sha256` no coincide: el paquete es **inválido y no inicia ningún Attempt** (invariante 4 de LXO-133).
* Un campo desconocido **opcional** se conserva pero no se interpreta; uno que cambie el significado de los existentes
  sube `schema_version`.
* El paquete es **inmutable**: corregirlo es crear otro con otro `package_id`, que enlaza al anterior en `source`.
* Verificar no es confiar: el receptor comprueba `head_tree`/`diff_sha256` contra su repositorio antes de usar la
  evidencia, y lo que no pueda comprobar lo marca como `no verificado` en vez de darlo por bueno.

## 8. Qué queda para LXO-133

Implementar el schema, el canonicalizador y `package_id`; la tubería de redacción con el detector ampliado (D42) y sus
sentinelas; los adjuntos con `sha256`; los límites y `truncated`; y el export/import entre adapters falsos. El arnés de
este documento sirve de **prueba de aceptación de contenido**: un paquete v1 construido para esta misma tarea debe
sacar 10/10 en A3/B2 y no debe contener el centinela.
