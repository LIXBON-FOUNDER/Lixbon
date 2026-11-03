//! Aprobación inicial de un Attempt en la capa `Core` (LXO-141, fase 2a).
//!
//! Dos niveles. Las pruebas de `Tx` cubren las reglas de la mutación sin SQLite: quién puede pedir el primer Attempt y
//! decidirlo, y qué hechos canónicos salen. La de extremo a extremo levanta un Core real con el corte aplicado y
//! demuestra que el barrido periódico expira de verdad un Attempt cuyo plazo durable venció.
//!
//! Las bases son temporales y se conservan: aquí no hay destructor que borre archivos.

use serde_json::Value;

use super::events::{Actor, Channel, MutationContext};
use super::mutation::Tx;
use super::state::{NewTask, State, Status};

fn nt() -> NewTask {
    NewTask {
        agent: "codex".into(), model: None, effort: None, role: None, title: "aprobación".into(), spec: String::new(),
        repo: "/r".into(), cwd: "/r".into(), branch: None, base: None, worktree: None, external: false,
    }
}

fn person() -> MutationContext {
    MutationContext { actor: Actor::PersonId("person-1".into()), channel: Channel::Ui, client_id: Some("client-1".into()) }
}

/// Un Run con su raíz en `status`; devuelve el estado y el id de la raíz.
fn state_with(status: Status) -> (State, String) {
    let mut state = State::default();
    let (_, root) = state.create_run("obj", nt());
    state.task_mut(&root).unwrap().status = status;
    (state, root)
}

/// Un estado con el primer Attempt ya pedido y pendiente de decisión.
fn pending() -> (State, String) {
    let (mut state, root) = state_with(Status::PendingApproval);
    state.attempt_n.insert(root.clone(), 1);
    (state, root)
}

fn events_of(tx: &mut Tx) -> Vec<crate::store::NewEvent> {
    tx.finalized_events().unwrap()
}

fn payload(e: &crate::store::NewEvent) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------------
// Pedir el primer Attempt
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn pedir_el_primer_attempt_con_aprobacion_lo_deja_pendiente_y_lo_dice_en_attempt_requested() {
    let (state, root) = state_with(Status::PendingApproval);
    let mut tx = Tx::detached_with_attempts(state);
    tx.set_context(person());
    tx.request_initial_attempt(&root).unwrap();

    assert_eq!(tx.attempt_n.get(&root), Some(&1));
    assert_eq!(tx.tasks[&root].status, Status::PendingApproval);
    let events = events_of(&mut tx);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "attempt.requested");
    let p = payload(&events[0]);
    assert_eq!(p["approval_required"], true, "nace esperando a una persona");
    assert_eq!(p["provider"], "codex");
}

#[test]
fn sin_aprobacion_el_primer_attempt_nace_starting_y_no_la_pide() {
    let (state, root) = state_with(Status::Starting);
    let mut tx = Tx::detached_with_attempts(state);
    tx.set_context(person());
    tx.request_initial_attempt(&root).unwrap();
    let events = events_of(&mut tx);
    assert_eq!(events.len(), 1);
    assert_eq!(payload(&events[0])["approval_required"], false);
}

#[test]
fn pedir_el_primer_attempt_falla_cerrado_sin_cambiar_nada() {
    // Sin el runtime de Attempts activo no hay dónde registrar la solicitud.
    let (state, root) = state_with(Status::PendingApproval);
    let mut tx = Tx::detached(state);
    assert!(tx.request_initial_attempt(&root).is_err());
    assert!(!tx.attempt_n.contains_key(&root));
    assert!(tx.pending_events().is_empty());

    // Una Task sin ejecución solicitada no puede registrar un Attempt «a medias».
    let (state, root) = state_with(Status::NotStarted);
    let mut tx = Tx::detached_with_attempts(state);
    assert!(tx.request_initial_attempt(&root).is_err());
    assert_eq!(tx.tasks[&root].status, Status::NotStarted);
    assert!(tx.pending_events().is_empty());

    // Ya tiene un Attempt.
    let (state, root) = pending();
    let mut tx = Tx::detached_with_attempts(state);
    assert!(tx.request_initial_attempt(&root).is_err());
    assert!(tx.pending_events().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// Decidir: solo una Person autenticada, y solo sobre el Attempt actual y pendiente
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn solo_una_person_autenticada_aprueba_o_rechaza_y_el_resto_no_cambia_nada() {
    let anonymous_person = MutationContext { actor: Actor::PersonId("person-1".into()), channel: Channel::Ui, client_id: None };
    let contexts = [
        (person(), true),
        (anonymous_person, false),
        (MutationContext::agent("t-agent", Channel::Ui), false),
        (MutationContext::core(), false),
    ];
    for (context, allowed) in contexts {
        for approve in [true, false] {
            let (state, root) = pending();
            let mut tx = Tx::detached_with_attempts(state);
            tx.set_context(context.clone());
            let attempt = format!("{root}-a1");
            let result = if approve { tx.approve_attempt(&attempt) } else { tx.reject_attempt(&attempt) };
            assert_eq!(result.is_ok(), allowed, "{context:?} approve={approve}");
            let expected = match (allowed, approve) {
                (false, _) => Status::PendingApproval,
                (true, true) => Status::Starting,
                (true, false) => Status::Stopped,
            };
            assert_eq!(tx.tasks[&root].status, expected, "{context:?} approve={approve}");
            if !allowed {
                assert!(tx.pending_events().is_empty(), "una decisión no autorizada no deja hechos");
            }
        }
    }
}

#[test]
fn aprobar_y_rechazar_emiten_sus_hechos_canonicos_con_la_identidad_de_la_person() {
    for (approve, kind, status) in [(true, "attempt.approved", Status::Starting), (false, "attempt.rejected", Status::Stopped)] {
        let (state, root) = pending();
        let mut tx = Tx::detached_with_attempts(state);
        tx.set_context(person());
        let attempt = format!("{root}-a1");
        if approve { tx.approve_attempt(&attempt).unwrap() } else { tx.reject_attempt(&attempt).unwrap() }
        assert_eq!(tx.tasks[&root].status, status);

        let events = events_of(&mut tx);
        assert_eq!(events.len(), 1, "{kind}: una decisión, un hecho");
        let e = &events[0];
        assert_eq!(e.kind, kind);
        assert_eq!(e.entity_kind, "attempt");
        assert_eq!(e.entity_id, attempt);
        assert_eq!(e.actor_kind, crate::store::ActorKind::Person);
        assert_eq!(e.actor_id.as_deref(), Some("person-1"));
        assert_eq!(e.client_id.as_deref(), Some("client-1"));
        if !approve {
            assert_eq!(payload(e)["cause"], "cancelled", "un rechazo humano es una cancelación, no un vencimiento");
        }
    }
}

#[test]
fn decidir_fuera_de_pendiente_o_sobre_otro_attempt_se_rechaza_sin_tocar_el_estado() {
    for status in [Status::Starting, Status::Running, Status::Waiting, Status::AwaitingTerminalApproval, Status::Done, Status::NotStarted] {
        let (mut state, root) = state_with(status);
        state.attempt_n.insert(root.clone(), 1);
        let mut tx = Tx::detached_with_attempts(state);
        tx.set_context(person());
        let attempt = format!("{root}-a1");
        assert!(tx.approve_attempt(&attempt).is_err(), "{status:?}");
        assert!(tx.reject_attempt(&attempt).is_err(), "{status:?}");
        assert_eq!(tx.tasks[&root].status, status);
        assert!(tx.pending_events().is_empty());
    }

    // Un Attempt que ya no es el actual, un id mal formado y una Task inexistente.
    let (mut state, root) = pending();
    state.attempt_n.insert(root.clone(), 2);
    let mut tx = Tx::detached_with_attempts(state);
    tx.set_context(person());
    for id in [format!("{root}-a1"), format!("{root}-a0"), format!("{root}-ax"), "t999-a1".to_string(), String::new()] {
        assert!(tx.approve_attempt(&id).is_err(), "{id:?}");
        assert!(tx.reject_attempt(&id).is_err(), "{id:?}");
    }
    assert_eq!(tx.tasks[&root].status, Status::PendingApproval);
    assert!(tx.pending_events().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// Extremo a extremo: el barrido periódico expira un Attempt cuyo plazo durable venció
// ---------------------------------------------------------------------------------------------------------------------

pub(super) mod e2e {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::super::agentic_cut;
    use super::super::boot_tests::{arranca, dirs, suelta};
    use super::super::events::{Channel, MutationContext};
    use super::super::host::RecordingHost;
    use super::super::state::Status;
    use super::super::{Core, Orch};
    use crate::store::{ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity, Fingerprint, NewLocation};

    /// Las carpetas (datos y Core) de cada Core de la fixture, por dirección: lo que hace falta para reiniciarlo.
    static FIXTURE_DIRS: Mutex<Vec<(usize, PathBuf, PathBuf)>> = Mutex::new(Vec::new());

    /// Reinicia el Core de la fixture sobre sus mismas carpetas: lo suelta (esperando a que libere `core.lock`) y arranca otro.
    /// Es un reinicio limpio de proceso, no un apagado ordenado de las tareas: el estado queda como estaba.
    pub(in crate::orch) fn restart_fixture_core(core: Arc<Core>) -> Arc<Core> {
        let key = Arc::as_ptr(&core) as usize;
        let (data, core_dir) = FIXTURE_DIRS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(k, _, _)| *k == key)
            .map(|(_, d, c)| (d.clone(), c.clone()))
            .expect("el Core no viene de la fixture");
        core.shutdown();
        suelta(core, &core_dir);
        let core = Orch::default().0;
        core.init_in(RecordingHost::new(), &data, &core_dir).unwrap();
        FIXTURE_DIRS.lock().unwrap_or_else(|e| e.into_inner()).push((Arc::as_ptr(&core) as usize, data, core_dir));
        core
    }

    /// Un Core persistente con el corte aplicado, un Project y una Person registrada (Desktop), sin ninguna Task.
    /// Devuelve el Core, el cliente autenticado de la Person, su contexto y el id del Project.
    pub(in crate::orch) fn core_with_project() -> (Arc<Core>, crate::store::AuthenticatedClient, MutationContext, String) {
        core_with_project_at(".")
    }

    /// Lo mismo, con el Project ubicado en `location` (una carpeta que existe en esta máquina).
    pub(in crate::orch) fn core_with_project_at(location: &str) -> (Arc<Core>, crate::store::AuthenticatedClient, MutationContext, String) {
        let (keep, data, core_dir) = dirs();
        std::mem::forget(keep); // la base queda en disco: ninguna prueba borra una base de datos
        let (core, _host, ready) = arranca(&data, &core_dir);
        ready.unwrap();
        let project = core
            .storage
            .with_store(|store| {
                // La ubicación del Project es de ESTA máquina: sin ello el despachador no tiene desde dónde lanzar.
                store.meta_set("machine_id", "e2e-machine").unwrap();
                store
                    .project_create(
                        "initial-approval-e2e",
                        &Fingerprint::default(),
                        &NewLocation { machine: "e2e-machine".into(), path: location.into(), display_path: location.into(), primary: true },
                    )
                    .unwrap()
                    .id
            })
            .unwrap();
        let cut = core.storage.with_store(|store| agentic_cut::run(store, &core_dir, &data, "initial-approval-e2e")).unwrap().unwrap();
        assert!(matches!(cut, agentic_cut::CutReport::Applied { .. }), "{cut:?}");
        core.shutdown();
        suelta(core, &core_dir);
        let core = Orch::default().0;
        core.init_in(RecordingHost::new(), &data, &core_dir).unwrap();
        FIXTURE_DIRS.lock().unwrap_or_else(|e| e.into_inner()).push((Arc::as_ptr(&core) as usize, data.clone(), core_dir.clone()));

        core.storage
            .with_store(|store| {
                let registration = ClientRegistration::new(ClientSurface::Desktop, DeviceIdentity::new("e2e-install", None).unwrap()).unwrap();
                let credential = ClientCredential::new(ClientPrincipal::Person("e2e-person".into()), "e2e-person-secret-0123456789abcdef").unwrap();
                store.register_client(&registration, &credential, 10_000).unwrap();
            })
            .unwrap();
        let client = core.authenticate_client("e2e-person-secret-0123456789abcdef").unwrap().unwrap();
        let ctx = MutationContext::authenticated(&client, &ClientClaims::default(), Channel::Ui).unwrap();
        (core, client, ctx, project)
    }

    /// Un Core persistente con el corte aplicado, una Person registrada y un Attempt inicial pendiente de aprobación.
    /// Devuelve el Core, el contexto de la Person y los ids de la Task y del Attempt.
    pub(in crate::orch) fn core_with_pending_attempt() -> (Arc<Core>, MutationContext, String, String) {
        core_with_pending_attempt_at(".")
    }

    /// Lo mismo, con el Project ubicado en `location`.
    pub(in crate::orch) fn core_with_pending_attempt_at(location: &str) -> (Arc<Core>, MutationContext, String, String) {
        let (core, client, ctx, project) = core_with_project_at(location);
        // La Task nace como intención por el RPC real y después pide su primer Attempt con aprobación.
        let created = core
            .rpc_authenticated_via(
                &client,
                &ClientClaims::default(),
                Channel::Ui,
                "",
                "task_create",
                &json!({"request_id": "e2e-1", "project_id": project, "objective": "o", "title": "t", "spec": "haz algo", "repo": location}),
            )
            .unwrap();
        let task = created["task_id"].as_str().unwrap().to_string();
        core.mutate_as(&ctx, |tx| {
            let row = tx.tasks.get_mut(&task).ok_or("la Task no existe")?;
            row.status = Status::PendingApproval;
            row.agent = "fake".into();
            row.profile = Some("explorar".into());
            tx.request_initial_attempt(&task)
        })
        .unwrap();
        let attempt = format!("{task}-a1");
        (core, ctx, task, attempt)
    }

    fn attempt_row(core: &Core, attempt: &str) -> (String, Option<i64>) {
        core.storage
            .with_store(|store| {
                store.read(|c| {
                    Ok(c.query_row("SELECT status, initial_approval_deadline FROM attempts WHERE id = ?1", [attempt], |r| Ok((r.get(0)?, r.get(1)?)))?)
                })
            })
            .unwrap()
            .unwrap()
    }

    /// Adelanta el vencimiento: el plazo es inmutable por diseño, así que la prueba retira el trigger solo en su base.
    pub(in crate::orch) fn make_deadline_due(core: &Core, attempt: &str) {
        core.storage
            .with_store(|store| {
                store.write(|tx| {
                    tx.execute_batch("DROP TRIGGER attempts_initial_approval_deadline_immutable;")?;
                    tx.execute("UPDATE attempts SET initial_approval_deadline = created_at WHERE id = ?1", [attempt])?;
                    Ok(())
                })
            })
            .unwrap()
            .unwrap();
    }

    #[test]
    fn el_barrido_periodico_expira_un_attempt_con_el_plazo_durable_vencido() {
        let (core, _ctx, task, attempt) = core_with_pending_attempt();

        let (status, deadline) = attempt_row(&core, &attempt);
        assert_eq!(status, "pending_approval");
        assert!(deadline.is_some(), "el plazo durable se fija al crear el Attempt");

        // Con el plazo vigente el barrido no toca nada.
        core.periodic_sweep();
        assert_eq!(attempt_row(&core, &attempt).0, "pending_approval");
        assert_eq!(core.lock().tasks[&task].status, Status::PendingApproval);

        make_deadline_due(&core, &attempt);
        let rev_before = core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap();
        core.periodic_sweep();

        assert_eq!(attempt_row(&core, &attempt).0, "stopped", "el Attempt vencido queda detenido en las tablas");
        assert_eq!(core.lock().tasks[&task].status, Status::Stopped, "y en la memoria del Core");
        let rejected = core
            .storage
            .with_store(|store| {
                store.read(|c| {
                    Ok(c.query_row(
                        "SELECT actor_kind, channel, payload FROM events WHERE kind = 'attempt.rejected' AND entity_id = ?1",
                        [&attempt],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?)),
                    )?)
                })
            })
            .unwrap()
            .unwrap();
        assert_eq!(rejected.0, "system");
        assert_eq!(rejected.1.as_deref(), Some("core"));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&rejected.2).unwrap()["cause"], "approval_timeout");

        // Un segundo ciclo no escribe nada más.
        let rev_after = core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap();
        assert!(rev_after > rev_before);
        core.periodic_sweep();
        assert_eq!(core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap(), rev_after, "el barrido es idempotente");
    }

    #[test]
    fn una_decision_humana_a_tiempo_gana_al_barrido_y_una_tardia_no_aprueba() {
        let (core, ctx, task, attempt) = core_with_pending_attempt();
        // A tiempo: la Person rechaza y el barrido posterior no encuentra nada que expirar.
        core.mutate_as(&ctx, |tx| tx.reject_attempt(&attempt)).unwrap();
        assert_eq!(attempt_row(&core, &attempt).0, "stopped");
        core.periodic_sweep();
        assert_eq!(core.lock().tasks[&task].status, Status::Stopped);

        // Tarde: con el plazo vencido, aprobar ya no es posible; el barrido lo expira.
        let (core, ctx, task, attempt) = core_with_pending_attempt();
        make_deadline_due(&core, &attempt);
        let approved = core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt));
        assert!(approved.is_err(), "un plazo vencido no se puede convertir en aprobación");
        assert_ne!(attempt_row(&core, &attempt).0, "starting");
        core.periodic_sweep();
        assert_eq!(attempt_row(&core, &attempt).0, "stopped");
        assert_eq!(core.lock().tasks[&task].status, Status::Stopped);
    }
}
