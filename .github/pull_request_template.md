## Qué cambia

<!-- Resumen en una o dos frases. Ámbito: gateway / web / desktop / cli / mobile -->

## Cómo se probó

- [ ] `python -m pytest core` (si toca gateway)
- [ ] `python -m pytest apps/cli/tests` y `python apps/cli/build.py` (si toca CLI)
- [ ] Probado a mano en: <!-- web local / desktop dev / APK / … -->

## Checklist

- [ ] Si cambia un contrato gateway↔app, ambos lados van en este PR o se enlaza el PR pareja (`docs/ARQUITECTURA.md` → Contratos compartidos)
- [ ] Si es release de desktop/mobile, la versión del binario y el tag coinciden (`docs/RAMAS_Y_RELEASES.md`)
- [ ] Docs actualizadas si cambia estructura, comandos o variables de entorno
