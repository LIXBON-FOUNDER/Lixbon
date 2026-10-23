//! LXO-92 · Activity humana desde el Event Log: tabla Event kind -> clave, respaldo, trazabilidad, cursor y
//! reconexión, sin secretos, permisos y flujo real del Core.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{json, Value};

use super::activity_format::{item, KINDS, UNKNOWN_KEY};
use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::events::Channel;
use super::state::NewTask;
use super::{Caller, Core};
use crate::store::{new_project_id, ActorKind, EventClass, EventRow, NewEvent};

const SECRETO: &str = "SENTINEL-SECRETO-no-debe-salir-9f3a";

fn fila(seq: i64, kind: &str, class: EventClass, entity: (&str, &str), payload: Value) -> EventRow {
    EventRow {
        seq,
        id: format!("ev-{seq}"),
        at: 1_760_000_000_000 + seq,
        v: 1,
        kind: kind.into(),
        class,
        actor_kind: ActorKind::Person,
        actor_id: Some("user".into()),
        channel: Some("ui".into()),
        client_id: Some("client-1".into()),
        project_id: Some("proj-1".into()),
        run_id: Some("run-1".into()),
        entity_kind: entity.0.into(),
        entity_id: entity.1.into(),
        correlation_id: None,
        idem_key: None,
        state_rev: Some(7),
        payload: payload.to_string(),
    }
}

/// (kind, clase, entidad, payload, clave esperada, énfasis visual esperado)
type Caso = (
    &'static str,
    EventClass,
    (&'static str, &'static str),
    Value,
    &'static str,
    &'static str,
);

fn estado(from: &str, to: &str) -> Value {
    json!({ "from": from, "to": to })
}

fn merge(outcome: &str) -> Value {
    json!({ "decision_kind": "merge", "decision_id": 4, "outcome": outcome, "branch": "lxo/t-7", "squash": false })
}

fn resolved(outcome: &str) -> Value {
    json!({ "outcome": outcome, "has_reason": false })
}

fn casos() -> Vec<Caso> {
    use EventClass::{Decision, Effect, State};
    let t = ("task", "t-7");
    let p = ("project", "proj-1");
    let s = ("spawn_request", "pend-1");
    let a = ("agent", "claude");
    let at = ("attention", "att_1");
    vec![
        // state · run
        (
            "run.created",
            State,
            ("run", "run-1"),
            json!({ "root_task": "t-1" }),
            "activity.run.created",
            "info",
        ),
        (
            "run.closed",
            State,
            ("run", "run-1"),
            json!({ "forced": false, "stopped": [], "stopped_total": 0 }),
            "activity.run.closed",
            "info",
        ),
        (
            "run.removed",
            State,
            ("run", "run-1"),
            json!({ "tasks": 3 }),
            "activity.run.removed",
            "info",
        ),
        // state · task
        (
            "task.created",
            State,
            t,
            json!({ "parent": "t-1", "depth": 1, "agent": "claude", "role": null, "model": "claude-opus-4", "title": "Migrar la tabla", "external": false }),
            "activity.task.created",
            "info",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("waiting", "starting"),
            "activity.task.starting",
            "info",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("starting", "running"),
            "activity.task.running",
            "info",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("running", "waiting"),
            "activity.task.waiting",
            "info",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("running", "awaiting_terminal_approval"),
            "activity.task.awaiting_terminal_approval",
            "warning",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("running", "done"),
            "activity.task.done",
            "success",
        ),
        (
            "task.status_changed",
            State,
            t,
            json!({ "from": "running", "to": "failed", "cause": "agent_idle_timeout" }),
            "activity.task.failed",
            "error",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("running", "stopped"),
            "activity.task.stopped",
            "warning",
        ),
        (
            "task.status_changed",
            State,
            t,
            estado("running", "exited"),
            "activity.task.exited",
            "error",
        ),
        (
            "task.phase",
            State,
            t,
            json!({ "name": "tests", "done": true }),
            "activity.task.phase_done",
            "info",
        ),
        (
            "task.phase",
            State,
            t,
            json!({ "name": "tests", "done": false }),
            "activity.task.phase_started",
            "info",
        ),
        (
            "task.question",
            State,
            t,
            json!({ "message_id": 5, "to": "t-1" }),
            "activity.task.question",
            "warning",
        ),
        (
            "task.reply",
            State,
            t,
            json!({ "question_id": 5, "message_id": 6 }),
            "activity.task.reply",
            "info",
        ),
        (
            "task.removed",
            State,
            t,
            json!({ "cause": "launch_failed" }),
            "activity.task.removed",
            "warning",
        ),
        (
            "task.review_requested",
            State,
            t,
            json!({ "branch": "lxo/t-7" }),
            "activity.task.review_requested",
            "info",
        ),
        // state/decision · Task como intención (LXO-113)
        (
            "task.updated",
            State,
            t,
            json!({ "changed": ["title", "spec"], "title": "API de sesiones" }),
            "activity.task.updated",
            "info",
        ),
        (
            "task.removed",
            State,
            t,
            json!({ "cause": "unused" }),
            "activity.task.removed",
            "warning",
        ),
        ("task.discarded", Decision, t, json!({}), "activity.task.discarded", "warning"),
        ("task.restored", Decision, t, json!({}), "activity.task.restored", "info"),
        // state/decision · Attempt (LXO-114)
        (
            "attempt.requested",
            State,
            ("attempt", "t-7-a2"),
            json!({ "task": "t-7", "n": 2, "provider": "claude", "model": "claude-opus-5-5", "external": false, "approval_required": true }),
            "activity.attempt.requested",
            "info",
        ),
        ("attempt.approved", Decision, ("attempt", "t-7-a2"), json!({ "task": "t-7", "n": 2 }), "activity.attempt.approved", "success"),
        ("attempt.rejected", Decision, ("attempt", "t-7-a2"), json!({ "task": "t-7", "n": 2, "cause": "cancelled" }), "activity.attempt.rejected", "warning"),
        ("attempt.started", State, ("attempt", "t-7-a2"), json!({ "task": "t-7", "n": 2 }), "activity.attempt.started", "info"),
        ("attempt.completed", State, ("attempt", "t-7-a2"), json!({ "task": "t-7", "n": 2, "has_summary": true }), "activity.attempt.completed", "success"),
        (
            "attempt.failed",
            State,
            ("attempt", "t-7-a2"),
            json!({ "task": "t-7", "n": 2, "reason": "agent_idle_timeout", "has_summary": false }),
            "activity.attempt.failed",
            "error",
        ),
        (
            "attempt.stopped",
            State,
            ("attempt", "t-7-a2"),
            json!({ "task": "t-7", "n": 2, "from": "running", "cause": "run_closed" }),
            "activity.attempt.stopped",
            "warning",
        ),
        (
            "provider_session.opened",
            State,
            ("provider_session", "ps-t-7-a2"),
            json!({ "task": "t-7", "attempt": "t-7-a2", "n": 2, "provider": "claude", "resumable": true, "bound": false }),
            "activity.provider_session.opened",
            "info",
        ),
        ("provider_session.bound", State, ("provider_session", "ps-t-7-a2"), json!({ "task": "t-7", "binding": "stream_json" }), "activity.provider_session.bound", "info"),
        ("provider_session.resumed", State, ("provider_session", "ps-t-7-a2"), json!({ "task": "t-7", "attempt": "t-7-a3", "n": 3 }), "activity.provider_session.resumed", "info"),
        ("provider_session.detached", State, ("provider_session", "ps-t-7-a2"), json!({ "task": "t-7" }), "activity.provider_session.detached", "info"),
        ("provider_session.closed", State, ("provider_session", "ps-t-7-a2"), json!({ "task": "t-7", "from": "idle" }), "activity.provider_session.closed", "info"),
        ("thread.created", State, ("thread", "th-t-7"), json!({ "task": "t-7" }), "activity.thread.created", "info"),
        ("thread.summarized", State, ("thread", "th-t-7"), json!({ "task": "t-7", "has_summary": true }), "activity.thread.summarized", "info"),
        ("worktree.created", State, ("worktree", "wt-t-7-a2"), json!({ "task": "t-7", "attempt": "t-7-a2", "n": 2, "branch": "lx/r1/t-7-api" }), "activity.worktree.created", "info"),
        (
            "worktree.adopted",
            State,
            ("worktree", "wt-t-7-a2"),
            json!({ "task": "t-7", "attempt": "t-7-a2", "n": 2, "provenance": "external" }),
            "activity.worktree.adopted",
            "info",
        ),
        ("worktree.attached", State, ("worktree", "wt-t-7-a2"), json!({ "task": "t-7", "attempt": "t-7-a3", "n": 3 }), "activity.worktree.attached", "info"),
        ("worktree.missing", State, ("worktree", "wt-t-7-a2"), json!({ "task": "t-7" }), "activity.worktree.missing", "warning"),
        ("worktree.found", State, ("worktree", "wt-t-7-a2"), json!({ "task": "t-7" }), "activity.worktree.found", "info"),
        ("worktree.removed", State, ("worktree", "wt-t-7-a2"), json!({ "task": "t-7", "reason": "integrated", "branch_kept": false }), "activity.worktree.removed", "info"),
        (
            "artifact.created",
            State,
            ("artifact", "0192f0aa-0000-7000-8000-000000000001"),
            json!({ "task": "t-7", "attempt": "t-7-a2", "n": 2, "kind": "pull_request", "verifiable": false }),
            "activity.artifact.created",
            "info",
        ),
        // decision
        (
            "decision.recorded",
            Decision,
            t,
            json!({ "decision_kind": "review", "decision_id": 1, "outcome": "accepted", "head_commit": "abc", "has_comment": true }),
            "activity.decision.review.accepted",
            "success",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            json!({ "decision_kind": "review", "decision_id": 2, "outcome": "rejected", "head_commit": "abc", "has_comment": false }),
            "activity.decision.review.rejected",
            "warning",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            merge("merged"),
            "activity.decision.merge.merged",
            "success",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            merge("conflict"),
            "activity.decision.merge.conflict",
            "error",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            merge("error"),
            "activity.decision.merge.error",
            "error",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            merge("target_moved"),
            "activity.decision.merge.target_moved",
            "warning",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            json!({ "decision_kind": "pr", "decision_id": 5, "outcome": "created", "branch": "lxo/t-7", "pr_url": "https://example.test/pr/1" }),
            "activity.decision.pr.created",
            "success",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            json!({ "decision_kind": "pr", "decision_id": 6, "outcome": "already_exists", "branch": "lxo/t-7" }),
            "activity.decision.pr.already_exists",
            "info",
        ),
        (
            "decision.recorded",
            Decision,
            t,
            json!({ "decision_kind": "pr", "decision_id": 7, "outcome": "error", "branch": "lxo/t-7" }),
            "activity.decision.pr.error",
            "error",
        ),
        // effect
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_merge", "effect_id": "eff-1", "operation": "integrate", "result": "merged", "branch": "lxo/t-7" }),
            "activity.effect.git_merge.merged",
            "success",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_merge", "effect_id": "eff-2", "operation": "integrate", "result": "conflict", "branch": "lxo/t-7" }),
            "activity.effect.git_merge.conflict",
            "error",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_merge", "effect_id": "eff-3", "operation": "integrate", "result": "error", "branch": "lxo/t-7" }),
            "activity.effect.git_merge.error",
            "error",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_push_pr", "effect_id": "eff-4", "operation": "publish", "result": "created", "branch": "lxo/t-7", "pr_url": "https://example.test/pr/1" }),
            "activity.effect.git_push_pr.created",
            "success",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_push_pr", "effect_id": "eff-5", "operation": "publish", "result": "already_exists", "branch": "lxo/t-7" }),
            "activity.effect.git_push_pr.already_exists",
            "info",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_push_pr", "effect_id": "eff-6", "operation": "publish", "result": "error", "branch": "lxo/t-7" }),
            "activity.effect.git_push_pr.error",
            "error",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_worktree", "effect_id": "eff-7", "operation": "spawn", "branch": "lxo/t-7", "base": "main" }),
            "activity.effect.git_worktree.created",
            "info",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "git_worktree_removed", "effect_id": "eff-8", "operation": "release", "worktree_removed": true, "branch": "lxo/t-7", "branch_deleted": true }),
            "activity.effect.git_worktree.removed",
            "info",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "pty_process", "effect_id": "eff-9", "operation": "launch", "launched": true }),
            "activity.effect.process.launched",
            "info",
        ),
        (
            "effect.observed",
            Effect,
            t,
            json!({ "effect_kind": "pty_process", "effect_id": "eff-10", "operation": "launch", "launched": false }),
            "activity.effect.process.not_launched",
            "warning",
        ),
        // project
        (
            "project.registered",
            State,
            p,
            json!({ "origin": "manual", "name": "lixbon", "has_remote": true, "root_commit_count": 1 }),
            "activity.project.registered",
            "info",
        ),
        (
            "project.location_added",
            Decision,
            p,
            json!({ "primary": true, "fingerprint_adopted": false }),
            "activity.project.location_added",
            "info",
        ),
        (
            "project.archived",
            Decision,
            p,
            json!({}),
            "activity.project.archived",
            "info",
        ),
        (
            "project.restored",
            Decision,
            p,
            json!({}),
            "activity.project.restored",
            "info",
        ),
        (
            "project.relocated",
            Decision,
            p,
            json!({ "fingerprint_adopted": false, "confirmed_mismatch": false }),
            "activity.project.relocated",
            "info",
        ),
        // spawn
        (
            "spawn.requested",
            State,
            s,
            json!({ "parent_task": "t-1", "provider": "claude", "profile": "default", "title": "Escribir pruebas", "shared": false, "policy_status": "ok", "expires_at": 1 }),
            "activity.spawn.requested",
            "info",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            json!({ "outcome": "approved", "task": "t-9", "has_reason": false }),
            "activity.spawn.approved",
            "success",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            resolved("rejected"),
            "activity.spawn.rejected",
            "warning",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            resolved("launch_failed"),
            "activity.spawn.launch_failed",
            "error",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            resolved("timeout"),
            "activity.spawn.timeout",
            "warning",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            resolved("coordinator_closed"),
            "activity.spawn.coordinator_closed",
            "info",
        ),
        (
            "spawn.resolved",
            Decision,
            s,
            resolved("cancelled_run_removed"),
            "activity.spawn.cancelled_run_removed",
            "info",
        ),
        // environment
        (
            "environment.blocked",
            State,
            a,
            json!({ "profile": "read_only", "code": "cli_missing" }),
            "activity.environment.blocked",
            "warning",
        ),
        (
            "environment.cleared",
            State,
            a,
            json!({ "profile": "read_only", "code": "cli_missing" }),
            "activity.environment.cleared",
            "success",
        ),
        // attention (hechos del ciclo de vida; no es la lista de Attention)
        (
            "attention.risk_acted",
            Decision,
            at,
            json!({ "resolution": "acted" }),
            "activity.attention.risk_acted",
            "info",
        ),
        (
            "attention.created",
            State,
            at,
            json!({ "category": "failed", "severity": "high", "occurrence": 1, "target_kind": "task", "target_id": "t-7" }),
            "activity.attention.created",
            "info",
        ),
        (
            "attention.resolved",
            State,
            at,
            json!({ "resolution": "condition_cleared", "source_event_id": "ev-1" }),
            "activity.attention.resolved",
            "info",
        ),
    ]
}

/// Snapshot de las claves de mensaje: cambiar una clave publicada rompe a los clientes que la traducen.
/// Si cambia a propósito, se actualiza esta lista y `docs/core/ACTIVITY.md` en el mismo PR.
const CLAVES: [&str; 79] = [
    "activity.artifact.created",
    "activity.attempt.approved",
    "activity.attempt.completed",
    "activity.attempt.failed",
    "activity.attempt.rejected",
    "activity.attempt.requested",
    "activity.attempt.started",
    "activity.attempt.stopped",
    "activity.attention.created",
    "activity.attention.resolved",
    "activity.attention.risk_acted",
    "activity.decision.merge.conflict",
    "activity.decision.merge.error",
    "activity.decision.merge.merged",
    "activity.decision.merge.target_moved",
    "activity.decision.pr.already_exists",
    "activity.decision.pr.created",
    "activity.decision.pr.error",
    "activity.decision.review.accepted",
    "activity.decision.review.rejected",
    "activity.effect.git_merge.conflict",
    "activity.effect.git_merge.error",
    "activity.effect.git_merge.merged",
    "activity.effect.git_push_pr.already_exists",
    "activity.effect.git_push_pr.created",
    "activity.effect.git_push_pr.error",
    "activity.effect.git_worktree.created",
    "activity.effect.git_worktree.removed",
    "activity.effect.process.launched",
    "activity.effect.process.not_launched",
    "activity.environment.blocked",
    "activity.environment.cleared",
    "activity.project.archived",
    "activity.project.location_added",
    "activity.project.registered",
    "activity.project.relocated",
    "activity.project.restored",
    "activity.provider_session.bound",
    "activity.provider_session.closed",
    "activity.provider_session.detached",
    "activity.provider_session.opened",
    "activity.provider_session.resumed",
    "activity.run.closed",
    "activity.run.created",
    "activity.run.removed",
    "activity.spawn.approved",
    "activity.spawn.cancelled_run_removed",
    "activity.spawn.coordinator_closed",
    "activity.spawn.launch_failed",
    "activity.spawn.rejected",
    "activity.spawn.requested",
    "activity.spawn.timeout",
    "activity.task.awaiting_terminal_approval",
    "activity.task.created",
    "activity.task.discarded",
    "activity.task.done",
    "activity.task.exited",
    "activity.task.failed",
    "activity.task.intent_created",
    "activity.task.phase_done",
    "activity.task.phase_started",
    "activity.task.question",
    "activity.task.removed",
    "activity.task.reply",
    "activity.task.restored",
    "activity.task.review_requested",
    "activity.task.running",
    "activity.task.starting",
    "activity.task.stopped",
    "activity.task.updated",
    "activity.task.waiting",
    "activity.thread.created",
    "activity.thread.summarized",
    "activity.worktree.adopted",
    "activity.worktree.attached",
    "activity.worktree.created",
    "activity.worktree.found",
    "activity.worktree.missing",
    "activity.worktree.removed",
];

#[test]
fn la_tabla_event_kind_a_clave_cubre_todos_los_casos_y_fija_las_claves() {
    let mut vistas = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for (n, (kind, class, entity, payload, clave, visual)) in casos().into_iter().enumerate() {
        let item = item(&fila(n as i64 + 1, kind, class, entity, payload));
        assert_eq!(
            item["fallback"], false,
            "{kind} -> {clave} no debe caer al respaldo"
        );
        assert_eq!(item["message_key"], clave, "clave de {kind}");
        assert_eq!(item["visual"], visual, "énfasis de {clave}");
        vistas.insert(clave.to_string());
        kinds.insert(kind);
    }
    // `task.created` v2 (Task como intención, LXO-113): el mismo kind con otra versión tiene su propia clave.
    let mut v2 = fila(999, "task.created", EventClass::State, ("task", "t-8"), json!({ "parent": "t-7", "depth": 1, "title": "API" }));
    v2.v = 2;
    let v2 = item(&v2);
    assert_eq!((v2["fallback"].as_bool(), v2["message_key"].as_str()), (Some(false), Some("activity.task.intent_created")));
    vistas.insert("activity.task.intent_created".to_string());
    assert_eq!(
        vistas,
        CLAVES
            .iter()
            .map(|c| c.to_string())
            .collect::<BTreeSet<_>>(),
        "snapshot de claves de mensaje"
    );
    assert_eq!(
        kinds,
        KINDS.iter().copied().collect::<BTreeSet<_>>(),
        "cada kind formateable tiene al menos un caso"
    );
}

#[test]
fn cada_kind_declarado_en_event_kinds_tiene_formateador() {
    const FUENTE: &str = include_str!("event_kinds.rs");
    let marca = "const KIND: &'static str = \"";
    let declarados: BTreeSet<&str> = FUENTE
        .match_indices(marca)
        .filter_map(|(i, _)| FUENTE[i + marca.len()..].split('"').next())
        .collect();
    assert!(
        declarados.len() >= 20,
        "se leyeron los kinds de event_kinds.rs: {declarados:?}"
    );
    for kind in &declarados {
        assert!(KINDS.contains(kind), "el kind `{kind}` de event_kinds.rs no tiene formateador de Activity: añádelo a activity_format.rs");
    }
}

#[test]
fn el_argumento_que_hace_legible_el_hecho_viaja_sin_el_resto_del_payload() {
    let creada = item(&fila(
        1,
        "task.created",
        EventClass::State,
        ("task", "t-7"),
        json!({ "parent": "t-1", "depth": 1, "agent": "claude", "role": "implementador", "model": "claude-opus-4", "title": "Migrar\nla tabla", "external": false }),
    ));
    assert_eq!(
        creada["args"],
        json!({ "title": "Migrar la tabla", "agent": "claude", "role": "implementador", "model": "claude-opus-4", "parent": "t-1", "depth": 1, "external": false })
    );
    let fallida = item(&fila(
        2,
        "task.status_changed",
        EventClass::State,
        ("task", "t-7"),
        json!({ "from": "running", "to": "failed", "cause": "agent_idle_timeout" }),
    ));
    assert_eq!(
        fallida["args"],
        json!({ "from": "running", "to": "failed", "cause": "agent_idle_timeout" })
    );
    let largo = item(&fila(
        3,
        "task.created",
        EventClass::State,
        ("task", "t-8"),
        json!({ "depth": 0, "agent": "claude", "title": "x".repeat(500), "external": true }),
    ));
    assert_eq!(
        largo["args"]["title"].as_str().unwrap().chars().count(),
        120,
        "el título se recorta"
    );
}

#[test]
fn un_kind_desconocido_cae_al_respaldo_sin_romper_ni_copiar_el_payload() {
    let futuro = item(&fila(
        9,
        "task.teleported",
        EventClass::State,
        ("task", "t-7"),
        json!({ "secreto": SECRETO, "to": "mars" }),
    ));
    assert_eq!(futuro["fallback"], true);
    assert_eq!(futuro["message_key"], UNKNOWN_KEY);
    assert_eq!(
        futuro["args"],
        json!({ "reason": "unknown_kind", "kind": "task.teleported", "event_version": 1 })
    );
    assert_eq!(futuro["seq"], 9, "sigue siendo trazable al evento origen");
    assert_eq!(futuro["target"], json!({ "kind": "task", "id": "t-7" }));
    assert!(
        !futuro.to_string().contains(SECRETO),
        "el payload no se copia al respaldo"
    );
}

#[test]
fn version_no_soportada_y_payload_ilegible_caen_al_respaldo_con_su_motivo() {
    let mut nueva_version = fila(
        1,
        "task.status_changed",
        EventClass::State,
        ("task", "t-7"),
        estado("running", "failed"),
    );
    nueva_version.v = 2;
    assert_eq!(
        item(&nueva_version)["args"]["reason"],
        "unsupported_version"
    );

    let mut no_json = fila(
        2,
        "task.status_changed",
        EventClass::State,
        ("task", "t-7"),
        json!({}),
    );
    no_json.payload = format!("esto no es json {SECRETO}");
    let no_json = item(&no_json);
    assert_eq!(no_json["args"]["reason"], "invalid_payload");
    assert!(!no_json.to_string().contains(SECRETO));

    for payload in [
        json!({ "from": "running" }),
        json!({ "from": "running", "to": SECRETO }),
        json!({ "from": 3, "to": "failed" }),
    ] {
        let roto = item(&fila(
            3,
            "task.status_changed",
            EventClass::State,
            ("task", "t-7"),
            payload,
        ));
        assert_eq!(roto["fallback"], true);
        assert_eq!(roto["args"]["reason"], "invalid_payload");
        assert!(
            !roto.to_string().contains(SECRETO),
            "un código cerrado inválido no se copia"
        );
    }
    let sin_decision = item(&fila(
        4,
        "decision.recorded",
        EventClass::Decision,
        ("task", "t-7"),
        json!({ "decision_kind": "futura", "outcome": "merged" }),
    ));
    assert_eq!(
        sin_decision["args"]["reason"], "invalid_payload",
        "un decision_kind nuevo no rompe la timeline"
    );
}

#[test]
fn un_campo_obligatorio_ausente_no_deja_un_item_incompleto() {
    let sin_titulo = item(&fila(
        1,
        "task.created",
        EventClass::State,
        ("task", "t-7"),
        json!({ "depth": 0, "agent": "claude", "external": true }),
    ));
    assert_eq!(sin_titulo["fallback"], true);
    let sin_rama = item(&fila(
        2,
        "decision.recorded",
        EventClass::Decision,
        ("task", "t-7"),
        json!({ "decision_kind": "merge", "decision_id": 1, "outcome": "merged", "squash": false }),
    ));
    assert_eq!(sin_rama["fallback"], true);
}

#[test]
fn ningun_secreto_del_payload_llega_al_texto_humano() {
    let con_extras = |kind: &str, class: EventClass, entity, mut payload: Value| {
        for campo in [
            "token", "api_key", "argv", "env", "password", "report", "spec", "comment", "cwd",
            "path", "error",
        ] {
            payload[campo] = json!(SECRETO);
        }
        item(&fila(1, kind, class, entity, payload))
    };
    for (kind, class, entity, payload, clave, _) in casos() {
        let item = con_extras(kind, class, entity, payload);
        assert_eq!(
            item["message_key"], clave,
            "los campos extra no cambian la proyección de {kind}"
        );
        assert!(
            !item.to_string().contains(SECRETO),
            "{kind} copió un campo fuera de la lista cerrada"
        );
    }
    // El enlace del PR no se copia: solo se dice que existe.
    let pr = item(&fila(
        2,
        "decision.recorded",
        EventClass::Decision,
        ("task", "t-7"),
        json!({ "decision_kind": "pr", "decision_id": 5, "outcome": "created", "branch": "b", "pr_url": format!("https://x.test/{SECRETO}") }),
    ));
    assert_eq!(pr["args"]["has_pr_url"], true);
    assert!(!pr.to_string().contains(SECRETO));
}

#[test]
fn proyecto_task_y_actor_salen_de_las_columnas_no_del_payload() {
    let mut e = fila(
        1,
        "task.status_changed",
        EventClass::State,
        ("task", "t-real"),
        json!({ "from": "running", "to": "failed", "project_id": "p-falso", "task": "t-falsa", "actor": "otro", "path": "/ruta/de/otro/proyecto" }),
    );
    e.actor_kind = ActorKind::Agent;
    e.actor_id = Some("t-real".into());
    e.project_id = Some("p-real".into());
    e.channel = Some("lxo".into());
    e.client_id = Some("client-real".into());
    let item = item(&e);
    assert_eq!(item["project_id"], "p-real");
    assert_eq!(item["target"], json!({ "kind": "task", "id": "t-real" }));
    assert_eq!(item["actor"], json!({ "kind": "agent", "id": "t-real" }));
    assert_eq!(
        item["provenance"],
        json!({ "channel": "lxo", "client_id": "client-real" })
    );
    assert!(!item.to_string().contains("falso") && !item.to_string().contains("/ruta/"));
}

#[test]
fn cada_item_apunta_a_su_evento_origen() {
    let mut e = fila(
        77,
        "task.status_changed",
        EventClass::State,
        ("task", "t-7"),
        estado("running", "done"),
    );
    e.id = "0192f0a0-7b1c-7000-8000-0000000000a1".into();
    e.correlation_id = Some("corr-1".into());
    let item = item(&e);
    assert_eq!(item["seq"], 77);
    assert_eq!(item["event_id"], "0192f0a0-7b1c-7000-8000-0000000000a1");
    assert_eq!(item["kind"], "task.status_changed");
    assert_eq!(item["v"], 1);
    assert_eq!(item["class"], "state");
    assert_eq!(item["ts"], e.at);
    assert_eq!(item["correlation_id"], "corr-1");
}

#[test]
fn decision_y_efecto_correlacionados_salen_como_dos_hechos_sin_perder_trazabilidad() {
    let mut efecto = fila(
        9,
        "effect.observed",
        EventClass::Effect,
        ("task", "t-7"),
        json!({ "effect_kind": "git_merge", "effect_id": "eff-1", "operation": "integrate", "result": "conflict", "branch": "lxo/t-7" }),
    );
    efecto.correlation_id = Some("eff-1".into());
    let mut decision = fila(
        10,
        "decision.recorded",
        EventClass::Decision,
        ("task", "t-7"),
        merge("conflict"),
    );
    decision.correlation_id = Some("eff-1".into());
    let (a, b) = (item(&efecto), item(&decision));
    assert_ne!(a["seq"], b["seq"], "dos hechos, dos items");
    assert_eq!(
        a["correlation_id"], b["correlation_id"],
        "el cliente puede plegarlos por correlation_id"
    );
    assert_eq!(a["message_key"], "activity.effect.git_merge.conflict");
    assert_eq!(b["message_key"], "activity.decision.merge.conflict");
    assert_eq!(
        (a["visual"].as_str(), b["visual"].as_str()),
        (Some("error"), Some("error")),
        "el conflicto no se oculta"
    );
}

#[test]
fn varios_fallos_seguidos_no_se_comprimen() {
    let items: Vec<Value> = (1..=10)
        .map(|n| {
            item(&fila(
                n,
                "task.status_changed",
                EventClass::State,
                ("task", &format!("t-{n}")),
                estado("running", "failed"),
            ))
        })
        .collect();
    assert_eq!(items.len(), 10);
    assert!(items
        .iter()
        .all(|i| i["message_key"] == "activity.task.failed" && i["visual"] == "error"));
    let seqs: Vec<_> = items.iter().map(|i| i["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, (1..=10).collect::<Vec<_>>());
}

// ---------------------------------------------------------------------------------------------
// Contra el Core real
// ---------------------------------------------------------------------------------------------

fn tarea(core: &Core, titulo: &str, spec: &str) -> String {
    core.mutate(|tx| {
        let (_run, root) = tx.create_run(
            "objetivo del run",
            NewTask {
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: titulo.into(),
                spec: spec.into(),
                repo: "repo".into(),
                cwd: "cwd".into(),
                branch: None,
                base: None,
                worktree: None,
                external: true,
            },
        );
        tx.mark_running(&root)?;
        // La hija es la que pregunta y falla: una raíz no tiene a quién preguntar.
        let hija = tx.add_child(
            &root,
            1,
            NewTask {
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: format!("{titulo}-hija"),
                spec: spec.into(),
                repo: "repo".into(),
                cwd: "cwd".into(),
                branch: None,
                base: None,
                worktree: None,
                external: false,
            },
        )?;
        tx.mark_running(&hija)?;
        Ok(hija)
    })
    .unwrap()
}

fn falla(core: &Core, task: &str) {
    core.mutate(|tx| {
        tx.fail_with(task, "agent_idle_timeout", "sin actividad")
            .map(|_| ())
    })
    .unwrap();
}

fn person(core: &Core) -> crate::store::AuthenticatedClient {
    persona(
        core,
        "person-activity",
        "install-person-activity",
        "person-activity-secret-0123456789abcdef",
    )
}

fn lista(core: &Arc<Core>, person: &crate::store::AuthenticatedClient, args: Value) -> Value {
    rpc(core, person, "activity_list", args)
        .expect("activity_list responde a una Person autenticada")
}

fn seqs(page: &Value) -> Vec<i64> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["seq"].as_i64().unwrap())
        .collect()
}

/// Un flujo con varios hechos: run, tareas, preguntas, fallos y la Attention que levantan.
fn flujo(core: &Core) -> Vec<String> {
    let mut tareas = vec![];
    for n in 0..4 {
        let t = tarea(core, &format!("tarea-{n}"), SECRETO);
        if n % 2 == 0 {
            core.mutate(|tx| tx.ask(&t, SECRETO).map(|_| ())).unwrap();
        } else {
            falla(core, &t);
        }
        tareas.push(t);
    }
    tareas
}

#[test]
fn cada_evento_real_del_core_se_proyecta_sin_respaldo_y_sin_secretos() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let tareas = flujo(&core);
    let person = person(&core);
    let page = lista(&core, &person, json!({ "limit": 500 }));
    let items = page["items"].as_array().unwrap();
    assert!(
        items.len() > 12,
        "el flujo genera varios eventos: {}",
        items.len()
    );
    for i in items {
        assert_eq!(i["fallback"], false, "un evento real cayó al respaldo");
    }
    let claves: BTreeSet<_> = items
        .iter()
        .map(|i| i["message_key"].as_str().unwrap().to_string())
        .collect();
    for esperada in [
        "activity.run.created",
        "activity.task.created",
        "activity.task.failed",
        "activity.task.question",
        "activity.attention.created",
    ] {
        assert!(claves.contains(esperada), "falta {esperada} en la timeline");
    }
    assert!(
        !page.to_string().contains(SECRETO),
        "ni el spec ni la pregunta salen en Activity"
    );
    let fallida = items
        .iter()
        .find(|i| {
            i["message_key"] == "activity.task.failed" && i["target"]["id"] == tareas[1].as_str()
        })
        .expect("el fallo de la tarea 1");
    assert_eq!(fallida["args"]["cause"], "agent_idle_timeout");
    assert_eq!(fallida["actor"]["kind"], "system");
}

#[test]
fn cada_item_coincide_uno_a_uno_con_un_evento_del_log() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    flujo(&core);
    let person = person(&core);
    let page = lista(&core, &person, json!({ "limit": 500 }));
    let crudo = core
        .events_read(&Caller::User, &json!({ "limit": 500 }))
        .expect("Event Log");
    let eventos = crudo["events"].as_array().unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), eventos.len(), "un evento, un item");
    for (i, e) in items.iter().zip(eventos) {
        assert_eq!(i["seq"], e["seq"]);
        assert_eq!(i["event_id"], e["id"]);
        assert_eq!(i["kind"], e["kind"]);
        assert_eq!(i["project_id"], e["project_id"]);
        assert_eq!(i["run_id"], e["run_id"]);
        assert_eq!(i["target"], e["entity"]);
        assert_eq!(i["actor"], e["actor"]);
        assert_eq!(i["correlation_id"], e["correlation_id"]);
    }
    assert_eq!(page["head_seq"], crudo["head_seq"]);
}

#[test]
fn cursor_y_reconexion_producen_la_misma_secuencia() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    flujo(&core);
    let person = person(&core);
    let completa = lista(&core, &person, json!({ "limit": 500 }));
    assert_eq!(completa["has_more"], false);

    // De tres en tres, siguiendo `next_cursor`.
    let mut juntos: Vec<Value> = vec![];
    let mut cursor = 0;
    let mut guardado = None;
    loop {
        let page = lista(&core, &person, json!({ "limit": 3, "cursor": cursor }));
        juntos.extend(page["items"].as_array().unwrap().iter().cloned());
        cursor = page["next_cursor"].as_i64().unwrap();
        if juntos.len() == 6 {
            guardado = Some(cursor); // «se cortó la conexión» tras dos páginas
        }
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(
        Value::Array(juntos.clone()),
        completa["items"],
        "paginar no cambia la secuencia"
    );
    assert_eq!(
        cursor, completa["head_seq"],
        "al terminar, el cursor es el head_seq"
    );

    // Reconexión: un cliente nuevo retoma desde el cursor guardado y obtiene el mismo resto.
    let resto = lista(
        &core,
        &person,
        json!({ "limit": 500, "cursor": guardado.expect("hubo al menos dos páginas") }),
    );
    assert_eq!(resto["items"].as_array().unwrap().as_slice(), &juntos[6..]);

    // Sin hechos nuevos, retomar desde el final no devuelve nada y el cursor no se mueve.
    let vacia = lista(&core, &person, json!({ "cursor": cursor }));
    assert!(vacia["items"].as_array().unwrap().is_empty());
    assert_eq!(vacia["next_cursor"], cursor);
    // Un hecho nuevo aparece justo después.
    let t = tarea(&core, "nueva", "x");
    falla(&core, &t);
    let nuevos = lista(&core, &person, json!({ "cursor": cursor }));
    assert!(seqs(&nuevos).iter().all(|s| *s > cursor) && !seqs(&nuevos).is_empty());
}

#[test]
fn order_desc_pagina_hacia_atras_y_cubre_los_mismos_hechos() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    flujo(&core);
    let person = person(&core);
    let todos = seqs(&lista(&core, &person, json!({ "limit": 500 })));
    let ultima = lista(&core, &person, json!({ "order": "desc", "limit": 4 }));
    assert_eq!(ultima["order"], "desc");
    assert_eq!(
        seqs(&ultima),
        todos.iter().rev().take(4).copied().collect::<Vec<_>>(),
        "lo más nuevo primero"
    );
    assert_eq!(ultima["has_more"], true);

    let mut atras: Vec<i64> = vec![];
    let mut cursor = 0;
    loop {
        let page = lista(
            &core,
            &person,
            json!({ "order": "desc", "limit": 5, "cursor": cursor }),
        );
        atras.extend(seqs(&page));
        cursor = page["next_cursor"].as_i64().unwrap();
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(atras, todos.iter().rev().copied().collect::<Vec<_>>());
}

#[test]
fn los_filtros_acotan_por_proyecto_y_por_destino() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let tareas = flujo(&core);
    let person = person(&core);
    let suya = lista(
        &core,
        &person,
        json!({ "target_kind": "task", "target_id": tareas[1], "limit": 500 }),
    );
    let items = suya["items"].as_array().unwrap();
    assert!(!items.is_empty());
    assert!(items
        .iter()
        .all(|i| i["target"] == json!({ "kind": "task", "id": tareas[1] })));
    let ninguno = lista(
        &core,
        &person,
        json!({ "project_id": "proyecto-que-no-existe" }),
    );
    assert!(ninguno["items"].as_array().unwrap().is_empty());
    assert_eq!(ninguno["has_more"], false);
}

#[test]
fn un_evento_de_un_kind_futuro_en_el_log_no_rompe_la_timeline() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let t = tarea(&core, "antes", "x");
    falla(&core, &t);
    let futuro = NewEvent {
        id: new_project_id(),
        at: 1_760_000_000_000,
        v: 1,
        kind: "task.teleported".into(),
        class: EventClass::System,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: None,
        run_id: None,
        entity_kind: "core".into(),
        entity_id: "core".into(),
        correlation_id: None,
        idem_key: None,
        payload: json!({ "destino": SECRETO }).to_string(),
    };
    core.storage
        .with_store(|s| s.append_events(&[futuro]))
        .unwrap()
        .unwrap();
    let t2 = tarea(&core, "despues", "x");
    falla(&core, &t2);

    let person = person(&core);
    let page = lista(&core, &person, json!({ "limit": 500 }));
    let items = page["items"].as_array().unwrap();
    let pos = items
        .iter()
        .position(|i| i["kind"] == "task.teleported")
        .expect("el evento futuro aparece");
    assert_eq!(items[pos]["fallback"], true);
    assert_eq!(items[pos]["message_key"], UNKNOWN_KEY);
    assert!(
        items[..pos]
            .iter()
            .any(|i| i["message_key"] == "activity.task.failed"),
        "lo anterior sigue ahí"
    );
    assert!(
        items[pos + 1..]
            .iter()
            .any(|i| i["message_key"] == "activity.task.failed"),
        "lo posterior sigue ahí"
    );
    assert!(!page.to_string().contains(SECRETO));
    let orden = seqs(&page);
    assert!(
        orden.windows(2).all(|w| w[0] < w[1]),
        "la secuencia sigue el seq"
    );
}

#[test]
fn solo_una_person_autenticada_puede_leer_activity() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let t = tarea(&core, "t", "x");
    let agent = agente(
        &core,
        &t,
        "install-agent-activity",
        "agent-activity-secret-0123456789abcdef",
    );
    let error =
        rpc(&core, &agent, "activity_list", json!({})).expect_err("un Agent no lee Activity");
    assert!(error.contains("activity_auth_required"), "{error}");
    assert!(lista(&core, &person(&core), json!({}))["v"] == 1);
    let desde_ui = core
        .rpc_via(Channel::Ui, Caller::User, "", "activity_list", &json!({}))
        .expect("Person de Desktop");
    assert_eq!(desde_ui["projection"], 1);
}

#[test]
fn parametros_invalidos_y_cursor_ajeno_se_rechazan() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    tarea(&core, "t", "x");
    let person = person(&core);
    for args in [
        json!({ "kind": "task.created" }),
        json!({ "cursor": "abc" }),
        json!({ "cursor": -1 }),
        json!({ "limit": 0 }),
        json!({ "order": "up" }),
        json!({ "target_id": "t-1" }),
        json!({ "project_id": "" }),
        json!("texto"),
    ] {
        let error = rpc(&core, &person, "activity_list", args.clone())
            .expect_err(&format!("{args} debe rechazarse"));
        assert!(
            error.starts_with("activity_invalid_request"),
            "{args}: {error}"
        );
    }
    let head = lista(&core, &person, json!({}))["head_seq"]
        .as_i64()
        .unwrap();
    let error = rpc(
        &core,
        &person,
        "activity_list",
        json!({ "cursor": head + 5 }),
    )
    .expect_err("cursor de otro Core");
    assert!(error.starts_with("activity_cursor_ahead"), "{error}");
}

#[test]
fn es_de_solo_lectura_y_reproducible() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    flujo(&core);
    let person = person(&core);
    let antes = core
        .events_read(&Caller::User, &json!({ "limit": 500 }))
        .unwrap()["head_seq"]
        .clone();
    let primera = lista(&core, &person, json!({ "limit": 500 }));
    let segunda = lista(&core, &person, json!({ "limit": 500 }));
    assert_eq!(primera, segunda);
    assert_eq!(
        core.events_read(&Caller::User, &json!({ "limit": 500 }))
            .unwrap()["head_seq"],
        antes,
        "leer no escribe eventos"
    );
}
