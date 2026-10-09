# Incidentes

## 2026-10-09 · El gateway no arranca: `ImportError: CLI_SOURCE_PATH`

**Impacto:** el deploy del gateway falla al arrancar (uvicorn no puede importar `core.gateway.app`). Toda la API queda caída mientras dure el deploy roto.

**Síntoma:**

```
File "/srv/lixbon/core/gateway/routers/installer.py", line 6, in <module>
    from core.config import CLI_SOURCE_PATH, PUBLIC_BASE_URL
ImportError: cannot import name 'CLI_SOURCE_PATH' from 'core.config'
```

**Causa:** un conflicto de merge mal resuelto en `b9b8ad2` ("Merge master into cli", PR #47).

- `a907b0d` (rama `cli`) retiró el CLI Python: quitó `CLI_SOURCE_PATH` de `core/config.py` y dejó en `installer.py` solo el instalador del binario Go, que devuelve 503 si no hay una release registrada.
- `7078445` (master) borró comentarios en `core/`, también en `installer.py`.
- En el merge, `config.py` se combinó bien (sin `CLI_SOURCE_PATH`), pero el conflicto de `installer.py` se resolvió quedándose entera con la versión de master. Así volvieron el endpoint `/install/client_cli.py`, el instalador Python de respaldo y el import de una constante que ya no existía.

**Por qué llegó a producción:** el CI lo detectó. El job `Gateway · tests` falló en el PR #47 y en el push a master con `ImportError` al recoger los tests, pero el PR se mergeó con ese check en rojo.

**Arreglo:** se restauró `installer.py` a la versión de `a907b0d` (solo el binario Go, con 503 sin release) y se mantuvo la limpieza de comentarios de master. `python infra/ci/gateway_tests.py` pasa con 23/23 módulos.

**Prevención:**

- Proteger `master` y exigir que `Gateway · tests` pase antes de mergear.
- Al resolver un conflicto, no tomar "ours"/"theirs" del archivo entero cuando las dos ramas lo cambiaron por motivos distintos. Combinar las dos intenciones y correr los tests del gateway antes de cerrar el merge.
