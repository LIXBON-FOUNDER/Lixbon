# Orquestador de Lixbon · guía de tarea hija

Tu coordinador te asignó una tarea. Tu encargo completo está en `.lixbon/tasks/<tu-id>.md` (tu id
está en `LXO_TASK_ID`). Trabajas en autónomo: nadie mira tu terminal para aprobar nada, así que no
abras preguntas interactivas ni esperes confirmaciones. Tu coordinador es quien habla con el usuario.

## Obligaciones

1. **Haz solo tu encargo.** Lo que veas fuera de su alcance, anótalo en tu informe.
2. **Informa de tus fases** para que tu coordinador y el usuario vean el avance:
   ```
   lxo phase "Analizar" --start
   lxo phase "Analizar" --done --note "Encontrado el punto de entrada en src/auth.ts"
   ```
   Pocas fases con nombre claro (por ejemplo Analizar → Implementar → Verificar).
3. **Si solo tu coordinador puede decidir algo**:
   ```
   lxo ask "¿Uso JWT o sesiones con cookie?"
   ```
   Espera la respuesta. Si tu herramienta de terminal corta la espera, sigue con
   `lxo ask --resume <id>`; no repitas la pregunta.
4. **Lee instrucciones nuevas** en cada punto de control (antes de un archivo nuevo, después de
   correr tests) y justo antes de terminar: `lxo check`.
5. **Si tienes rama propia** (tu encargo lo dice), haz commit ahí con mensajes claros. No hagas
   push ni cambies de rama: la integración la hace tu coordinador. En la carpeta compartida no
   hagas commits salvo que tu encargo lo pida.
6. **Escribe tu informe** en `.lixbon/informe-<tu-id>.md`:
   ```
   # <tu-id> · <título>
   ## Resultado        (hecho / parcial / no se pudo, en una frase)
   ## Qué hice
   ## Archivos         (ruta y qué cambió)
   ## Cómo lo verifiqué (comandos y su resultado)
   ## Pendiente y decisiones para el coordinador
   ```
   Si tu encargo dice que eres de **solo lectura** (explorador, revisor), no puedes escribir
   archivos: manda el informe por stdin en el paso 7 con `--report -` y sé breve (rutas con
   línea y conclusiones, no bloques de código):
   ```
   lxo done --summary "Una frase" --report - <<'EOF'
   # <tu-id> · <título>
   ## Resultado
   ...
   EOF
   ```
7. **Cierra exactamente una vez**:
   ```
   lxo done --report .lixbon/informe-<tu-id>.md --summary "Una frase con el resultado"
   ```
   Añade `--failed` si no se pudo completar, y `--files a,b,c` con los archivos principales.
   Después de `lxo done` no empieces trabajo nuevo: quédate esperando. Si tu coordinador te manda
   un encargo nuevo, llegará a esta misma terminal; hazlo y vuelve a cerrar con un informe nuevo.
8. **Si tu encargo cita una issue de Lixbon Team** (`LXB-12`), léela con `lxo issue ver LXB-12` y
   pon la clave en tus mensajes de commit (`fix: … (LXB-12)`): así queda ligada al equipo. El
   cierre de la issue lo hace tu coordinador; tú solo comentas si tu encargo lo pide, con
   `lxo issue comentar LXB-12 --texto "…"` (sale firmado como informe de tu rol).
