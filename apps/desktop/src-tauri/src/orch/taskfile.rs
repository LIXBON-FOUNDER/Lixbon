//! Ficha de la tarea (el encargo que recibe cada hija) y su regla de entrega sin red.

use super::{delivery, roles};
use super::state::Task;

pub(super) fn task_file(t: &Task, parent: Option<&Task>, objective: &str) -> String {
    let place = match (&t.branch, &t.worktree) {
        (Some(br), Some(_)) => format!(
            "Trabajas en tu propio worktree (`{}`), en la rama `{br}`, que sale de `{}`. Haz commit ahí de tu trabajo.",
            t.cwd,
            t.base.as_deref().unwrap_or("HEAD")
        ),
        _ => format!(
            "Trabajas en la carpeta compartida del coordinador (`{}`): no cambies de rama ni hagas commits salvo que tu encargo lo pida.",
            t.cwd
        ),
    };
    let coordinator = parent.map(|p| format!("{} ({})", p.id, p.agent)).unwrap_or_default();
    let report = format!(".lixbon/informe-{}.md", t.id);
    let role = t.role.as_deref().and_then(roles::spec);
    let read_only = role.is_some_and(|r| r.read_only);
    let role_line = role.map(|r| format!("Tu rol: **{}**. {}\n\n", r.label, r.purpose)).unwrap_or_default();
    let adversary_line = if role.is_some_and(|r| r.id == "adversario") {
        "Tu meta no es demostrar que funciona sino encontrar cómo se rompe. Puedes ejecutar tests y comandos para demostrar fallos, pero no edites nada. Tu informe es una lista de hallazgos numerados, del más grave al menos, y cada uno lleva: escenario concreto que lo rompe (entrada o estado -> resultado incorrecto), evidencia (ruta:línea, comando reproducible o test que falla) y la pregunta que el creador debe responder («¿por qué X y no Y?»). Sin elogios ni resumen de lo que está bien. Si no encuentras nada sólido, dilo y lista lo que intentaste.

"
    } else {
        ""
    };
    let final_message = t.last_message_path.is_some() || t.stream_json;
    let deliver = if final_message {
        let nonce = t.report_nonce.as_deref().unwrap_or("<nonce>");
        format!(
            "Tu informe es tu **mensaje final**: el host lo toma tal cual de la CLI, sin lxo done ni lxo report. \
Empieza tu último mensaje con la línea `LXO-RESULT nonce={nonce} status=done` (o `status=failed`), \
sigue con una línea de resumen y después el informe en markdown: qué encontraste, rutas con número de línea y qué queda. \
No modifiques archivos."
        )
    } else if t.agent == "claude" && !read_only {
        format!(
            "Escribe tu informe en `{report}` (qué hiciste, archivos, cómo lo verificaste, qué queda y decisiones pendientes) \
y cierra con `lxo report --report {report} --summary \"<una frase>\"`: es la única orden de lxo que tienes permitida sin pedir permiso."
        )
    } else if read_only {
        format!(
            "Eres de **solo lectura**: no tienes Edit ni Write y no debes modificar archivos (tampoco con Bash). \
Tu informe va por la entrada estándar, sin archivo:\n\n\
```\nlxo done --summary \"<una frase>\" --report - <<'EOF'\n# {id} · {title}\n## Resultado\n...\nEOF\n```\n\n\
Sé breve: tu coordinador paga cada línea que lee. Rutas con número de línea y conclusiones; \
nada de copiar bloques de código salvo las pocas líneas imprescindibles.",
            id = t.id,
            title = t.title,
        )
    } else {
        format!(
            "Escribe tu informe en `{report}` (qué hiciste, archivos, cómo lo verificaste, qué queda y decisiones pendientes) \
y cierra con `lxo done --report {report} --summary \"<una frase>\"`."
        )
    };
    format!(
        "# {id} · {title}\n\n\
Eres la tarea **{id}** del run {run}. Te coordina **{coordinator}**, que es quien habla con el usuario.\n\
Objetivo general: {objective}\n\n\
{role_line}{adversary_line}{place}\n\n\
## Tu encargo\n\n{spec}\n\n\
## Reglas\n\n\
1. Ejecuta `lxo guide` y síguela. Eres autónomo: nadie mira tu terminal para aprobar nada.\n\
2. Informa de tus fases: `lxo phase \"<nombre>\" --start` y `lxo phase \"<nombre>\" --done --note \"<resultado>\"`.\n\
3. Si solo tu coordinador puede decidir algo: `lxo ask \"<pregunta>\"` y espera. Nunca abras preguntas interactivas.\n\
4. En cada punto de control ejecuta `lxo check` por si tu coordinador te mandó instrucciones.\n\
5. Al acabar: {deliver} Si no se pudo completar, añade `--failed`. Después no hagas nada más.\n{offline}",
        offline = if final_message { String::new() } else { offline_rule(t) },
        id = t.id,
        title = t.title,
        run = t.run,
        spec = t.spec,
    )
}

/// Regla de entrega sin red para la ficha de la tarea (contrato de informe por archivo).
pub(super) fn offline_rule(t: &Task) -> String {
    let Some(nonce) = &t.report_nonce else { return String::new() };
    format!(
        "6. **Sin red** (sandbox de Codex: `lxo` no conecta con el host): no reintentes `lxo done`; entrega con \
`lxo report --summary \"<una frase>\" --report <informe.md o ->` (mismas opciones `--failed` y `--files`). \
Si puede escribir, deja `{path}` y basta. Si no puede, imprime un bloque `<<<LXO-REPORT v1 nonce={nonce} …>>>`: \
cópialo **tal cual y completo** al final de tu respuesta. Fases, preguntas y `lxo check` no llegan sin red: sigue sin ellos.\n",
        path = delivery::report_path(&t.cwd, &t.id, delivery::ATTEMPT).display(),
    )
}
