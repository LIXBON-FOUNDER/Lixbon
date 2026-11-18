//! Agent Handoff (LXO-172, Trabajo 5 del epic F6): una persona traspasa el trabajo de un Attempt terminado a OTRO agente (u otra sesión del
//! mismo), llevando el contexto en un ContextPackage verificado. Contrato: `docs/core/HANDOFF.md`.
//!
//! ```text
//! attempt_handoff { task_id, from_attempt_id, provider, model?, effort?, instruction?, package_id? }
//!   1. Person autenticada; ids canónicos; el Attempt fuente es el ÚLTIMO de la Task y está terminado
//!   2. ¿ya existe el Attempt siguiente? -> si es un traspaso con esa intención, Replayed (no escribe nada)
//!   3. lanzador, ubicación del Project y preflight del proveedor RECEPTOR                <- antes de escribir
//!   4. el paquete: el guardado (`package_id`) o uno que el Core construye con la evidencia del worktree fuente
//!        -> `context_package::parse` (identidad + secretos) y `source` == este Attempt y este Project
//!   5. UNA mutación: Task `starting`/`pending_approval` + Attempt n+1 + `attempt.continued(context_package, package_id)`
//!   6. el despachador lo lanza (Desktop lo despierta; CLI espera la aprobación de una Person)
//! ```
//!
//! # Qué NO hace
//! * **No copia la ProviderSession**: el receptor arranca de cero (`session_ref` se borra) y solo tiene lo que dice el paquete.
//! * No toca el Attempt fuente (sigue accesible e inmutable: el Attempt nuevo es otra fila) ni su worktree.
//! * No elige el proveedor (`provider` es obligatorio), no amplía permisos (el perfil se hereda; `deny_unknown_fields` rechaza `profile`) y
//!   no integra nada.
//! * No acepta un Attempt activo como fuente: primero se detiene (`attempt_stop`) y se traspasa el resultado.
//!
//! # Lo que ve el receptor
//! El encargo de la Task gana un bloque delimitado (`HANDOFF_MARKER` … `HANDOFF_END`) con: el prompt de continuación del paquete (que ya dice
//! qué verificar y que `[redactado]` es a propósito), **qué viajó y qué se quedó fuera** (sesión, revisión ausente, campos truncados, adjuntos
//! omitidos, redacciones, pruebas sin evidencia) y, si la hubo, la instrucción de la persona. Un traspaso posterior SUSTITUYE el bloque
//! anterior (el paquete nuevo ya lo contiene): así los paquetes no se anidan unos dentro de otros.

use serde::Deserialize;
use serde_json::{json, Value};

use super::attempt_resume_rpc::clean_prompt;
use super::attempt_retry_rpc::{attempt_number, clean};
use super::context_package::{self, ContextPackage};
use super::events::{Channel, MutationContext};
use super::tx_ops::HandoffRequest;
use super::Core;
use crate::store::AttemptFollowUpKind;

/// Abre el bloque de traspaso del encargo.
pub(super) const HANDOFF_MARKER: &str = "\n\n---\nTraspaso de contexto:\n";
/// Lo cierra: lo que venga detrás (un «Seguimiento» posterior) no es del traspaso.
pub(super) const HANDOFF_END: &str = "\n---\nFin del traspaso\n";

pub(crate) const HANDOFF_NOT_AVAILABLE: &str = "traspasar un Attempt requiere el lifecycle de lanzamiento verificado";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HandoffInput {
    pub task_id: String,
    pub from_attempt_id: String,
    /// El receptor. Obligatorio: el Core nunca elige proveedor por la persona. Puede ser el mismo del Attempt fuente (sesión nueva).
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Qué quiere la persona que haga el receptor con ese contexto. Va detrás del paquete.
    #[serde(default)]
    pub instruction: Option<String>,
    /// Un paquete ya guardado (`context_package_build` / `context_package_import`) que la persona revisó. Sin él, el Core construye uno del
    /// worktree del Attempt fuente.
    #[serde(default)]
    pub package_id: Option<String>,
}

#[derive(Debug)]
pub(super) struct HandoffOutcome {
    /// `true`: se creó el Attempt (falta despertar al despachador). `false`: la petición ya se había atendido.
    pub requested: bool,
    pub attempt_id: String,
    pub package_id: String,
    pub provider_changed: bool,
    /// Qué viajó y qué se quedó fuera. `None` en un replay (se consulta con `context_package_get` + `context_package_preview`).
    pub transfer: Option<Value>,
}

/// El encargo sin los bloques de traspaso: lo que se pidió, no los paquetes que ya viajaron.
pub(super) fn without_handoff(spec: &str) -> String {
    let mut out = String::with_capacity(spec.len());
    let mut rest = spec;
    while let Some(start) = rest.find(HANDOFF_MARKER) {
        out.push_str(&rest[..start]);
        let after = &rest[start + HANDOFF_MARKER.len()..];
        match after.find(HANDOFF_END) {
            Some(end) => rest = &after[end + HANDOFF_END.len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn clean_instruction(raw: &Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let text = clean_prompt(raw).map_err(|e| e.replace("el mensaje", "la instrucción").replace("con que continúa la sesión", "para el receptor"))?;
    if text.contains(HANDOFF_MARKER) || text.contains(HANDOFF_END) {
        return Err("la instrucción contiene un delimitador reservado del traspaso".into());
    }
    Ok(Some(text))
}

/// Qué viajó y qué se quedó fuera, calculado SOBRE el paquete (no reinterpreta nada de lo que dice). Los códigos son un conjunto cerrado.
fn transfer_of(p: &ContextPackage, provider_from: &str, provider_to: &str) -> Value {
    let mut left_out = vec![json!({"code": "provider_session", "detail": "la sesión interna del proveedor nunca se copia: el receptor arranca de cero"})];
    match (&p.revision, &p.revision_absent_reason) {
        (None, reason) => left_out.push(json!({"code": "revision_absent", "detail": reason})),
        (Some(_), _) => {}
    }
    for t in &p.truncated {
        left_out.push(json!({"code": "truncated", "field": t.field, "original": t.original, "unit": t.unit}));
    }
    for a in p.attachments.iter().filter(|a| a.omitted.is_some()) {
        left_out.push(json!({"code": "attachment_omitted", "id": a.id, "detail": a.omitted}));
    }
    // Lo que se retiró a propósito: lo que redactó el paquete al construirse (`redactions`) y los marcadores que ya traían sus textos (un resumen
    // que el Core redactó al guardarlo llega al paquete ya redactado). Cada marcador es un valor que el receptor no verá.
    let hidden = (p.redactions as usize).max(p.to_json().matches(context_package::REDACTED).count());
    if hidden > 0 {
        left_out.push(json!({"code": "redacted", "count": hidden}));
    }
    if p.test_results.is_none() {
        left_out.push(json!({"code": "test_results_absent", "detail": "el paquete no trae evidencia de pruebas"}));
    }
    json!({
        "package_id": p.id(),
        "from_provider": provider_from,
        "to_provider": provider_to,
        "summary": super::context_preview::summary(p),
        "carried": {
            "objective": !p.objective.trim().is_empty(),
            "decisions": p.decisions.len(),
            "constraints": p.constraints.len(),
            "thread_summary": p.thread_summary.is_some(),
            "revision": p.revision.is_some(),
            "uncommitted": p.uncommitted.is_some(),
            "test_results": p.test_results.is_some(),
            "artifacts": p.artifacts.len(),
            "attachments": p.attachments.len(),
        },
        "left_out": left_out,
    })
}

/// Lo mismo que `transfer_of`, en el texto que lee el receptor.
fn transfer_text(transfer: &Value) -> String {
    let n = |path: &str| transfer["carried"][path].clone();
    let yes = |path: &str| if transfer["carried"][path] == json!(true) { "sí" } else { "no" };
    let mut out = format!(
        "QUÉ TE LLEGA: objetivo ({}), decisiones: {}, restricciones: {}, resumen del hilo ({}), revisión ({}), cambios sin commit ({}), pruebas ({}), artefactos: {}, adjuntos: {}.\n",
        yes("objective"),
        n("decisions"),
        n("constraints"),
        yes("thread_summary"),
        yes("revision"),
        yes("uncommitted"),
        yes("test_results"),
        n("artifacts"),
        n("attachments"),
    );
    out.push_str("QUÉ SE QUEDÓ FUERA:\n");
    for item in transfer["left_out"].as_array().into_iter().flatten() {
        let code = item["code"].as_str().unwrap_or("");
        let line = match code {
            "provider_session" => "la conversación interna del agente anterior (no se copia entre sesiones)".to_string(),
            "revision_absent" => format!("la revisión de git: {}", item["detail"].as_str().unwrap_or("no disponible")),
            "truncated" => format!("parte de `{}` (recortada: {} {} originales)", item["field"].as_str().unwrap_or("?"), item["original"], item["unit"].as_str().unwrap_or("")),
            "attachment_omitted" => format!("el adjunto {} ({})", item["id"].as_str().unwrap_or("?"), item["detail"].as_str().unwrap_or("omitido")),
            "redacted" => format!("{} valores con forma de credencial, redactados a propósito", item["count"]),
            "test_results_absent" => "evidencia de pruebas: no la hay, no asumas que pasan".to_string(),
            _ => continue,
        };
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// El bloque que se añade al encargo.
fn block_of(package: &ContextPackage, transfer: &Value, instruction: Option<&str>) -> String {
    let mut block = String::from(HANDOFF_MARKER);
    block.push_str(&package.continuation_prompt());
    block.push('\n');
    block.push_str(&transfer_text(transfer));
    if let Some(i) = instruction {
        block.push_str("\nINSTRUCCIÓN DE LA PERSONA:\n");
        block.push_str(i);
        block.push('\n');
    }
    block.push_str(HANDOFF_END);
    block
}

pub(super) fn handoff(core: &Core, context: &MutationContext, input: &HandoffInput) -> Result<HandoffOutcome, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err("traspasar un Attempt requiere una Person autenticada".into());
    }
    let from_n = attempt_number(&input.task_id, &input.from_attempt_id)?;
    let next_n = from_n.checked_add(1).ok_or_else(|| "Falta un id de Attempt válido".to_string())?;
    let provider = clean("provider", &Some(input.provider.clone()))?.ok_or_else(|| "provider no es válido".to_string())?;
    let model = clean("model", &input.model)?;
    let effort = clean("effort", &input.effort)?;
    let instruction = clean_instruction(&input.instruction)?;
    let wanted_package = clean("package_id", &input.package_id)?;

    let (current, project_id, current_provider, status_final) = {
        let st = core.lock();
        let task = st.tasks.get(&input.task_id).ok_or_else(|| format!("no existe la Task {}", input.task_id))?;
        let current = st.attempt_n.get(&input.task_id).copied().ok_or_else(|| "la Task no tiene ningún Attempt que traspasar".to_string())?;
        (current, task.project_id.clone(), task.agent.clone(), task.status.is_final())
    };

    // ¿Ya se atendió? Un replay no depende del estado actual ni del lanzador, y no escribe nada.
    if current == next_n {
        let next_id = format!("{}-a{current}", input.task_id);
        if core.attempt_follow_up_kind(&next_id)? != Some(AttemptFollowUpKind::Handoff) {
            return Err(format!("attempt_handoff_conflict: {next_id} no procede de un traspaso de {}", input.from_attempt_id));
        }
        let source = core.attempt_row_for_resume(&input.from_attempt_id)?.ok_or_else(|| format!("attempt_handoff_conflict: falta el Attempt fuente {}", input.from_attempt_id))?;
        let next = core.attempt_row_for_resume(&next_id)?.ok_or_else(|| format!("attempt_handoff_conflict: falta el Attempt creado {next_id}"))?;
        if source.task_id != input.task_id || source.n != i64::from(from_n) {
            return Err(format!("attempt_handoff_conflict: {} no es el origen durable esperado", input.from_attempt_id));
        }
        let same_provider = provider == source.provider;
        let expected_model = model.as_deref().or_else(|| if same_provider { source.model.as_deref() } else { None });
        let expected_effort = effort.as_deref().or_else(|| if same_provider { source.effort.as_deref() } else { None });
        let package_id = core.attempt_handoff_package_id(&next_id)?.ok_or_else(|| format!("attempt_handoff_conflict: {next_id} no dice con qué paquete nació"))?;
        if next.provider != provider
            || next.model.as_deref() != expected_model
            || next.effort.as_deref() != expected_effort
            || next.role != source.role
            || next.profile != source.profile
            || next.external != source.external
            || wanted_package.as_deref().is_some_and(|id| id != package_id)
        {
            return Err(format!("attempt_handoff_conflict: {next_id} ya existe con otra intención"));
        }
        return Ok(HandoffOutcome { requested: false, attempt_id: next_id, package_id, provider_changed: !same_provider, transfer: None });
    }
    if current != from_n {
        return Err(format!("solo se traspasa el último Attempt de la Task: el actual es {}-a{current}", input.task_id));
    }
    if !status_final {
        return Err("solo se traspasa un Attempt terminado: si sigue en marcha, detenlo primero (`attempt_stop`)".into());
    }
    if core.launcher().is_none() {
        return Err(HANDOFF_NOT_AVAILABLE.into());
    }
    // Lo que se comprobó al crear la Task pudo cambiar: se vuelve a mirar ANTES de escribir nada.
    let project_id = project_id.filter(|p| !p.is_empty()).ok_or_else(|| "la Task no tiene Project: no hay desde dónde lanzar".to_string())?;
    core.project_launch_location(&project_id)?;
    core.provider_start_preflight(&provider)?;

    // El paquete, verificado por la puerta de siempre. Si algo falla aquí no se escribe nada: el Attempt fuente queda como estaba.
    let package = match wanted_package.as_deref() {
        Some(id) => {
            let stored = super::context_store::stored_json(core, id)?.ok_or_else(|| format!("context_store_not_found: no hay el paquete {id}: se construye con `context_package_build`"))?;
            super::fork_runtime::checked_package(&stored, &input.task_id, &input.from_attempt_id, &project_id)?
        }
        None => {
            let built = super::context_store::build_and_store(core, &input.from_attempt_id)?;
            super::fork_runtime::checked_package(built.package.to_json(), &input.task_id, &input.from_attempt_id, &project_id)?
        }
    };

    let provider_changed = provider != current_provider;
    let transfer = transfer_of(&package, &current_provider, &provider);
    let request = HandoffRequest { provider, model, effort, block: block_of(&package, &transfer, instruction.as_deref()), package_id: package.id().to_string() };
    core.mutate_as(context, |tx| tx.request_attempt_handoff(&input.task_id, &request)).map_err(|e| e.to_string())?;
    Ok(HandoffOutcome { requested: true, attempt_id: format!("{}-a{next_n}", input.task_id), package_id: package.id().to_string(), provider_changed, transfer: Some(transfer) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_cliente_no_puede_pedir_perfil_worktree_ni_host() {
        let ok = serde_json::from_value::<HandoffInput>(json!({"task_id": "t2", "from_attempt_id": "t2-a1", "provider": "codex", "instruction": "sigue"}));
        assert!(ok.is_ok());
        for extra in ["profile", "worktree", "host", "package", "session"] {
            let mut v = json!({"task_id": "t2", "from_attempt_id": "t2-a1", "provider": "codex"});
            v[extra] = json!("x");
            assert!(serde_json::from_value::<HandoffInput>(v).is_err(), "{extra} no se acepta");
        }
        assert!(serde_json::from_value::<HandoffInput>(json!({"task_id": "t2", "from_attempt_id": "t2-a1"})).is_err(), "el receptor es obligatorio: el Core no elige");
    }

    #[test]
    fn un_traspaso_nuevo_sustituye_al_anterior_y_respeta_lo_demas() {
        let spec = format!("haz X{HANDOFF_MARKER}PAQUETE1{HANDOFF_END}{}\nsigue con Y", "\n\n---\nSeguimiento:");
        assert_eq!(without_handoff(&spec), "haz X\n\n---\nSeguimiento:\nsigue con Y");
        assert_eq!(without_handoff("haz X"), "haz X");
        // Dos bloques: se quitan los dos; uno sin cierre: se corta ahí.
        assert_eq!(without_handoff(&format!("a{HANDOFF_MARKER}1{HANDOFF_END}b{HANDOFF_MARKER}2{HANDOFF_END}c")), "abc");
        assert_eq!(without_handoff(&format!("a{HANDOFF_MARKER}sin cierre")), "a");
    }

    #[test]
    fn la_instruccion_no_puede_traer_los_delimitadores() {
        assert_eq!(clean_instruction(&None), Ok(None));
        assert_eq!(clean_instruction(&Some("  revisa los tests  ".into())), Ok(Some("revisa los tests".into())));
        for bad in [format!("a{HANDOFF_MARKER}b"), format!("a{HANDOFF_END}b"), format!("a{}b", super::super::dispatch::FOLLOW_UP_MARKER), "   ".to_string()] {
            assert!(clean_instruction(&Some(bad.clone())).is_err(), "{bad:?}");
        }
    }
}
