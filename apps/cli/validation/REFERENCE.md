# Referencia Python — línea base (BASE-01, versión reducida)

Ejecución nueva del 2026-10-06. Sustituye como evidencia a la cifra histórica 131/2 de `audit/EVALUACION_PYTHON_GO.md`, que se conserva sin modificar.

## Entorno

| | |
|---|---|
| SO | Windows 11 (10.0.26200) |
| Python | 3.13.14 (la auditoría usó 3.12.14, no disponible aquí) |
| Dependencias | `requirements.lock` (versiones fijadas; sin hashes todavía) |
| Aislamiento | venv nuevo, `USERPROFILE`/`HOME` temporales, `PYTHONDONTWRITEBYTECODE=1`, sin `__pycache__` ni caché de pytest |

## Resultado

| Suite | Resultado |
|---|---|
| `apps/cli/tests` completa | **133 passed**, 0 failed, 0 skipped (21,9 s) |
| Con `test_contract_corpus.py` (nuevo) | 135 passed |

## Los dos fallos históricos

`test_input_box.py::test_caja_en_reposo_mide_tres_filas` y `::test_complete_while_typing_dispararia_el_alto` fallaron en la auditoría con `KeyError: 'rows'` (el callback `pre_run` no llegó a rellenar la medición).

- **No se reproducen**: pasan en la suite completa y 15/15 veces aisladas con stdin nulo.
- Las versiones de pytest (9.1.1), rich (15.0.0) y prompt_toolkit (3.0.53) son las mismas que registró la auditoría. Lo único documentado que cambia es Python (3.12.14 → 3.13.14).
- **Clasificación: causa original no determinada.** No hay evidencia para atribuirla a fixture, dependencia, terminal o producto. No se modificó el fixture. Si reaparece, reproducir con Python 3.12 y capturar el orden de `pre_run`/entrada antes de tocar nada.

## Discrepancia del README

`README.md` dice «Python 3 estándar, sin dependencias externas», pero `cli.py` (`REQUIRED_PACKAGES`) instala `prompt_toolkit`, `rich` y `pypdf` con `pip`, y `documents.py` usa `python-docx` de forma opcional. Es la razón de ser del port: el binario Go no puede heredar esa instalación automática.

## Reproducir

```bash
python -m venv .venv && .venv/Scripts/python -m pip install -r apps/cli/validation/requirements.lock
# con HOME/USERPROFILE apuntando a una carpeta vacía:
.venv/Scripts/python -m pytest apps/cli/tests -p no:cacheprovider -q
python apps/cli/validation/gen_sse_corpus.py --check
```

## Pendiente respecto al plan 01-01

No se construyó el harness completo (`preflight.py`, `reference_runner.py`, hashes en el lock, `--self-check` con defectos inducidos, bloqueo de red). Esta referencia es manual y no hay mecanismo que rechace imports ausentes o skips críticos.
