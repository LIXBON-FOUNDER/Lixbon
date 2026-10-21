# Fixture del corte Task/Attempt (LXO-112)

Material de diseño de [`../../CORTE_TASK_ATTEMPT.md`](../../CORTE_TASK_ATTEMPT.md). **Nada de esta carpeta es
código productivo**: `corte.borrador.sql` no es una migración (no está en `store/migrations/` y `build.rs` no lo
embebe) y `verificar.py` no lo ejecuta ningún binario ni la CI.

```sh
python -I docs/core/fixtures/corte-task-attempt/verificar.py             # comprueba S0..S5
python -I docs/core/fixtures/corte-task-attempt/verificar.py --escribir  # regenera normalizado.after.json
```

Solo usa la biblioteca estándar de Python (`sqlite3` con JSON1) y trabaja en un directorio temporal: no toca
`~/.lixbon`. Aplica las migraciones **publicadas** 001…006 del repositorio, así que si una de ellas cambia, la
prueba lo nota.

Si cambias el mapeo, cambia a la vez `corte.borrador.sql`, la ADR y, tras revisarlo a mano,
`normalizado.after.json` con `--escribir`.
