# LXO-225 / LXO-226 · Protocolo de validación del ADE operacional (Sprint B y Sprint C)

**Tipo:** protocolo de sesiones; no contiene resultados de participantes
**Estado:** materiales listos; validación humana **NOT_RUN / BLOCKED** hasta completar dos sesiones individuales con desarrolladores
**Preguntas:**
- **Sprint B (LXO-225):** ¿la persona sabe con certeza qué target recibirá el mensaje y si Enter hará Queue, Steer, Stop & Send, Fork o una ejecución nueva?
- **Sprint C (LXO-226):** ¿puede decidir qué resultado aceptar e integrar con menos navegación y sin perder evidencia ni verificación?

## 1. Qué cambió respecto al diseño original

Las dos issues se escribieron el 2026-10-14 para validar **prototipos con fixtures**. Desde entonces las pantallas existen en el Desktop real (F5) y hablan con el Core. Por eso este protocolo valida **la superficie real contra un Core aislado**, no una maqueta. Cada observación debe decir si vino de la superficie real o de una captura/fixture; un acierto sobre un fixture no prueba que el Core ofrezca esa capacidad.

Pantallas que se ponen delante de la persona (detalle de un Attempt, `apps/desktop/src/ade`):

| Sprint | Superficie | Componente | Documento de contrato |
|---|---|---|---|
| B | Crear Task sola o Task + Attempt, con vista previa del target | `NewAttemptForm.jsx` | `docs/core/TASKS.md` |
| B | Cola, Steer y Stop & Send con el Attempt ocupado | `AttemptQueue.jsx` | `docs/core/COLA.md` y `docs/core/STEER.md` |
| B | Fork desde contexto existente | `AttemptFork.jsx` | `docs/core/FORK.md` |
| B | Compartir el worktree de otro intento (LXO-248) | `AttemptShareWorktree.jsx` | `docs/core/WORKTREE_SHARED.md` |
| B | Race: N Attempts | `AttemptRace.jsx` | `docs/core/RACE.md` |
| C | Proof Pack | `AttemptProofPack.jsx` | `docs/core/PROOF_PACK.md` |
| C | Compare | `AttemptCompare.jsx` | `docs/core/COMPARE.md` |
| C | Cambios y Review | `AttemptChanges.jsx` | `docs/core/REVIEWS.md` |
| C | Integration (merge / PR / conflicto) | `AttemptIntegration.jsx` | `docs/core/INTEGRACION.md` |

**Límites conocidos que no se deben ocultar a la persona ni al evaluar el resultado:**
- No hay selector de host (el Core tiene uno solo) ni attachments / context refs en la creación.
- El Composer idle del North Star no existe como tal: crear es un formulario aparte y el Composer de Queue/Steer solo sirve con un Attempt ocupado.
- La URL del PR no se pinta nunca (`attempt_detail_v2`, LXO-244): una pregunta sobre «abrir el PR» no tiene respuesta en pantalla por diseño.
- Las acciones se probaron con adapters falsos; con proveedores reales solo se han hecho las pruebas manuales de la CLI F5 (2026-11-16).

## 2. Participantes, privacidad y consentimiento

Igual que `LXO-224-validation-protocol.md` §3: **dos desarrolladores, sesiones separadas, mismo guion**, códigos anónimos `D01` y `D02`, sin nombres ni datos personales, 40–50 minutos, **sin grabar** salvo permiso separado, retiro libre. Texto de consentimiento adaptado:

> Estamos evaluando las pantallas y las etiquetas, no tu desempeño. Trabajarás sobre un Core de pruebas con datos ficticios; nada de lo que hagas afecta a trabajo real. Puedes pensar en voz alta, pedir una pausa, omitir una tarea o terminar cuando quieras. Tomaremos notas con un código anónimo. No grabaremos salvo que aceptes una solicitud separada. ¿Aceptas participar?

Registro: `Consentimiento verbal: [sí / no]` · `Grabación separada: [sí / no / no solicitada]`.

## 3. Preparación (la hace la persona dueña del entorno, no el moderador)

- [ ] Build de Desktop con el corte Task/Attempt activo (LXO-235) y su SHA anotado, más versión de WebView2, resolución y sistema operativo.
- [ ] **Perfil aislado** (`USERPROFILE`/`HOME`/`WEBVIEW2_USER_DATA_FOLDER` propios, como en las pruebas manuales de F5) y un Project de pruebas registrado.
- [ ] Proveedores **falsos o de pruebas**; nada con credenciales reales de nadie.
- [ ] Datos sembrados (IDs `fx-*`): 1 Project; 2 Tasks con Attempt `running` (una con capacidad de Steer y otra sin ella); 1 Task con 3 Attempts terminados para Compare; 1 Attempt con Proof Pack completo y otro parcial; 1 Attempt con revisión vigente y otro con la rama movida (stale); un cambio pequeño y uno grande (diff enorme); 1 merge limpio y 1 con conflicto.
- [ ] Cola con 0, 1 y N instrucciones pendientes.
- Si falta algún dato, el escenario correspondiente queda **BLOCKED**; no se improvisa con trabajo real.

## 4. Guion Sprint B · Composer y operaciones (LXO-225)

| # | Escenario | Qué debe poder decir la persona sin ayuda | Invariante que se mide |
|---|---|---|---|
| B1 | Abrir «Nuevo intento» y pulsar el botón principal sin enviarlo | En qué Project se crea, qué se crea (solo Task o Task + intento), que nada se ejecuta hasta aprobar, y qué worktree tendrá | Target/host/provider verificables; Enter hace lo que dice |
| B2 | Con un Attempt ocupado, escribir en el Composer | Qué hará Enter hoy (Queue por defecto) y en qué se diferencian Queue, Steer y Stop & Send | Semánticas visibles y distintas |
| B3 | Elegir el proveedor sin Steer / sin resume | Por qué una opción está deshabilitada | Capability ausente deshabilitada con razón |
| B4 | Mirar la cola con 0, 1 y N pendientes | Cuántas hay, cuál es la siguiente y cómo cancelar una | Pending Queue Dock |
| B5 | Pedir un Fork | Qué contexto viaja y que la ProviderSession no se comparte | Fork con contexto explícito |
| B6 | Revisar la vista previa del contexto | Qué se envía y qué se ha redactado o truncado | Context preview sin secretos |
| B7 | Provocar un lanzamiento bloqueado y uno fallido | Si quedó bloqueado o falló, y qué hacer | Feedback bloqueado vs fallido (hoy solo se ve lo que el Core deja en Attention) |
| B8 | Crear un Attempt mientras trabajas en otro | Que la pantalla no cambió sola de sitio | Background creation no roba foco |

**Pregunta final obligatoria:** «Antes de pulsar Enter, ¿qué target recibirá el mensaje y qué hará Enter?» — anotar la respuesta literal y si fue correcta.

## 5. Guion Sprint C · Verificar e integrar (LXO-226)

Hacerlo con **un cambio pequeño y uno grande**.

| # | Escenario | Qué debe poder decir la persona sin ayuda | Invariante que se mide |
|---|---|---|---|
| C1 | Abrir un Proof Pack completo y uno parcial | Qué evidencia es verificada, cuál la reporta el agente y cuál es desconocida | Procedencia con tratamiento distinto |
| C2 | Abrir el cambio grande | Que el Proof Pack orienta primero y el diff no domina | Diff enorme no domina |
| C3 | Comparar 2 y luego 3 Attempts | Qué difiere entre ellos y que la pantalla **no declara ganador** | Compare sin ganador por defecto |
| C4 | Revisar un Attempt con revisión vigente y otro stale | Contra qué revisión/hash decide y por qué una está desactualizada | Revisión visible y stale inequívoco |
| C5 | Aceptar una revisión y luego integrar | Que Review e Integration son dos decisiones distintas | Review ≠ Integration |
| C6 | Integrar con merge limpio, con conflicto y con error de identidad de git | Qué pasó y qué hacer (el error trae motivo, LXO-251) | Estados de Integration comprensibles |
| C7 | Pedir «abrir el PR» | Que la URL no se muestra por seguridad (LXO-244) | Límite explícito, sin sorpresa |

**Pregunta final obligatoria:** «¿Qué resultado aceptarías e integrarías y por qué? ¿Qué te faltó para decidirlo?» — anotar la respuesta literal, el número de pantallas visitadas y el tiempo hasta decidir.

## 6. Teclado y lectores de pantalla

Una pasada por sesión: recorrer B1, B2 y C5 **solo con teclado**. El criterio «teclado/ARIA con lector real» de LXO-150 sigue sin cumplirse porque hoy solo se probó con jsdom: si hay un lector de pantalla disponible, repetir B1 con él y anotar el resultado; si no, dejarlo **BLOCKED**.

## 7. Plantilla de evidencia (una por persona; copiar y rellenar)

```
Persona: D0_   Fecha: ____   SHA/build: ____   Perfil aislado: [sí/no]
Consentimiento: [sí/no]   Grabación: [sí/no/no solicitada]
Escenario | Modo (real / captura) | Resultado (PASS / PARTIAL / FAIL / BLOCKED) | Respuesta literal | Confusión observada
B1..B8 y C1..C7
Pregunta final B:    Pregunta final C:
Teclado: [PASS/FAIL/BLOCKED]   Lector de pantalla: [PASS/FAIL/BLOCKED]
Decisiones propuestas (a issues F5/F6):
```

## 8. Criterio de cierre

- **LXO-225:** B1–B8 y la pregunta final con **dos** personas, decisiones trasladadas a issues y resultado registrado en la issue.
- **LXO-226:** C1–C7 con un cambio pequeño y uno grande, con **dos** personas, decisiones trasladadas.
- Una issue **no se cierra** con este documento: sin las dos sesiones el estado es `NOT_RUN`. No se atribuye un PASS a fixtures, a pruebas automáticas ni a la validación de otro sprint (ver la corrección de LXO-224).
