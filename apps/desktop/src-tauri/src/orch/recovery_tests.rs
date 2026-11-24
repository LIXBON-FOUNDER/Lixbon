//! LXO-185 · la recuperación al arrancar como UN contrato: el orden, el informe, la salud y la convergencia. Cada paso ya tiene sus pruebas
//! (`process_ownership_tests`, `dispatch_boot_tests`, `queue_restart_tests`, `mutation_tests` para el journal); aquí se prueba lo que los junta:
//! que una caída en CUALQUIER frontera entre pasos converge al mismo estado que un arranque sin caída, que repetirla no escribe nada más, que
//! lo que no se puede reconciliar con seguridad queda a la vista y frena los lanzamientos, y que nada se reejecuta.
//! Contrato: `docs/core/RECOVERY.md`.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::adapter::fake::FakeAdapter;
use super::adapter::CancelToken;
use super::adapter_launcher_tests::fixture;
use super::boot_tests;
use super::dispatch::DispatchResult;
use super::dispatch_tests::row;
use super::events::{Actor, Channel, MutationContext};
use super::initial_approval_tests::e2e::{core_with_project, restart_fixture_core};
use super::queue_commands::{Boundary, DeliveryRequest, QueuePort, QueueRequest};
use super::recovery::{crash_after, Phase, Status};
use super::state::now_ms;
use super::Core;
use crate::proctable::{Fate, Os, Proc};
use crate::store::{AttemptRow, ClientClaims, NewProviderSession, OwnedFact, QueueConfirmation, SessionBinding, SessionStatus};

/// Un puerto que acepta encolar y NUNCA entrega: tras un reinicio nada se entrega.
struct PuertoOcupado;

impl QueuePort for PuertoOcupado {
    fn capability(&self, _attempt: &AttemptRow) -> Result<(), super::adapter::AdapterError> {
        Ok(())
    }
    fn boundary(&self, _attempt: &AttemptRow) -> Boundary {
        Boundary::Busy
    }
    fn deliver(&self, _attempt: &AttemptRow, _request: &DeliveryRequest<'_>, _cancel: &CancelToken) -> Result<QueueConfirmation, super::adapter::AdapterError> {
        panic!("la recuperación nunca entrega una instrucción");
    }
}

/// Un sistema operativo falso: ni la identidad ni el cierre se pueden probar (o sí, según `fate`).
struct FalsoOs {
    start: Option<u64>,
    table: Option<Vec<(u32, u32)>>,
    fate: Fate,
    terminados: Vec<Proc>,
}

impl Os for FalsoOs {
    fn table(&mut self) -> Option<Vec<(u32, u32)>> {
        self.table.clone()
    }
    fn start(&mut self, _pid: u32) -> Option<u64> {
        self.start
    }
    fn terminate(&mut self, p: Proc) -> Fate {
        self.terminados.push(p);
        self.fate
    }
}

/// Un sistema con UN proceso vivo (pid 4242, creado en 777) que muere al terminarlo: lo que hace falta para probar un cierre.
struct SistemaConUnProceso {
    vivo: bool,
    terminados: Vec<Proc>,
}

impl Os for SistemaConUnProceso {
    fn table(&mut self) -> Option<Vec<(u32, u32)>> {
        Some(if self.vivo { vec![(4242, 1)] } else { vec![] })
    }
    fn start(&mut self, pid: u32) -> Option<u64> {
        (self.vivo && pid == 4242).then_some(777)
    }
    fn terminate(&mut self, p: Proc) -> Fate {
        self.terminados.push(p);
        self.vivo = false;
        Fate::Killed
    }
}

/// Un sistema que no deja probar nada: lo que dejó un runtime anterior queda a la vista.
fn sistema_a_ciegas() -> FalsoOs {
    FalsoOs { start: None, table: None, fate: Fate::Killed, terminados: vec![] }
}

/// Un sistema que prueba que el proceso ya no existe.
fn sistema_sin_el_proceso() -> FalsoOs {
    FalsoOs { start: None, table: Some(vec![]), fate: Fate::Gone, terminados: vec![] }
}

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn con_store<R>(core: &Core, f: impl FnOnce(&mut crate::store::Store) -> R) -> R {
    core.storage.with_store(f).expect("el almacén del Core está abierto")
}

/// Un Attempt `running` con su claim `started`, tres instrucciones (una en vuelo, dos en cola) y una acción externa que ocurrió sin quedar en
/// el Event Log (una línea v2 en el journal): lo que deja un Core que cae en mitad del trabajo, con algo para CADA paso de la recuperación.
fn escenario() -> (Arc<Core>, String) {
    let f = fixture(Arc::new(FakeAdapter::full("fake")));
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());
    f.core.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&f.task)).unwrap();
    assert!(f.core.dispatch_mark_started(&f.attempt).unwrap());
    for (request, body) in [("r1", "en vuelo"), ("r2", "en cola uno"), ("r3", "en cola dos")] {
        f.core
            .queue_enqueue(&PuertoOcupado, &persona(), &CancelToken::new(), &QueueRequest { request_id: request, attempt_id: &f.attempt, body, attachments: &[] })
            .unwrap_or_else(|e| panic!("debía encolar {request}: {e}"));
    }
    con_store(&f.core, |st| st.queue_claim_next(&f.attempt, 500)).unwrap().expect("había algo que reclamar");
    let run = f.core.dispatch_snapshot(&f.attempt).unwrap().unwrap().task.run_id;
    let data = f.core.recovery_data_dir().expect("el Core arrancó");
    escribe_efecto(&data, &f.task, &run);
    (f.core, f.attempt)
}

/// Una línea v2 válida en el journal: una acción externa que ocurrió y no quedó registrada.
fn escribe_efecto(data: &Path, task: &str, run: &str) {
    let line = json!({
        "v": 2, "effect_id": EFECTO, "at": 1_800_000_000_000_i64, "operation": "spawn", "kind": "pty_process",
        "task": task, "run": run, "project": null, "actor_kind": "system", "actor_id": null, "channel": "core",
        "observed": { "launched": true },
    });
    std::fs::write(data.join("unrecorded-effects.jsonl"), format!("{line}\n")).unwrap();
}

/// Un uuid v7 válido y fijo: la clave de deduplicación del efecto.
const EFECTO: &str = "01900000-0000-7000-8000-000000000185";

/// Lo observable tras recuperar, sin ids (que cambian de una ejecución a otra): estado del Attempt, instrucciones, sesión y los hechos del
/// Event Log por tipo. Dos arranques que convergen producen la MISMA huella.
fn huella(core: &Core, attempt: &str) -> Value {
    let (status, claim, failure) = row(core, attempt);
    let cola: Vec<Value> = con_store(core, |st| st.queue_of_attempt(attempt)).unwrap().into_iter().map(|i| json!([i.body, format!("{:?}", i.status), format!("{:?}", i.failure)])).collect();
    let hechos: Vec<(String, i64)> = con_store(core, |st| {
        st.read(|c| {
            let mut stmt = c.prepare("SELECT kind, count(*) FROM events GROUP BY kind ORDER BY kind")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    })
    .unwrap();
    json!({ "attempt": [status, claim, failure], "cola": cola, "hechos": hechos })
}

fn paso(core: &Core, phase: Phase) -> super::recovery::Step {
    core.recovery_snapshot().expect("hay informe").phase(phase).unwrap_or_else(|| panic!("falta el paso {}", phase.name())).step.clone()
}

// ---------------------------------------------------------------------------------------------
// El orden y el informe
// ---------------------------------------------------------------------------------------------

#[test]
fn el_arranque_ejecuta_los_pasos_en_su_orden_y_deja_el_informe_de_lo_que_cambio() {
    let (core, attempt) = escenario();
    let core = restart_fixture_core(core);

    let informe = core.recovery_snapshot().expect("el arranque deja un informe");
    assert_eq!(informe.runtime_instance, core.runtime_instance);
    let nombres: Vec<&str> = informe.phases.iter().map(|p| p.phase.name()).collect();
    assert_eq!(nombres, ["processes", "attempts", "dispatch_claims", "queue", "effects"], "el orden es fijo");
    assert_eq!(informe.halted_after, None);
    for (phase, cambios) in [(Phase::Processes, 0), (Phase::Attempts, 1), (Phase::DispatchClaims, 1), (Phase::Queue, 3), (Phase::Effects, 1)] {
        let step = paso(&core, phase);
        assert_eq!((step.status, step.changed), (Status::Done, cambios), "{}: {step:?}", phase.name());
    }
    assert!(informe.blocking().is_empty());
    assert_eq!(core.recovery_blocks_launch(), None, "recuperación completa: se puede lanzar");
    assert_eq!(row(&core, &attempt).0, "exited", "el Attempt que corría ya no tiene proceso: orfandad");
}

#[test]
fn la_recuperacion_solo_anade_hechos_y_nunca_repite_un_efecto() {
    let (core, attempt) = escenario();
    let contar = |c: &Core, kind: &str| con_store(c, |st| st.read(|conn| Ok(conn.query_row("SELECT count(*) FROM events WHERE kind = ?1", [kind], |r| r.get::<_, i64>(0))?))).unwrap();
    let (arranques, observados) = (contar(&core, "attempt.started"), contar(&core, "effect.observed"));
    assert_eq!(observados, 0, "el efecto del journal todavía no está en el Event Log");
    let core = restart_fixture_core(core);

    // El efecto del journal ocurrió UNA vez: la recuperación solo añade su hecho.
    assert_eq!(contar(&core, "effect.observed"), 1);
    // Y no se lanzó nada: ni un `attempt.started` nuevo, ni un claim ambiguo, ni un Attempt nuevo.
    assert_eq!(contar(&core, "attempt.started"), arranques, "recuperar no vuelve a lanzar el Attempt");
    assert_eq!(contar(&core, "attempt.dispatch_ambiguous"), 0, "había evidencia canónica: el claim se asienta, no se vuelve dudoso");
    assert_eq!(con_store(&core, |st| st.read(|c| Ok(c.query_row("SELECT count(*) FROM attempts", [], |r| r.get::<_, i64>(0))?))).unwrap(), 1, "ningún Attempt nuevo");
    assert_eq!(row(&core, &attempt), ("exited".into(), "settled".into(), None));
}

// ---------------------------------------------------------------------------------------------
// Caídas en cada frontera y convergencia
// ---------------------------------------------------------------------------------------------

/// Arranca tras una caída simulada en `punto` (sin caída: `None`) y vuelve a arrancar dos veces; devuelve la huella final.
fn converge_tras_caer_en(punto: Option<Phase>) -> Value {
    let (core, attempt) = escenario();
    crash_after(punto);
    let core = restart_fixture_core(core); // el arranque que «cae»
    crash_after(None);
    let informe = core.recovery_snapshot().unwrap();
    assert_eq!(informe.halted_after, punto, "el arranque se detuvo donde se pidió");
    if let Some(punto) = punto {
        let lugar = |p: Phase| Phase::ORDER.iter().position(|o| *o == p).unwrap();
        assert!(informe.phases.iter().all(|f| lugar(f.phase) <= lugar(punto)), "tras caer en `{}` no corre ningún paso posterior: {:?}", punto.name(), informe.phases.iter().map(|f| f.phase.name()).collect::<Vec<_>>());
    }
    let core = restart_fixture_core(core); // el siguiente arranque termina el trabajo
    let core = restart_fixture_core(core); // y uno más no cambia nada
    assert!(core.recovery_snapshot().unwrap().blocking().is_empty());
    huella(&core, &attempt)
}

#[test]
fn una_caida_en_cualquier_frontera_converge_al_mismo_estado_que_un_arranque_sin_caida() {
    let referencia = converge_tras_caer_en(None);
    // Sanidad: la referencia refleja de verdad lo recuperado (si estuviera vacía, la comparación no probaría nada).
    assert_eq!(referencia["attempt"], json!(["exited", "settled", null]));
    assert!(referencia["cola"].as_array().unwrap().iter().all(|i| i[1] == "Failed"), "{referencia}");
    assert!(referencia["hechos"].as_array().unwrap().iter().any(|h| h[0] == "effect.observed"), "{referencia}");

    for punto in Phase::ORDER {
        let huella = converge_tras_caer_en(Some(punto));
        assert_eq!(huella, referencia, "una caída tras `{}` no converge al mismo estado", punto.name());
    }
}

#[test]
fn repetir_la_recuperacion_no_escribe_nada_mas() {
    let (core, attempt) = escenario();
    let core = restart_fixture_core(core);
    let primera = huella(&core, &attempt);
    let rev = |c: &Core| c.storage.confirmed_rev().unwrap();
    let rev_primera = rev(&core);
    let core = restart_fixture_core(core);
    let segunda = huella(&core, &attempt);
    let core = restart_fixture_core(core);
    let tercera = huella(&core, &attempt);
    assert_eq!(primera, segunda, "el segundo arranque no añadió ni cambió nada");
    assert_eq!(segunda, tercera);
    assert_eq!((rev(&core), rev_primera), (rev_primera, rev_primera), "ni siquiera avanzó la revisión: no escribió nada");
    for phase in [Phase::Attempts, Phase::DispatchClaims, Phase::Queue, Phase::Effects] {
        assert_eq!(paso(&core, phase).changed, 0, "{}: ya no queda nada por recuperar", phase.name());
    }
}

// ---------------------------------------------------------------------------------------------
// Salud: lo que no se puede reconciliar con seguridad queda a la vista y frena los lanzamientos
// ---------------------------------------------------------------------------------------------

/// El Attempt `starting` de la fixture (aprobado, listo para despachar) con un proceso que dejó un runtime ANTERIOR registrado.
fn con_un_proceso_ajeno_sin_resolver() -> (super::adapter_launcher_tests::Fixture, Arc<FakeAdapter>) {
    let fake = Arc::new(FakeAdapter::full("fake"));
    let f = fixture(fake.clone());
    let host = con_store(&f.core, |st| super::host_identity::machine_id_of(st).unwrap());
    let hecho = OwnedFact { attempt_id: f.attempt.clone(), root_pid: 4242, root_start: Some(777), pgid: None, in_custody: false };
    con_store(&f.core, |st| st.ownership_sync(&host, "runtime-anterior", &[hecho], now_ms() as i64, 60_000).unwrap());
    (f, fake)
}

#[test]
fn un_proceso_que_no_se_puede_probar_bloquea_los_lanzamientos_y_se_resuelve_al_poder_probarlo() {
    let (f, fake) = con_un_proceso_ajeno_sin_resolver();
    let (_limpia, data, _core) = boot_tests::dirs();

    // El arranque no puede ni identificar ni cerrar el proceso: queda a la vista y NO se mata nada.
    let mut ciego = sistema_a_ciegas();
    f.core.recover_at_boot_with(&data, false, true, &mut ciego);
    assert!(ciego.terminados.is_empty());
    let procesos = paso(&f.core, Phase::Processes);
    assert_eq!(procesos.status, Status::Blocked, "{procesos:?}");
    assert!(procesos.note.as_deref().is_some_and(|n| n.contains(&f.attempt)), "el informe dice de qué Attempt: {procesos:?}");
    assert!(f.core.recovery_blocks_launch().is_some());

    // El despachador no lanza nada: ni directo ni por el barrido.
    let error = f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap_err();
    assert!(error.contains("recuperación"), "{error}");
    assert!(f.core.dispatch_approved(f.launcher.as_ref()).is_empty());
    assert!(fake.starts().is_empty(), "no se lanzó ningún proceso con la recuperación incompleta");
    assert_eq!(row(&f.core, &f.attempt).0, "starting", "el Attempt espera: no se cerró ni se perdió");

    // El barrido reintenta: con un sistema que prueba que el proceso ya no existe, se resuelve y se vuelve a poder lanzar.
    let mut sin_el_proceso = sistema_sin_el_proceso();
    f.core.recovery_retry_with(&mut sin_el_proceso);
    let resuelto = paso(&f.core, Phase::Processes);
    assert_eq!((resuelto.status, resuelto.changed), (Status::Done, 1), "se resolvió un proceso que ya no existía: {resuelto:?}");
    assert_eq!(f.core.recovery_blocks_launch(), None);
    assert!(matches!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()), Ok(DispatchResult::Launched)), "ya se puede lanzar");
    assert_eq!(fake.starts().len(), 1);
}

#[test]
fn reintentar_no_toca_lo_que_no_estaba_bloqueado() {
    let (f, _fake) = con_un_proceso_ajeno_sin_resolver();
    let (_limpia, data, _core) = boot_tests::dirs();
    // Recuperación completa (el proceso ya no existe): reintentar no consulta el sistema ni cambia el informe.
    f.core.recover_at_boot_with(&data, false, true, &mut sistema_sin_el_proceso());
    let antes = f.core.recovery_snapshot().unwrap();
    let mut espia = sistema_a_ciegas();
    f.core.recovery_retry_with(&mut espia);
    assert!(espia.terminados.is_empty());
    assert_eq!(f.core.recovery_snapshot().unwrap().phases, antes.phases);
}

#[test]
fn un_journal_ilegible_deja_la_recuperacion_incompleta_avisa_y_se_reintenta() {
    let (_limpia, data, core_dir) = boot_tests::dirs();
    // Un directorio donde debería haber un fichero: ni se lee ni se pierde nada.
    std::fs::create_dir(data.join("unrecorded-effects.jsonl")).unwrap();
    let (core, host, result) = boot_tests::arranca(&data, &core_dir);
    result.unwrap();

    let efectos = paso(&core, Phase::Effects);
    assert_eq!(efectos.status, Status::Blocked, "{efectos:?}");
    assert!(core.recovery_blocks_launch().is_some());
    assert!(host.notifications().iter().any(|(titulo, _)| titulo == "Lixbon: recuperación incompleta"), "se avisa a la persona: {:?}", host.notifications());
    assert!(data.join("unrecorded-effects.jsonl").is_dir(), "el artefacto se conserva intacto");

    // Cuando el journal vuelve a poder leerse, el barrido lo resuelve sin reiniciar.
    std::fs::remove_dir(data.join("unrecorded-effects.jsonl")).unwrap();
    core.periodic_sweep();
    assert_eq!(paso(&core, Phase::Effects).status, Status::Done);
    assert_eq!(core.recovery_blocks_launch(), None);
    boot_tests::suelta(core, &core_dir);
}

/// Arranca con ese journal y devuelve lo que dice el paso de efectos (y comprueba que no frena nada y que las líneas se conservan).
fn efectos_con_el_journal(contenido: &str) -> super::recovery::Step {
    let (_limpia, data, core_dir) = boot_tests::dirs();
    std::fs::write(data.join("unrecorded-effects.jsonl"), contenido).unwrap();
    let (core, _host, result) = boot_tests::arranca(&data, &core_dir);
    result.unwrap();
    let efectos = paso(&core, Phase::Effects);
    assert_eq!(core.recovery_blocks_launch(), None, "es seguro seguir operando: {efectos:?}");
    assert_eq!(std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap(), contenido, "las líneas se conservan para revisión manual");
    boot_tests::suelta(core, &core_dir);
    efectos
}

#[test]
fn las_lineas_antiguas_o_ilegibles_del_journal_piden_revision_pero_no_frenan_nada() {
    let v1 = "{\"v\":1,\"operation\":\"manual\",\"kind\":\"legacy\"}\n";
    let truncada = "{\"v\":2,\"effect_id\":\"truncado\"\n";
    for (que, contenido) in [("solo una línea v1", v1.to_string()), ("solo una línea truncada", truncada.to_string()), ("ambas", format!("{v1}{truncada}"))] {
        let efectos = efectos_con_el_journal(&contenido);
        assert_eq!(efectos.status, Status::Attention, "{que}: {efectos:?}");
        assert!(efectos.note.as_deref().is_some_and(|n| n.contains("línea(s)")), "{que}: {efectos:?}");
    }
}

#[test]
fn dos_lineas_con_el_mismo_efecto_y_datos_distintos_piden_revision_y_no_se_importan() {
    let linea = |lanzado: bool| {
        json!({
            "v": 2, "effect_id": EFECTO, "at": 1_800_000_000_000_i64, "operation": "spawn", "kind": "pty_process", "task": "t-1", "run": "r-1", "project": null,
            "actor_kind": "system", "actor_id": null, "channel": "core", "observed": { "launched": lanzado },
        })
    };
    let efectos = efectos_con_el_journal(&format!("{}\n{}\n", linea(true), linea(false)));
    assert_eq!(efectos.status, Status::Attention, "{efectos:?}");
    assert!(efectos.note.as_deref().is_some_and(|n| n.contains("mismo id")), "{efectos:?}");
    assert_eq!(efectos.changed, 0, "ante un conflicto no se elige una de las dos versiones");
}

// ---------------------------------------------------------------------------------------------
// ProviderSession tras una caída
// ---------------------------------------------------------------------------------------------

fn con_sesion(resumable: bool) -> (Arc<Core>, String) {
    let f = fixture(Arc::new(FakeAdapter::full("fake")));
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());
    f.core.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&f.task)).unwrap();
    assert!(f.core.dispatch_mark_started(&f.attempt).unwrap());
    let new = NewProviderSession { resumable, external_ref: Some(("ref-185".into(), SessionBinding::SessionId)) };
    con_store(&f.core, |st| super::session_ops::open(st, &MutationContext::core(), &f.attempt, &new)).expect("abre la sesión");
    (f.core, f.attempt)
}

#[test]
fn una_sesion_resumible_de_un_attempt_huerfano_queda_en_espera_y_lista_para_reanudar() {
    let (core, attempt) = con_sesion(true);
    assert_eq!(core.attempt_session_record(&attempt).unwrap().unwrap().status, SessionStatus::Open);

    let core = restart_fixture_core(core);
    let sesion = core.attempt_session_record(&attempt).unwrap().expect("la sesión sigue enlazada al Attempt");
    assert_eq!(sesion.status, SessionStatus::Idle, "nadie la usa: queda en espera, no abierta para siempre");
    assert!(sesion.resumable && sesion.external_ref.as_deref() == Some("ref-185"), "conserva con qué reanudarla");
    assert_eq!(row(&core, &attempt).0, "exited");

    // Repetir la recuperación no la toca otra vez.
    let antes = sesion.updated_at;
    let core = restart_fixture_core(core);
    assert_eq!(core.attempt_session_record(&attempt).unwrap().unwrap().updated_at, antes);
}

#[test]
fn una_sesion_no_resumible_no_se_ofrece_para_reanudar_tras_la_caida() {
    let (core, attempt) = con_sesion(false);
    let core = restart_fixture_core(core);
    let sesion = core.attempt_session_record(&attempt).unwrap().expect("la sesión sigue enlazada");
    // `idle` exige `resumable`: una sesión que no lo es se CIERRA (antes el arranque chocaba con esa restricción y el Core quedaba en solo lectura).
    assert_eq!(sesion.status, SessionStatus::Closed, "no queda atada a un Attempt que ya no corre ni se ofrece para reanudar");
    assert!(sesion.closed_at.is_some());
    assert!(!sesion.resumable, "la recuperación no inventa una capacidad que el proveedor no declaró");
    assert_eq!(core.health(), super::mutation::Health::Normal, "el arranque no degradó el Core");
    assert_eq!(paso(&core, Phase::Attempts).status, Status::Done);
    assert_eq!(row(&core, &attempt).0, "exited");
}

#[test]
fn una_sesion_ya_cerrada_no_se_toca_al_recuperar() {
    let (core, attempt) = con_sesion(true);
    let sesion = core.attempt_session_record(&attempt).unwrap().unwrap();
    con_store(&core, |st| super::session_ops::close(st, &MutationContext::core(), &sesion.id)).expect("cierra la sesión");
    let cerrada = core.attempt_session_record(&attempt).unwrap().unwrap();
    assert_eq!(cerrada.status, SessionStatus::Closed);

    let core = restart_fixture_core(core);
    let despues = core.attempt_session_record(&attempt).unwrap().unwrap();
    assert_eq!((despues.status, despues.closed_at, despues.updated_at), (SessionStatus::Closed, cerrada.closed_at, cerrada.updated_at), "una sesión cerrada no se modifica");
    assert_eq!(core.health(), super::mutation::Health::Normal);
    assert_eq!(paso(&core, Phase::Attempts).status, Status::Done);
}

#[test]
fn un_proceso_vivo_de_un_runtime_anterior_se_cierra_con_su_identidad_y_cuenta_como_cambio() {
    let (f, _fake) = con_un_proceso_ajeno_sin_resolver();
    let (_limpia, data, _core) = boot_tests::dirs();
    // Sigue vivo (misma hora de creación) y el sistema confirma que terminó.
    let mut vivo = SistemaConUnProceso { vivo: true, terminados: vec![] };
    f.core.recover_at_boot_with(&data, false, true, &mut vivo);
    assert!(vivo.terminados.iter().all(|p| *p == Proc { pid: 4242, start: 777 }) && !vivo.terminados.is_empty(), "{:?}", vivo.terminados);
    let procesos = paso(&f.core, Phase::Processes);
    assert_eq!((procesos.status, procesos.changed), (Status::Done, 1), "{procesos:?}");
    assert_eq!(f.core.recovery_blocks_launch(), None);
}

// ---------------------------------------------------------------------------------------------
// La consulta
// ---------------------------------------------------------------------------------------------

#[test]
fn la_consulta_recovery_report_dice_la_salud_y_solo_la_lee_una_person() {
    let (core, client, _ctx, _project) = core_with_project();
    let consulta = |args: Value| core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", "recovery_report", &args);

    let ok = consulta(json!({})).unwrap();
    assert_eq!(ok["health"], "complete");
    assert_eq!(ok["launch_allowed"], true);
    assert_eq!(ok["blocking"], json!([]));
    let fases: Vec<&str> = ok["phases"].as_array().unwrap().iter().map(|p| p["phase"].as_str().unwrap()).collect();
    assert_eq!(fases, ["processes", "attempts", "dispatch_claims", "queue", "effects"]);
    assert_eq!(ok["runtime_instance"], core.runtime_instance.as_str());

    assert!(consulta(json!({ "x": 1 })).unwrap_err().starts_with("recovery_report_invalid_request"));
    assert!(consulta(json!([])).unwrap_err().starts_with("recovery_report_invalid_request"));

    // Incompleta: lo dice y por qué, sin pids ni rutas.
    let attempt = "attempt-inexistente";
    core.recovery_force_blocked_for_tests(Phase::Processes, &format!("1 proceso(s) sin cerrar (Attempts: {attempt})"));
    let mal = consulta(json!({})).unwrap();
    assert_eq!((mal["health"].as_str(), mal["launch_allowed"].as_bool()), (Some("incomplete"), Some(false)));
    assert!(mal["blocking"][0].as_str().unwrap().starts_with("processes:"), "{mal}");
}

#[test]
fn la_consulta_no_responde_a_quien_no_es_una_person_autenticada() {
    let (core, _client, _ctx, _project) = core_with_project();
    // Un Agent (la CLI dentro de una tarea) no lee el informe.
    let agente = core.rpc(super::Caller::Agent(None), "", "recovery_report", &json!({}));
    assert!(agente.is_err(), "un Agent no debe leer el informe de recuperación");
}
