//! LXO-145 · Fork de extremo a extremo por la superficie de Desktop: la persona bifurca un Attempt, aprueba el nuevo y el Core lo lanza
//! por el adapter del proveedor, en su propia Task, rama y worktree. Cada prueba entra por `rpc_via(Ui, User)` —el camino de `orch_call`
//! del ADE— y comprueba el desenlace DURABLE: estado, Events en orden, Attention y que el origen no cambió. Contrato: `docs/core/FORK.md`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::ProviderAdapter;
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{repo_with_commit, worktree_dir_of, worktree_state};
use super::attempt_e2e_tests::{attention, kinds, wait_until, world, World};
use super::context_package::{build, NewPackage, RevisionInput};
use super::dispatch_tests::{event_count, row};
use super::events::Channel;
use super::initial_approval_tests::e2e::core_with_project_at;
use super::provider_registry::LiveRegistry;
use super::{Caller, Core};

fn task_of(attempt: &str) -> String {
    attempt.rsplit_once("-a").unwrap().0.to_string()
}

impl World {
    fn fork(&self, source: &str, request_id: &str, extra: Value) -> Result<Value, String> {
        let mut args = json!({"request_id": request_id, "source_attempt_id": source});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            args[k] = v;
        }
        self.desktop("attempt_fork", args)
    }

    /// El origen ya terminado (`done`): lo que se bifurca casi siempre.
    fn finished(&self, request_id: &str) -> String {
        let attempt = self.create("claude", request_id);
        self.approve(&attempt);
        self.settled(&attempt, "done");
        attempt
    }
}

/// El payload del `attempt.forked` del Attempt.
fn forked_payload(core: &Core, attempt: &str) -> Value {
    let text: String = core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT payload FROM events WHERE kind = 'attempt.forked' AND entity_id = ?1", [attempt], |r| r.get(0))?)))
        .unwrap()
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn column(core: &Core, attempt: &str, column: &str) -> Option<String> {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row(&format!("SELECT CAST({column} AS TEXT) FROM attempts WHERE id = ?1"), [attempt], |r| r.get::<_, Option<String>>(0))?))).unwrap().unwrap()
}

fn task_count(core: &Core) -> usize {
    core.lock().tasks.len()
}

/// Un paquete válido DEL Attempt que se dice, en el Project del mundo.
fn package_of(w: &World, task: &str, attempt: &str) -> String {
    package_in(&w.project, task, attempt)
}

fn package_in(project: &str, task: &str, attempt: &str) -> String {
    build(NewPackage {
        created_at_ms: 1,
        project_id: project.into(),
        task_id: task.into(),
        attempt_id: attempt.into(),
        provider: "claude".into(),
        provider_session: None,
        host: "host-a".into(),
        objective: "dejar el login funcionando".into(),
        decisions: vec!["usar sesiones con cookie".into()],
        constraints: vec!["no tocar la base".into()],
        thread_summary: None,
        revision: RevisionInput::Absent("el Attempt no tiene repositorio".into()),
        uncommitted: None,
        test_results: None,
        artifacts: vec![],
        bundle: None,
    })
    .unwrap()
    .package
    .to_json()
    .to_string()
}

/// Dos proveedores completos (`claude` y `codex`) detrás del lanzador real.
fn world_duo() -> (World, Arc<FakeAdapter>) {
    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let claude = Arc::new(FakeAdapter::full("claude"));
    let codex = Arc::new(FakeAdapter::full("codex"));
    let (a, b) = (claude.clone(), codex.clone());
    let registry = LiveRegistry::with_builder(Box::new(move || vec![a.clone() as Arc<dyn ProviderAdapter>, b.clone() as Arc<dyn ProviderAdapter>]), Duration::from_secs(60));
    registry.probe_all();
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry)));
    core.provider_registry.probe_all();
    (World { core, project, adapter: claude }, codex)
}

#[test]
fn un_fork_limpio_crea_una_task_nueva_pendiente_con_su_procedencia_y_no_toca_el_origen() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let antes = (row(&w.core, &a1), kinds(&w.core, &a1), column(&w.core, &a1, "updated_at"), attention(&w.core, &a1));
    let tareas = task_count(&w.core);

    let out = w.fork(&a1, "fork-1", json!({})).expect("el fork");
    assert_eq!(out["status"], "Requested");
    assert_eq!((out["source_attempt_id"].as_str(), out["strategy"].as_str()), (Some(a1.as_str()), Some("clean")));
    let f1 = out["attempt_id"].as_str().unwrap().to_string();

    // Identidad propia: otra Task, otro Attempt, otro Run. Nunca la del origen.
    assert_ne!(f1, a1);
    assert_ne!(task_of(&f1), task_of(&a1));
    assert_eq!(f1, format!("{}-a1", out["task_id"].as_str().unwrap()));
    assert_eq!(task_count(&w.core), tareas + 1);

    // Nace pendiente de la decisión de la persona; nada se lanzó ni se creó.
    assert_eq!(row(&w.core, &f1).0, "pending_approval");
    assert_eq!(attention(&w.core, &f1), vec![("approval".to_string(), "active".to_string())]);
    assert_eq!(w.adapter.starts().len(), 1, "bifurcar no lanza nada: solo el origen se lanzó");
    assert_eq!(worktree_state(&w.core, &f1), None);

    // La procedencia nace con el Attempt, justo después de su `attempt.requested`, y sin el encargo ni el contenido.
    assert_eq!(kinds(&w.core, &f1), vec!["attempt.requested", "attempt.forked"]);
    let payload = forked_payload(&w.core, &f1);
    assert_eq!(
        payload,
        json!({"task": task_of(&f1), "n": 1, "source": a1, "source_task": task_of(&a1), "source_n": 1, "strategy": "clean"}),
        "sin paquete ni cambios pedidos, no hay package_id ni overrides"
    );

    // El origen no recibió ni un evento ni un cambio de fila.
    let despues = (row(&w.core, &a1), kinds(&w.core, &a1), column(&w.core, &a1, "updated_at"), attention(&w.core, &a1));
    assert_eq!(antes, despues, "el origen es inmutable");
    assert_eq!(event_count(&w.core, &a1, "attempt.forked"), 0);
}

#[test]
fn el_fork_aprobado_corre_en_su_propio_worktree_con_el_mismo_perfil_y_sin_ampliar_permisos() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let f1 = w.fork(&a1, "fork-1", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();

    w.approve(&f1);
    w.settled(&f1, "done");

    assert_eq!(kinds(&w.core, &f1)[..4], ["attempt.requested", "attempt.forked", "attempt.approved", "attempt.started"]);
    let starts = w.adapter.starts();
    assert_eq!(starts.len(), 2, "el proveedor se lanzó una vez por Attempt");
    assert_ne!(starts[0].worktree, starts[1].worktree, "cada Fork trabaja en su worktree: nunca el del origen");
    assert_eq!(starts[1].prompt, "haz algo", "sin paquete arranca con el encargo de la Task origen");
    assert_eq!(worktree_state(&w.core, &f1).as_deref(), Some("active"));
    assert_eq!(worktree_state(&w.core, &a1).as_deref(), Some("active"));
    // El perfil se hereda del origen y el Fork no es externo.
    assert_eq!(column(&w.core, &f1, "profile"), column(&w.core, &a1, "profile"));
    assert_eq!(column(&w.core, &f1, "profile").as_deref(), Some("explorar"));
    assert_eq!(column(&w.core, &f1, "external").as_deref(), Some("0"));
    assert!(attention(&w.core, &f1).iter().all(|(_, status)| status == "resolved"), "{:?}", attention(&w.core, &f1));
}

#[test]
fn bifurcar_un_origen_en_marcha_corre_los_dos_a_la_vez_y_ninguno_cambia_al_otro() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "fork-origen");
    w.approve(&a1);
    wait_until("el origen corre", || row(&w.core, &a1).0 == "running");
    wait_until("el origen tiene su ejecución viva", || w.core.has_term(&task_of(&a1)));

    let f1 = w.fork(&a1, "fork-1", json!({})).expect("bifurcar un origen vivo")["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(row(&w.core, &a1).0, "running", "el origen sigue corriendo mientras se bifurca");
    w.approve(&f1);
    wait_until("el fork corre", || row(&w.core, &f1).0 == "running");
    wait_until("el fork tiene su ejecución viva", || w.core.has_term(&task_of(&f1)));

    // Dos ejecuciones simultáneas, de Tasks distintas.
    assert_eq!((row(&w.core, &a1).0.as_str(), row(&w.core, &f1).0.as_str()), ("running", "running"));
    assert_eq!(w.adapter.starts().len(), 2);

    // Detener uno no toca al otro.
    assert_eq!(w.core.kill_term(&task_of(&f1)), Ok(true));
    w.settled(&f1, "stopped");
    assert_eq!(row(&w.core, &a1).0, "running");
    assert_eq!(w.core.kill_term(&task_of(&a1)), Ok(true));
    w.settled(&a1, "stopped");
    assert_eq!(event_count(&w.core, &a1, "attempt.forked"), 0);
}

#[test]
fn un_fork_con_otro_proveedor_cambia_solo_lo_pedido_y_no_arrastra_el_modelo() {
    let (w, codex) = world_duo();
    let a1 = {
        let created = w
            .desktop("task_create", json!({"request_id": "c1", "project_id": w.project, "objective": "o", "title": "t", "spec": "haz algo", "attempt": {"provider": "claude", "model": "opus", "effort": "high", "role": "worker", "profile": "explorar"}}))
            .unwrap();
        created["attempt_id"].as_str().unwrap().to_string()
    };
    w.approve(&a1);
    w.settled(&a1, "done");

    // Mismo proveedor: hereda modelo, esfuerzo y rol.
    let mismo = w.fork(&a1, "fork-mismo", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!((column(&w.core, &mismo, "model").as_deref(), column(&w.core, &mismo, "effort").as_deref(), column(&w.core, &mismo, "role").as_deref()), (Some("opus"), Some("high"), Some("worker")));
    assert!(forked_payload(&w.core, &mismo).get("overrides").is_none());

    // Otro proveedor: el modelo y el esfuerzo son del proveedor y no viajan; el rol y el perfil sí.
    let otro = w.fork(&a1, "fork-otro", json!({"provider": "codex"})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(column(&w.core, &otro, "provider").as_deref(), Some("codex"));
    assert_eq!((column(&w.core, &otro, "model"), column(&w.core, &otro, "effort")), (None, None));
    assert_eq!((column(&w.core, &otro, "role").as_deref(), column(&w.core, &otro, "profile").as_deref()), (Some("worker"), Some("explorar")));
    assert_eq!(forked_payload(&w.core, &otro)["overrides"], json!(["provider"]));

    // Pedir un modelo distinto lo deja dicho.
    let modelo = w.fork(&a1, "fork-modelo", json!({"model": "sonnet"})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(column(&w.core, &modelo, "model").as_deref(), Some("sonnet"));
    assert_eq!(forked_payload(&w.core, &modelo)["overrides"], json!(["model"]));
    // Pedir lo mismo que ya había no es cambiar nada.
    let igual = w.fork(&a1, "fork-igual", json!({"provider": "claude", "model": "opus"})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert!(forked_payload(&w.core, &igual).get("overrides").is_none());

    // Aprobado, lo lanza el adapter del proveedor elegido.
    w.approve(&otro);
    w.settled(&otro, "done");
    assert_eq!(codex.starts().len(), 1, "el Fork se lanzó con codex");
    assert_eq!(w.adapter.starts().len(), 1, "y claude no se tocó: solo lanzó el origen");
}

#[test]
fn un_fork_con_context_package_del_origen_lo_lleva_en_el_encargo_y_registra_su_identidad() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let package = package_of(&w, &task_of(&a1), &a1);
    let package_id = serde_json::from_str::<Value>(&package).unwrap()["package_id"].as_str().unwrap().to_string();

    let out = w.fork(&a1, "fork-pkg", json!({"package": package})).expect("el fork con paquete");
    assert_eq!((out["strategy"].as_str(), out["package_id"].as_str()), (Some("context_package"), Some(package_id.as_str())));
    let f1 = out["attempt_id"].as_str().unwrap().to_string();
    let payload = forked_payload(&w.core, &f1);
    assert_eq!((payload["strategy"].as_str(), payload["package_id"].as_str()), (Some("context_package"), Some(package_id.as_str())));
    assert!(!payload.to_string().contains("dejar el login"), "el evento no lleva el contenido del paquete");

    w.approve(&f1);
    w.settled(&f1, "done");
    let prompt = w.adapter.starts()[1].prompt.clone();
    assert!(prompt.contains("CONTEXTO:") && prompt.contains("dejar el login funcionando"), "el paquete viaja en el mensaje: {prompt}");
    assert!(prompt.ends_with("ENCARGO DE LA TASK ORIGEN:\nhaz algo"), "y después el encargo de la Task origen: {prompt}");
}

#[test]
fn un_paquete_que_no_es_del_origen_o_esta_alterado_se_rechaza_antes_de_crear_nada() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let tareas = task_count(&w.core);
    let bueno = package_of(&w, &task_of(&a1), &a1);

    // De otro Attempt, de otra Task y de otro Project: ninguno es la procedencia de ESTE origen.
    let de_otro_attempt = package_of(&w, &task_of(&a1), &format!("{}-a9", task_of(&a1)));
    let de_otra_task = package_of(&w, "t-ajena", "t-ajena-a1");
    let de_otro_project = package_in("p-ajeno", &task_of(&a1), &a1);
    for (name, raw, code) in [
        ("otro attempt", de_otro_attempt, "context_package_source_mismatch"),
        ("otra task", de_otra_task, "context_package_source_mismatch"),
        ("otro project", de_otro_project, "context_package_source_mismatch"),
    ] {
        let e = w.fork(&a1, "fork-bad", json!({"package": raw})).unwrap_err();
        assert!(e.contains(code), "{name}: {e}");
    }
    // Alterado: la identidad del paquete es el hash de su contenido.
    let alterado = bueno.replace("dejar el login funcionando", "borrar la base de datos");
    let e = w.fork(&a1, "fork-bad", json!({"package": alterado})).unwrap_err();
    assert!(e.contains("context_package_invalid"), "{e}");
    let e = w.fork(&a1, "fork-bad", json!({"package": "no es json"})).unwrap_err();
    assert!(e.contains("context_package_invalid"), "{e}");

    assert_eq!(task_count(&w.core), tareas, "un rechazo no deja ni Task ni Events");
    // Y la clave no quedó gastada: la misma petición con el paquete bueno sale.
    assert_eq!(w.fork(&a1, "fork-bad", json!({"package": bueno})).unwrap()["status"], "Requested");
    assert_eq!(task_count(&w.core), tareas + 1);
}

#[test]
fn repetir_el_fork_no_lo_duplica_y_la_misma_clave_para_otra_cosa_es_un_conflicto() {
    let (w, _codex) = world_duo();
    let a1 = w.finished("fork-origen");
    let tareas = task_count(&w.core);

    let first = w.fork(&a1, "fork-1", json!({})).unwrap();
    assert_eq!(first["status"], "Requested");
    let f1 = first["attempt_id"].as_str().unwrap().to_string();

    // Doble clic o reintento de red: los mismos ids, ningún Attempt nuevo, ningún evento más.
    let again = w.fork(&a1, "fork-1", json!({})).unwrap();
    assert_eq!(again["status"], "Replayed");
    assert_eq!((&again["attempt_id"], &again["task_id"], &again["run_id"]), (&first["attempt_id"], &first["task_id"], &first["run_id"]));
    assert_eq!(task_count(&w.core), tareas + 1);
    assert_eq!(event_count(&w.core, &f1, "attempt.forked"), 1);
    assert_eq!(event_count(&w.core, &f1, "attempt.requested"), 1);

    // Una clave vieja nunca atiende otra cosa.
    assert!(w.fork(&a1, "fork-1", json!({"provider": "codex"})).is_err());
    assert!(w.fork(&format!("{}-a2", task_of(&a1)), "fork-1", json!({})).is_err());
    assert_eq!(task_count(&w.core), tareas + 1);
    // Otra clave, otro Fork: dos Forks del mismo origen son legítimos y distintos.
    let second = w.fork(&a1, "fork-2", json!({})).unwrap();
    assert_ne!(second["attempt_id"], first["attempt_id"]);
    assert_eq!(task_count(&w.core), tareas + 2);
}

#[test]
fn rechazar_el_fork_no_lanza_nada_ni_crea_worktree_y_deja_el_origen_como_estaba() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let f1 = w.fork(&a1, "fork-1", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();

    assert_eq!(w.desktop("attempt_reject", json!({"attempt_id": f1})).unwrap()["status"], "Rejected");

    assert_eq!(row(&w.core, &f1).0, "stopped");
    assert_eq!(kinds(&w.core, &f1), vec!["attempt.requested", "attempt.forked", "attempt.rejected"]);
    assert_eq!(w.adapter.starts().len(), 1, "un Fork rechazado nunca llega al proveedor");
    assert_eq!(worktree_state(&w.core, &f1), None);
    assert!(attention(&w.core, &f1).iter().all(|(_, status)| status == "resolved"));
    assert_eq!(row(&w.core, &a1).0, "done");
}

#[test]
fn si_el_worktree_del_fork_no_se_puede_crear_el_fork_falla_sin_llamar_al_proveedor_y_el_origen_sigue_igual() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let f1 = w.fork(&a1, "fork-1", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();

    // Una carpeta ajena ocupa el sitio del worktree del Fork.
    let repo = w.core.project_launch_location(&w.project).unwrap();
    let ocupado = worktree_dir_of(&repo, &f1);
    std::fs::create_dir_all(&ocupado).unwrap();
    std::fs::write(ocupado.join("ajeno.txt"), "no es tuyo").unwrap();

    w.approve(&f1);
    w.settled(&f1, "failed");
    assert_eq!(row(&w.core, &f1), ("failed".into(), "settled".into(), Some("launch_failed".into())));
    assert_eq!(event_count(&w.core, &f1, "attempt.started"), 0);
    assert_eq!(w.adapter.starts().len(), 1, "el proveedor no se llamó para el Fork");
    assert_eq!(std::fs::read_to_string(ocupado.join("ajeno.txt")).unwrap(), "no es tuyo");
    assert_eq!(row(&w.core, &a1), ("done".into(), "settled".into(), None));
}

#[test]
fn solo_una_persona_de_desktop_bifurca_y_lo_invalido_se_rechaza_sin_escribir() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let tareas = task_count(&w.core);
    let args = json!({"request_id": "fork-1", "source_attempt_id": a1});

    // Ni un agente ni el CLI.
    assert!(w.core.rpc(Caller::Agent(Some(task_of(&a1))), "", "attempt_fork", &args).is_err());
    assert!(w.core.rpc_via(Channel::Lxo, Caller::User, "", "attempt_fork", &args).is_err());

    // Campos que son política o recursos del runtime: ni siquiera se parsean.
    for extra in ["profile", "worktree", "shared_worktree", "host", "external", "approved"] {
        let mut v = args.clone();
        v[extra] = json!("x");
        assert_eq!(w.desktop("attempt_fork", v).unwrap_err(), "Solicitud de Fork inválida", "{extra}");
    }
    // Origen inexistente o mal formado, clave inválida, proveedor desconocido o mal escrito.
    assert!(w.fork("t999-a1", "fork-1", json!({})).unwrap_err().contains("no existe la Task"));
    assert!(w.fork(&format!("{}-a9", task_of(&a1)), "fork-1", json!({})).unwrap_err().contains("no existe el Attempt"));
    assert!(w.fork("sin-formato", "fork-1", json!({})).is_err());
    assert!(w.fork(&a1, "con espacio", json!({})).is_err());
    assert!(w.fork(&a1, "fork-1", json!({"provider": "nope"})).unwrap_err().contains("provider_unknown"));
    assert!(w.fork(&a1, "fork-1", json!({"provider": "Claude"})).is_err());
    assert!(w.fork(&a1, "fork-1", json!({"model": "  "})).is_err());
    assert!(w.fork(&a1, "fork-1", json!({"title": ""})).is_err());
    assert_eq!(task_count(&w.core), tareas, "nada de lo anterior dejó rastro");

    // Sin lanzador instalado nada ejecutaría el Attempt nuevo.
    let repo = repo_with_commit();
    let (core, _client, _ctx, _project) = core_with_project_at(&repo.to_string_lossy());
    assert_eq!(core.rpc_via(Channel::Ui, Caller::User, "", "attempt_fork", &args).unwrap_err(), super::fork_runtime::FORK_NOT_AVAILABLE);
}

#[test]
fn el_titulo_por_defecto_dice_de_donde_sale_y_uno_pedido_se_respeta() {
    let w = world("claude", None);
    let a1 = w.finished("fork-origen");
    let title_of = |attempt: &str| w.core.lock().tasks.get(&task_of(attempt)).unwrap().title.clone();

    let por_defecto = w.fork(&a1, "fork-1", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(title_of(&por_defecto), "Fork de t");
    let pedido = w.fork(&a1, "fork-2", json!({"title": "  Probar con otro enfoque  "})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(title_of(&pedido), "Probar con otro enfoque");
}

#[test]
fn la_procedencia_sale_del_log_y_ve_en_los_dos_sentidos_sin_inventar_nada() {
    let (w, _codex) = world_duo();
    let a1 = w.finished("fork-origen");
    let lineage = |attempt: &str| w.desktop("attempt_lineage", json!({"attempt_id": attempt}));

    // Un Attempt que no nació de un Fork ni tiene Forks.
    let vacio = lineage(&a1).unwrap();
    assert_eq!((vacio["v"].as_i64(), &vacio["forked_from"], vacio["forks"].as_array().map(Vec::len)), (Some(1), &Value::Null, Some(0)));

    let limpio = w.fork(&a1, "fork-1", json!({})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    let otro = w.fork(&a1, "fork-2", json!({"provider": "codex"})).unwrap()["attempt_id"].as_str().unwrap().to_string();

    // Hacia atrás: de dónde salió y cómo.
    let hijo = lineage(&otro).unwrap();
    assert_eq!(
        hijo["forked_from"],
        json!({"attempt_id": a1, "task_id": task_of(&a1), "n": 1, "strategy": "clean", "package_id": null, "overrides": ["provider"]})
    );
    assert_eq!(hijo["forks"].as_array().map(Vec::len), Some(0));

    // Hacia delante: los Forks del origen, en el orden en que nacieron, con el estado de ahora.
    let padre = lineage(&a1).unwrap();
    let forks = padre["forks"].as_array().unwrap();
    assert_eq!(forks.iter().map(|f| f["attempt_id"].as_str().unwrap()).collect::<Vec<_>>(), vec![limpio.as_str(), otro.as_str()]);
    assert_eq!((forks[0]["status"].as_str(), forks[0]["provider"].as_str(), forks[1]["provider"].as_str()), (Some("pending_approval"), Some("claude"), Some("codex")));
    assert_eq!(padre["forked_from"], Value::Null);
    w.approve(&limpio);
    w.settled(&limpio, "done");
    assert_eq!(lineage(&a1).unwrap()["forks"][0]["status"], "done", "el estado es el de ahora");

    // Rechazos: otro Attempt inexistente, forma inválida, campos de más y quien no es una Person de Desktop.
    assert!(lineage(&format!("{}-a9", task_of(&a1))).unwrap_err().contains("no existe el Attempt"));
    assert!(lineage("sin-formato").is_err());
    assert_eq!(w.desktop("attempt_lineage", json!({"attempt_id": a1, "project": "x"})).unwrap_err(), "Solicitud de procedencia inválida");
    assert!(w.core.rpc(Caller::Agent(Some(task_of(&a1))), "", "attempt_lineage", &json!({"attempt_id": a1})).is_err());
}
