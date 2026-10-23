# Fixture del corte Task/Attempt (LXO-112, LXO-117)

Material de [`../../CORTE_TASK_ATTEMPT.md`](../../CORTE_TASK_ATTEMPT.md) y de [`../../CORTE_EJECUCION.md`](../../CORTE_EJECUCION.md).
La SQL del corte es [`task_attempt_cut.sql`](../../../../apps/desktop/src-tauri/src/store/cut/task_attempt_cut.sql)
(fuera de `store/migrations/`: el arranque no la aplica hasta activar el corte).

| Archivo | Qué es |
|---|---|
| `legacy_state.before.json` | un `State` real con los casos límite |
| `normalizado.after.json` | las filas esperadas tras el corte. Las comparan `verificar.py` y la prueba de Rust `orch::agentic_cut_tests` |
| `verificar.py` | aplica las migraciones publicadas, la copia, el corte, un corte roto y el rollback (S0..S5) |

```sh
python -I docs/core/fixtures/corte-task-attempt/verificar.py             # comprueba S0..S5
python -I docs/core/fixtures/corte-task-attempt/verificar.py --escribir  # regenera normalizado.after.json
```

Solo usa la biblioteca estándar de Python (`sqlite3` con JSON1) y trabaja en un directorio temporal: no toca
`~/.lixbon`. Aplica todas las migraciones **publicadas** anteriores al corte (hoy 001…010), así que si una de ellas
cambia, la prueba lo nota.

Si cambias el mapeo, cambia a la vez la SQL del corte, la ADR y, tras revisarlo a mano, `normalizado.after.json` con
`--escribir`.
