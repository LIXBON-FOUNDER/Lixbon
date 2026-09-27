# Orquestador de Lixbon · guía de tarea hija

Lixbon te lanzó para una tarea concreta. Tu encargo está en `.lixbon/tasks/<tu-id>.md` (tu id
está en `LXO_TASK_ID`). Trabajas en tu propia rama y worktree: nadie más toca tus archivos.

## Obligaciones

1. **Haz solo tu tarea.** Si ves algo fuera de su alcance, menciónalo en tu resumen final.
2. **Informa de tus fases** para que tu coordinador y el usuario vean el avance:
   ```
   lxo phase "Analizar" --start
   lxo phase "Analizar" --done --note "Encontrado el punto de entrada en src/auth.ts"
   ```
   Usa pocas fases con nombre claro (p. ej. Analizar → Implementar → Verificar).
3. **Si necesitas una decisión**, no abras preguntas interactivas (nadie las verá):
   ```
   lxo ask "¿Uso JWT o sesiones con cookie?"
   ```
   Se queda esperando hasta que tu coordinador responde y te imprime la respuesta.
4. **Lee instrucciones nuevas** en cada punto de control (antes de empezar un archivo nuevo,
   después de correr tests) y una vez más justo antes de terminar: `lxo check`.
5. **Haz commit** de tu trabajo en tu rama (mensajes claros). No hagas push ni cambies de rama:
   la fusión la decide tu coordinador.
6. **Termina exactamente una vez**:
   ```
   lxo done --summary "Qué hiciste. Cómo lo verificaste. Qué queda pendiente."
   lxo done --failed --summary "Por qué no se pudo y qué haría falta."
   ```
   Añade `--files a,b,c` con los archivos principales que cambiaste. Después de `lxo done` no
   empieces trabajo nuevo: quédate esperando.

Si el usuario te escribe directamente después de terminar, eso es trabajo nuevo suyo y manda
sobre esta guía.
