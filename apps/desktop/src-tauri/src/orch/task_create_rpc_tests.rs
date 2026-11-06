//! Parser-side contract tests for `task.create`.
//!
//! Integration fixtures use unique temporary Stores and intentionally retain their directories;
//! none of these tests removes a database or project data.

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::super::task_create_api::CreateTaskInput;
    use super::super::boot_tests::{arranca, dirs, suelta};
    use super::super::agentic_cut;
    use super::super::host::RecordingHost;
    use super::super::{Orch};
    use super::super::rpc::rpc_action_for_tests;
    use super::super::{Core, Status};
    use crate::store::{ClientAction, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity, Fingerprint, NewLocation};

    fn parse(value: serde_json::Value) -> Result<CreateTaskInput, serde_json::Error> {
        serde_json::from_value(value)
    }

    fn request() -> serde_json::Value {
        json!({
            "request_id": "req-141",
            "project_id": "project-explicit",
            "objective": "Ship the task",
            "title": "Create task",
            "repo": "repo-path"
        })
    }

    #[test]
    fn request_requires_an_explicit_project_and_accepts_absent_attempt() {
        let parsed = parse(request()).expect("valid minimal RPC request");
        assert_eq!(parsed.project_id, "project-explicit");
        assert_eq!(parsed.attempt, None);

        let mut missing_project = request();
        missing_project.as_object_mut().unwrap().remove("project_id");
        assert!(parse(missing_project).is_err(), "project must not be inferred");
    }

    #[test]
    fn request_rejects_identity_spoofing_and_unknown_members() {
        for field in ["identity_scope", "actor", "principal", "client_id", "scope"] {
            let mut spoofed = request();
            spoofed[field] = json!("user:attacker");
            assert!(parse(spoofed).is_err(), "accepted spoofed {field}");
        }

        let mut unknown = request();
        unknown["future_magic"] = json!(true);
        assert!(parse(unknown).is_err(), "unknown request keys are closed");
    }

    #[test]
    fn a_malformed_attempt_is_rejected_at_parsing_not_accepted_halfway() {
        // Sin perfil, con un campo que es política o recurso del runtime, o con otra forma: ni se parsea.
        for attempt in [json!({ "provider": "codex" }), json!({ "provider": "codex", "profile": "explorar", "worktree": "x" }), json!(42)] {
            let mut with_attempt = request();
            with_attempt["attempt"] = attempt;
            assert!(parse(with_attempt).is_err());
        }
    }

    // Fresh persistent fixture. Leak the unique temp-dir guard immediately; the test must never
    // remove its SQLite database, including on panic. The cut/restart is only against this fixture.
    fn fixture() -> (Arc<Core>, crate::store::AuthenticatedClient, String) {
        let (core, client, project, _data, _core_dir) = fixture_with_dirs();
        (core, client, project)
    }

    fn fixture_with_dirs() -> (Arc<Core>, crate::store::AuthenticatedClient, String, std::path::PathBuf, std::path::PathBuf) {
        let (keep, data, core_dir) = dirs();
        std::mem::forget(keep);
        let (core, _host, ready) = arranca(&data, &core_dir);
        ready.unwrap();
        let project = core.storage.with_store(|store| store.project_create(
            "task-create-rpc", &Fingerprint::default(), &NewLocation {
                machine: "task-create-test-machine".into(), path: ".".into(),
                display_path: ".".into(), primary: true,
            },
        ).unwrap().id).unwrap();

        // Exercise the same cut boundary as runtime_tables_tests::corta_y_reinicia, but don't
        // reuse its Env because that carries a Drop cleanup guard.
        let cut = core.storage.with_store(|store| agentic_cut::run(store, &core_dir, &data, "task-create-test"))
            .unwrap().unwrap();
        assert!(matches!(cut, agentic_cut::CutReport::Applied { .. }), "{cut:?}");
        core.shutdown();
        suelta(core, &core_dir);
        let core = Orch::default().0;
        core.init_in(RecordingHost::new(), &data, &core_dir).unwrap();
        assert!(core.storage.with_store(|store| store.runtime_on_tables().unwrap()).unwrap());

        core.storage.with_store(|store| {
            let registration = ClientRegistration::new(ClientSurface::Cli, DeviceIdentity::new("task-create-install", None).unwrap()).unwrap();
            let credential = ClientCredential::new(ClientPrincipal::Person("task-create-person".into()), "task-create-person-secret-0123456789").unwrap();
            store.register_client(&registration, &credential, 10_000).unwrap();
        }).unwrap();
        let client = core.authenticate_client("task-create-person-secret-0123456789").unwrap().unwrap();
        (core, client, project, data, core_dir)
    }

    /// Reinicia el Core sobre las mismas carpetas, como un cierre y arranque de la aplicación.
    fn restart(core: Arc<Core>, data: &std::path::Path, core_dir: &std::path::Path) -> Arc<Core> {
        core.shutdown();
        suelta(core, core_dir);
        let core = Orch::default().0;
        core.init_in(RecordingHost::new(), data, core_dir).unwrap();
        core
    }

    fn rpc(core: &Arc<Core>, client: &crate::store::AuthenticatedClient, args: serde_json::Value) -> Result<serde_json::Value, String> {
        core.rpc_authenticated_via(client, &crate::store::ClientClaims::default(), super::super::events::Channel::Lxo, "", "task_create", &args)
    }

    /// LXO-150: sin `repo` y sin ubicación verificable del Project en esta máquina se rechaza ANTES de escribir (como con `attempt`): `Task.repo` es
    /// inmutable y una Task sin repositorio no podría recibir nunca un worktree adoptado ni un Attempt.
    #[test]
    fn a_task_only_request_without_repo_and_without_a_verified_location_is_rejected_before_writing() {
        let (core, client, project) = fixture();
        let mut args = request();
        args["project_id"] = json!(project);
        args.as_object_mut().unwrap().remove("repo");
        let tasks_before = core.lock().tasks.len();
        let error = rpc(&core, &client, args).unwrap_err();
        assert!(error.contains("ubicación"), "{error}");
        assert_eq!(core.lock().tasks.len(), tasks_before, "no nace ninguna Task");
    }

    #[test]
    fn task_create_is_a_normal_global_person_rpc_not_a_ui_only_command() {
        assert_eq!(rpc_action_for_tests("task_create"), ClientAction::AgentOrDesktopCommand);
    }

    #[test]
    fn rpc_task_only_commits_and_replays_without_extra_revision_or_events() {
        let (core, client, project) = fixture();
        let mut args = request();
        args["project_id"] = json!(project);
        let first = rpc(&core, &client, args.clone()).unwrap();
        assert_eq!(first["status"], "Committed");
        let run = first["run_id"].as_str().unwrap().to_string();
        let task = first["task_id"].as_str().unwrap().to_string();
        {
            let state = core.lock();
            assert_eq!(state.tasks[&task].status, Status::NotStarted);
            assert_eq!(state.tasks[&task].project_id.as_deref(), Some(project.as_str()));
        }
        struct RpcEvent {
            kind: String,
            version: i64,
            payload: String,
            class: String,
            actor_kind: String,
            actor_id: Option<String>,
            channel: String,
            client_id: Option<String>,
            project_id: Option<String>,
            run_id: Option<String>,
            entity_kind: String,
            entity_id: String,
            state_rev: Option<i64>,
        }
        let events = core
            .storage
            .with_store(|store| {
                store.read(|conn| {
                    let mut statement = conn.prepare(
                        "SELECT kind, v, payload, class, actor_kind, actor_id, channel, client_id, \
                         project_id, run_id, entity_kind, entity_id, state_rev \
                         FROM events WHERE run_id=?1 ORDER BY seq",
                    )?;
                    let rows = statement.query_map([&run], |r| {
                        Ok(RpcEvent {
                            kind: r.get(0)?,
                            version: r.get(1)?,
                            payload: r.get(2)?,
                            class: r.get(3)?,
                            actor_kind: r.get(4)?,
                            actor_id: r.get(5)?,
                            channel: r.get(6)?,
                            client_id: r.get(7)?,
                            project_id: r.get(8)?,
                            run_id: r.get(9)?,
                            entity_kind: r.get(10)?,
                            entity_id: r.get(11)?,
                            state_rev: r.get(12)?,
                        })
                    })?;
                    Ok(rows.collect::<Result<Vec<_>, _>>()?)
                })
            })
            .unwrap()
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            (events[0].kind.as_str(), events[1].kind.as_str()),
            ("run.created", "task.created")
        );
        assert_eq!(
            (events[0].version, events[1].version),
            (1, 2),
            "la Task de task_create es intención v2"
        );
        assert_eq!(
            events.iter().map(|e| e.class.as_str()).collect::<Vec<_>>(),
            ["state", "state"]
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&events[0].payload).unwrap(),
            json!({"root_task": task})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&events[1].payload).unwrap(),
            json!({"parent": null, "depth": 0, "title": "Create task"})
        );
        for e in &events {
            assert_eq!(e.actor_kind, "person", "{}: actor_kind", e.kind);
            assert_eq!(e.actor_id.as_deref(), Some("task-create-person"), "{}: actor_id", e.kind);
            assert_eq!(e.channel, "lxo", "{}: channel", e.kind);
            assert_eq!(e.client_id.as_deref(), Some(client.identity().client_id()), "{}: client_id", e.kind);
            assert_eq!(e.project_id.as_deref(), Some(project.as_str()), "{}: project_id", e.kind);
            assert_eq!(e.run_id.as_deref(), Some(run.as_str()), "{}: run_id", e.kind);
            assert!(e.state_rev.is_some(), "{}: state_rev", e.kind);
        }
        assert_eq!(
            (events[0].entity_kind.as_str(), events[0].entity_id.as_str()),
            ("run", run.as_str())
        );
        assert_eq!(
            (events[1].entity_kind.as_str(), events[1].entity_id.as_str()),
            ("task", task.as_str())
        );
        assert_eq!(
            events[0].state_rev, events[1].state_rev,
            "events share one committed revision"
        );
        let head = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();
        let replay = rpc(&core, &client, args).unwrap();
        assert_eq!(replay["status"], "Replayed");
        assert_eq!(replay["run_id"], run);
        assert_eq!(replay["task_id"], task);
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head);
    }

    #[test]
    fn invalid_project_and_attempt_reject_without_ledger_or_event_changes() {
        let (core, client, project) = fixture();
        let head = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();
        let mut missing = request();
        missing["project_id"] = json!("no-such-project");
        let error = rpc(&core, &client, missing).unwrap_err();
        assert!(error.to_lowercase().contains("no existe"), "unexpected rejection: {error}");
        // Sin lanzador instalado (este Core no tiene ninguno) una selección válida se rechaza antes de escribir; el bit
        // `external` ya no es input del cliente.
        for (request_id, attempt_value, expected) in [
            ("req-attempt-managed", json!({"provider":"codex", "profile":"explorar"}), "lifecycle de lanzamiento verificado"),
            ("req-attempt-external", json!({"provider":"codex", "profile":"explorar", "external":true}), "inválida"),
        ] {
            let mut attempt = request();
            attempt["request_id"] = json!(request_id);
            attempt["project_id"] = json!(project);
            attempt["attempt"] = attempt_value;
            let error = rpc(&core, &client, attempt).unwrap_err();
            assert!(error.contains(expected), "{request_id}: {error}");
        }
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head);
        let ledger = core.storage.with_store(|store| store.read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM task_create_requests", [], |r| r.get::<_, i64>(0))?))).unwrap().unwrap();
        assert_eq!(ledger, 0);
        assert!(core.lock().tasks.is_empty());
    }


    #[test]
    fn reusing_a_request_id_with_another_payload_is_a_conflict_without_side_effects() {
        let (core, client, project) = fixture();
        let mut args = request();
        args["project_id"] = json!(project);
        let first = rpc(&core, &client, args.clone()).unwrap();
        assert_eq!(first["status"], "Committed");
        let head = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let mut other = args.clone();
        other["title"] = json!("Another title");
        let error = rpc(&core, &client, other).unwrap_err();
        assert!(error.contains("otro payload"), "unexpected rejection: {error}");
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head);
        assert_eq!(core.lock().tasks.len(), 1, "el conflicto no crea una segunda Task");
        assert_eq!(rpc(&core, &client, args).unwrap()["status"], "Replayed", "el original sigue siendo un replay válido");
    }

    #[test]
    fn a_not_started_task_survives_later_mutations_and_a_restart_without_new_revisions() {
        let (core, client, project, data, core_dir) = fixture_with_dirs();
        let mut first_args = request();
        first_args["project_id"] = json!(project);
        let first = rpc(&core, &client, first_args.clone()).unwrap();
        assert_eq!(first["status"], "Committed");

        // Una mutación posterior compara el documento CON la Task sin Attempt: no debe fallar ni tocarla.
        let mut second_args = first_args.clone();
        second_args["request_id"] = json!("req-141-second");
        let second = rpc(&core, &client, second_args).unwrap();
        assert_eq!(second["status"], "Committed");
        assert_ne!(first["task_id"], second["task_id"]);
        assert_eq!(core.lock().tasks.len(), 2);

        let rev = core.storage.with_store(|store| store.runtime_rev().unwrap()).unwrap();
        let head = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();
        let core = restart(core, &data, &core_dir);

        let state = core.lock();
        assert_eq!(state.tasks.len(), 2);
        for task in state.tasks.values() {
            assert_eq!(task.status, Status::NotStarted, "{}: la Task sigue siendo solo intención", task.id);
            assert!(!state.attempt_n.contains_key(&task.id), "{}: no se fabrica un Attempt al reconstruir", task.id);
            assert_eq!(task.project_id.as_deref(), Some(project.as_str()));
        }
        drop(state);
        assert_eq!(
            core.storage.with_store(|store| store.runtime_rev().unwrap()).unwrap(),
            rev,
            "arrancar con solo intenciones no escribe una revisión nueva"
        );
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head);
        let attempts = core.storage.with_store(|store| store.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get::<_, i64>(0))?))).unwrap().unwrap();
        assert_eq!(attempts, 0, "ninguna Task sin Attempt crea filas en attempts");
    }

    #[test]
    fn a_replay_still_answers_after_a_restart() {
        let (core, client, project, data, core_dir) = fixture_with_dirs();
        let mut args = request();
        args["project_id"] = json!(project);
        let first = rpc(&core, &client, args.clone()).unwrap();
        let core = restart(core, &data, &core_dir);
        let client = core.authenticate_client("task-create-person-secret-0123456789").unwrap().unwrap();
        let replay = rpc(&core, &client, args).unwrap();
        assert_eq!(replay["status"], "Replayed");
        assert_eq!((&replay["run_id"], &replay["task_id"]), (&first["run_id"], &first["task_id"]));
        assert_eq!(core.lock().tasks.len(), 1, "el replay tras reiniciar no duplica la Task");
    }

    #[test]
    fn the_idle_sweep_never_selects_a_run_waiting_for_its_first_attempt() {
        let (core, client, project) = fixture();
        let mut args = request();
        args["project_id"] = json!(project);
        let created = rpc(&core, &client, args).unwrap();
        let run = created["run_id"].as_str().unwrap().to_string();
        // Aunque pasen siglos sin actividad, un Run con una intención pendiente no está «inactivo».
        let idle = core.lock().idle_runs(u64::MAX / 2, 1, &[]);
        assert!(!idle.contains(&run), "el barrido cerraría el Run y la Task no podría recibir su primer Attempt");
    }

}
