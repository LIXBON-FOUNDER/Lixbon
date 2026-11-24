//! Pruebas de la propiedad persistente de procesos en el almacén (migración 028, LXO-183). Aquí se prueba que la BASE impone las reglas aunque
//! alguien escriba SQL a mano; la verificación de identidad y el cierre de procesos están en `orch/process_ownership_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::attempts::*;
use super::tasks::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-ownership-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn evento(kind: &str, entity_kind: &str, entity_id: &str, t: &TaskRow) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: t.project_id.clone(),
        run_id: Some(t.run_id.clone()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

/// Un almacén con el corte hecho y una Task con dos Attempts (`a1`, ya terminado, y `a2`, vivo), lo que la tabla necesita para sus claves foráneas.
struct Mundo {
    s: Store,
    a1: String,
    a2: String,
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &super::migrate::embedded_post_cut(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "c:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }, 10, |r, t| Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)]))
        .unwrap();
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let vivo = |s: &mut Store| {
        let a = s.attempt_create_recorded(&raiz.id, &new, 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
        s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 101, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
        a.id
    };
    let a1 = vivo(&mut s);
    // Un segundo Attempt de la misma Task solo nace cuando el anterior terminó: se cierra el primero y se abre otro.
    s.attempt_transition_recorded(&a1, &AttemptAction::Finish { summary: String::new() }, 150, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t))).unwrap();
    let a2 = vivo(&mut s);
    Mundo { s, a1, a2 }
}

const HOST: &str = "host-a";
const LEASE: i64 = 60_000;

fn hecho(attempt: &str, pid: u32, start: Option<u64>, custodia: bool) -> OwnedFact {
    OwnedFact { attempt_id: attempt.into(), root_pid: pid, root_start: start, pgid: Some(pid), in_custody: custodia }
}

fn raw(s: &mut Store, sql: &str) -> Result<(), String> {
    s.write(|tx| {
        tx.execute_batch(sql)?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[test]
fn un_proceso_nuevo_se_registra_con_su_identidad_y_su_lease() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let r = w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    assert_eq!((r.registered, r.renewed, r.released, r.unproven, r.skipped), (1, 0, 0, 0, 0));
    let vivas = w.s.ownership_live().unwrap();
    assert_eq!(vivas.len(), 1);
    let f = &vivas[0];
    assert_eq!((f.attempt_id.as_str(), f.host_id.as_str(), f.runtime_instance.as_str()), (w.a2.as_str(), HOST, "rt-1"));
    assert_eq!((f.root_pid, f.root_start, f.pgid, f.state), (4242, Some(777), Some(4242), OwnershipState::Held));
    assert_eq!((f.lease_until, f.heartbeat_at, f.registered_at, f.released_at, f.release_reason), (1_000 + LEASE, 1_000, 1_000, None, None));
}

#[test]
fn el_latido_renueva_el_lease_sin_cambiar_la_identidad() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hechos = [hecho(&w.a2, 4242, Some(777), false)];
    w.s.ownership_sync(HOST, "rt-1", &hechos, 1_000, LEASE).unwrap();
    let r = w.s.ownership_sync(HOST, "rt-1", &hechos, 31_000, LEASE).unwrap();
    assert_eq!((r.registered, r.renewed, r.released), (0, 1, 0));
    let f = &w.s.ownership_live().unwrap()[0];
    assert_eq!((f.heartbeat_at, f.lease_until, f.registered_at, f.root_pid), (31_000, 31_000 + LEASE, 1_000, 4242));
    assert_eq!(w.s.ownership_of_attempt(&w.a2).unwrap().len(), 1, "renovar no crea filas");
}

#[test]
fn lo_que_el_supervisor_ya_no_tiene_abierto_se_libera_como_cerrado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    let r = w.s.ownership_sync(HOST, "rt-1", &[], 5_000, LEASE).unwrap();
    assert_eq!((r.registered, r.renewed, r.released), (0, 0, 1));
    assert!(w.s.ownership_live().unwrap().is_empty());
    let historia = w.s.ownership_of_attempt(&w.a2).unwrap();
    assert_eq!((historia[0].state, historia[0].released_at, historia[0].release_reason), (OwnershipState::Released, Some(5_000), Some(ReleaseReason::Closed)));
}

#[test]
fn un_cierre_sin_probar_queda_unproven_y_se_prueba_despues() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let r = w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), true)], 1_000, LEASE).unwrap();
    assert_eq!((r.registered, r.unproven), (1, 1));
    assert_eq!(w.s.ownership_live().unwrap()[0].state, OwnershipState::Unproven);
    // Se reintentó y esta vez se cerró: ya no figura abierto y la fila queda liberada.
    w.s.ownership_sync(HOST, "rt-1", &[], 2_000, LEASE).unwrap();
    assert!(w.s.ownership_live().unwrap().is_empty());
}

#[test]
fn un_reintento_del_mismo_runtime_libera_el_proceso_anterior_del_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    let r = w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 5151, Some(888), false)], 2_000, LEASE).unwrap();
    assert_eq!((r.registered, r.released), (1, 1));
    let historia = w.s.ownership_of_attempt(&w.a2).unwrap();
    assert_eq!(historia.len(), 2);
    assert_eq!((historia[0].root_pid, historia[0].state), (4242, OwnershipState::Released));
    assert_eq!((historia[1].root_pid, historia[1].state), (5151, OwnershipState::Held));
}

#[test]
fn un_proceso_vivo_de_otro_runtime_no_se_pisa_y_no_se_escribe_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-viejo", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    let err = w.s.ownership_sync(HOST, "rt-nuevo", &[hecho(&w.a1, 6161, Some(999), false), hecho(&w.a2, 5151, Some(888), false)], 2_000, LEASE).unwrap_err().to_string();
    assert!(err.contains("rt-viejo") && err.contains("4242"), "{err}");
    let vivas = w.s.ownership_live().unwrap();
    assert_eq!(vivas.len(), 1, "ni el conflictivo ni el otro Attempt entraron: la transacción se deshizo");
    assert_eq!(vivas[0].runtime_instance, "rt-viejo");
    // El MISMO proceso, ya en manos del runtime nuevo, sí se adopta (renueva y cambia de runtime).
    let r = w.s.ownership_sync(HOST, "rt-nuevo", &[hecho(&w.a2, 4242, Some(777), false)], 3_000, LEASE).unwrap();
    assert_eq!(r.renewed, 1);
    assert_eq!(w.s.ownership_live().unwrap()[0].runtime_instance, "rt-nuevo");
}

#[test]
fn un_attempt_que_esta_base_no_conoce_se_salta_sin_fallar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let r = w.s.ownership_sync(HOST, "rt-1", &[hecho("t99-a1", 4242, Some(777), false), hecho(&w.a2, 5151, Some(888), false)], 1_000, LEASE).unwrap();
    assert_eq!((r.registered, r.skipped), (1, 1));
}

#[test]
fn sin_hora_de_creacion_el_proceso_se_registra_pero_no_se_podra_reconocer() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, None, false)], 1_000, LEASE).unwrap();
    assert_eq!(w.s.ownership_live().unwrap()[0].root_start, None);
}

#[test]
fn resolver_libera_con_su_motivo_o_deja_el_proceso_a_la_vista() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-viejo", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    let id = w.s.ownership_live().unwrap()[0].process_id.clone();
    assert!(w.s.ownership_resolve(&id, OwnershipResolution::Unproven, 2_000).unwrap());
    assert_eq!(w.s.ownership_live().unwrap()[0].state, OwnershipState::Unproven);
    assert!(w.s.ownership_resolve(&id, OwnershipResolution::Release(ReleaseReason::Reaped), 3_000).unwrap());
    let fila = &w.s.ownership_of_attempt(&w.a2).unwrap()[0];
    assert_eq!((fila.state, fila.release_reason, fila.released_at), (OwnershipState::Released, Some(ReleaseReason::Reaped), Some(3_000)));
    assert!(!w.s.ownership_resolve(&id, OwnershipResolution::Release(ReleaseReason::Gone), 4_000).unwrap(), "una fila liberada ya no se resuelve");
}

#[test]
fn la_base_impone_un_proceso_vivo_por_attempt_y_por_identidad() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    let fila = |id: &str, attempt: &str, pid: u32, start: &str| {
        format!("INSERT INTO process_ownership (process_id, attempt_id, host_id, runtime_instance, root_pid, root_start, state, lease_until, heartbeat_at, registered_at) VALUES ('{id}', '{attempt}', 'host-a', 'rt-1', {pid}, '{start}', 'held', 1, 1, 1)")
    };
    let (a1, a2) = (w.a1.clone(), w.a2.clone());
    // Otro proceso vivo para el MISMO Attempt.
    assert!(raw(&mut w.s, &fila("x1", &a2, 9999, "5")).is_err());
    // El MISMO proceso (host + pid + hora) vivo en otro Attempt.
    assert!(raw(&mut w.s, &fila("x2", &a1, 4242, "777")).is_err());
    // Otro proceso en otro Attempt sí.
    raw(&mut w.s, &fila("x3", &a1, 9999, "5")).unwrap();
    // Un Attempt que no existe, no.
    assert!(raw(&mut w.s, &fila("x4", "fantasma-a1", 1234, "6")).is_err());
}

#[test]
fn la_base_protege_la_identidad_y_la_historia() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    assert!(raw(&mut w.s, "UPDATE process_ownership SET root_pid = 1").is_err(), "la identidad no cambia");
    assert!(raw(&mut w.s, "UPDATE process_ownership SET root_start = '1'").is_err());
    assert!(raw(&mut w.s, "UPDATE process_ownership SET state = 'released'").is_err(), "liberar exige fecha y motivo");
    raw(&mut w.s, "UPDATE process_ownership SET state = 'released', released_at = 9, release_reason = 'gone'").unwrap();
    assert!(raw(&mut w.s, "UPDATE process_ownership SET state = 'held', released_at = NULL, release_reason = NULL").is_err(), "lo liberado no vuelve a vivir");
    assert!(raw(&mut w.s, "UPDATE process_ownership SET release_reason = 'closed'").is_err(), "ni cambia de motivo");
    assert!(raw(&mut w.s, "DELETE FROM process_ownership").is_err(), "la historia no se borra");
    // Y una hora de creación que no es un número no entra.
    assert!(raw(&mut w.s, "INSERT INTO process_ownership (process_id, attempt_id, host_id, runtime_instance, root_pid, root_start, state, lease_until, heartbeat_at, registered_at) VALUES ('z', 'a', 'h', 'r', 1, 'abc', 'held', 1, 1, 1)").is_err());
}

#[test]
fn el_mismo_pid_con_otra_hora_de_creacion_es_otro_proceso_y_no_una_renovacion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(777), false)], 1_000, LEASE).unwrap();
    // El pid se reutilizó: es otro proceso. Renovar la fila dejaría registrada una identidad que ya no es la del proceso vivo.
    let r = w.s.ownership_sync(HOST, "rt-1", &[hecho(&w.a2, 4242, Some(999), false)], 2_000, LEASE).unwrap();
    assert_eq!((r.registered, r.renewed, r.released), (1, 0, 1), "{r:?}");
    let historia = w.s.ownership_of_attempt(&w.a2).unwrap();
    assert_eq!((historia[0].root_start, historia[0].state), (Some(777), OwnershipState::Released));
    assert_eq!((historia[1].root_start, historia[1].state), (Some(999), OwnershipState::Held));
}
