//! LXO-183 · propiedad persistente de procesos con Cores y procesos REALES: el registro al lanzar, el latido, y lo que hace un arranque con lo que dejó
//! el runtime anterior (cerrar con la identidad verificada, reconocer lo ya muerto, no tocar lo ajeno y dejar a la vista lo que no se puede probar).

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::adapter::{lanza_en_custodia, supervisor};
use super::attempt_e2e_tests::world;
use super::initial_approval_tests::e2e::restart_fixture_core;
use super::process_ownership::ReconcileReport;
use super::state::now_ms;
use super::Core;
use crate::proctable::{Fate, Os, Presence, Proc, RealOs};
use crate::store::{OwnedFact, OwnershipRow, OwnershipState, ReleaseReason};

const HOST: &str = "host-prueba";

/// Un proceso real de larga vida que se mata al soltarlo, pase lo que pase en la prueba.
struct Hijo(Child);

impl Hijo {
    fn nuevo() -> Hijo {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("ping");
            c.args(["-n", "139", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("139");
            c
        };
        Hijo(cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("lanzar un proceso de larga vida"))
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// La hora de creación TAL COMO la ve el sistema (la identidad que el supervisor registraría).
    fn start(&self) -> u64 {
        RealOs::default().start(self.pid()).expect("hora de creación del proceso")
    }

    fn vivo(&mut self) -> bool {
        self.0.try_wait().expect("estado del proceso").is_none()
    }

    /// Espera a que termine (lo mató un runtime nuevo). `false` si sigue vivo tras el plazo.
    fn muere(&mut self) -> bool {
        let limite = Instant::now() + Duration::from_secs(15);
        while Instant::now() < limite {
            if !self.vivo() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for Hijo {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn hecho(attempt: &str, pid: u32, start: Option<u64>) -> OwnedFact {
    OwnedFact { attempt_id: attempt.into(), root_pid: pid, root_start: start, pgid: None, in_custody: false }
}

/// Anota en la base de `core` un proceso como si lo sostuviera OTRO runtime (el que acaba de morir).
fn deja_el_runtime_anterior(core: &Core, attempt: &str, pid: u32, start: Option<u64>) {
    core.storage.with_store(|s| s.ownership_sync(HOST, "runtime-anterior", &[hecho(attempt, pid, start)], now_ms() as i64, 60_000).unwrap()).unwrap();
}

fn filas(core: &Core, attempt: &str) -> Vec<OwnershipRow> {
    core.storage.read_store(|s| s.ownership_of_attempt(attempt)).unwrap().unwrap()
}

/// El Attempt de la prueba: nace de verdad por `task_create`, así que existe para las claves foráneas.
fn attempt_de(w: &super::attempt_e2e_tests::World, request: &str) -> String {
    w.create("claude", request)
}

/// Un sistema operativo falso para ejercitar la duda sin depender del real.
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

// ---------------------------------------------------------------------------------------------
// Lo que un runtime sostiene
// ---------------------------------------------------------------------------------------------

#[test]
fn un_proceso_con_dueno_se_registra_con_su_identidad_y_se_libera_al_cerrarse() {
    let _serie = super::pty::pruebas::serie_custodia();
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-1");

    // Un proceso real con dueño cuyo cierre no se pudo probar: está en la custodia del supervisor.
    let p = lanza_en_custodia(&attempt);
    let reporte = w.core.process_ownership_sync().expect("el modelo está activo");
    assert_eq!((reporte.registered, reporte.unproven), (1, 1), "{reporte:?}");
    let viva = filas(&w.core, &attempt);
    assert_eq!(viva.len(), 1);
    assert_eq!((viva[0].state, viva[0].runtime_instance.as_str()), (OwnershipState::Unproven, w.core.runtime_instance.as_str()));
    assert!(viva[0].root_start.is_some(), "un proceso real se registra con su hora de creación: sin ella no se podría reconocer");
    let pid = viva[0].root_pid;
    assert_eq!(crate::proctable::presence(&mut RealOs::default(), Proc { pid, start: viva[0].root_start.unwrap() }), Presence::Alive);

    // El supervisor consigue cerrarlo con prueba: el siguiente latido lo libera y el proceso ya no existe.
    assert_eq!(supervisor::reap(), 0);
    let reporte = w.core.process_ownership_sync().unwrap();
    assert_eq!(reporte.released, 1, "{reporte:?}");
    let historia = filas(&w.core, &attempt);
    assert_eq!((historia[0].state, historia[0].release_reason), (OwnershipState::Released, Some(ReleaseReason::Closed)));
    // Ya no se puede terminar nada con esa identidad: el proceso murió (aunque el sistema aún conserve su objeto mientras `p` tenga su handle).
    assert_eq!(RealOs::default().terminate(Proc { pid, start: historia[0].root_start.unwrap() }), Fate::Gone);
    drop(p);
}

#[test]
fn el_latido_renueva_el_lease_de_lo_que_este_runtime_sostiene() {
    let _serie = super::pty::pruebas::serie_custodia();
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-2");
    let _p = lanza_en_custodia(&attempt);
    w.core.process_ownership_sync().unwrap();
    let antes = filas(&w.core, &attempt)[0].clone();
    std::thread::sleep(Duration::from_millis(5));
    w.core.process_ownership_sync().unwrap();
    let despues = filas(&w.core, &attempt)[0].clone();
    assert_eq!(despues.process_id, antes.process_id, "es la misma fila");
    assert!(despues.heartbeat_at > antes.heartbeat_at && despues.lease_until > antes.lease_until);
    supervisor::reap();
    w.core.process_ownership_sync();
}

#[test]
fn el_reporte_marca_un_lease_vencido_y_lo_de_otro_runtime_como_sin_latido() {
    let _serie = super::pty::pruebas::serie_custodia();
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-3");
    let _p = lanza_en_custodia(&attempt);
    w.core.process_ownership_sync().unwrap();
    let sano = w.core.process_ownership_report().unwrap();
    assert_eq!((sano["processes"][0]["this_runtime"].as_bool(), sano["processes"][0]["stale"].as_bool()), (Some(true), Some(false)));

    // El lease de lo propio vence: el latido dejó de funcionar.
    w.core.storage.with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE process_ownership SET lease_until = 1", [])?))).unwrap().unwrap();
    assert_eq!(w.core.process_ownership_report().unwrap()["processes"][0]["stale"], Value::Bool(true));
    supervisor::reap();
    w.core.process_ownership_sync();
}

// ---------------------------------------------------------------------------------------------
// Lo que dejó el runtime anterior
// ---------------------------------------------------------------------------------------------

#[test]
fn un_proceso_vivo_del_runtime_anterior_se_cierra_con_su_identidad() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-4");
    let mut hijo = Hijo::nuevo();
    deja_el_runtime_anterior(&w.core, &attempt, hijo.pid(), Some(hijo.start()));

    let r = w.core.process_ownership_reconcile();
    assert_eq!(r, ReconcileReport { gone: vec![], reaped: vec![attempt.clone()], unproven: vec![] });
    assert!(hijo.muere(), "el proceso que dejó el runtime anterior se cerró");
    let f = &filas(&w.core, &attempt)[0];
    assert_eq!((f.state, f.release_reason), (OwnershipState::Released, Some(ReleaseReason::Reaped)));
    // Resolver otra vez no hace nada: ya no hay filas vivas.
    assert_eq!(w.core.process_ownership_reconcile(), ReconcileReport::default());
}

#[test]
fn un_proceso_que_ya_murio_se_reconoce_como_gone() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-5");
    let mut hijo = Hijo::nuevo();
    let (pid, start) = (hijo.pid(), hijo.start());
    hijo.0.kill().unwrap();
    hijo.0.wait().unwrap();
    deja_el_runtime_anterior(&w.core, &attempt, pid, Some(start));

    let r = w.core.process_ownership_reconcile();
    assert_eq!((r.gone.clone(), r.reaped.is_empty(), r.unproven.is_empty()), (vec![attempt.clone()], true, true), "{r:?}");
    assert_eq!(filas(&w.core, &attempt)[0].release_reason, Some(ReleaseReason::Gone));
}

#[test]
fn un_pid_reutilizado_por_otro_proceso_no_se_toca() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-6");
    let mut ajeno = Hijo::nuevo();
    // La fila dice «el proceso con ESE pid, creado en OTRO instante»: el pid ahora es de otro. Es la clave de seguridad del registro.
    deja_el_runtime_anterior(&w.core, &attempt, ajeno.pid(), Some(ajeno.start() + 1));

    let r = w.core.process_ownership_reconcile();
    assert_eq!(r.gone, vec![attempt.clone()], "{r:?}");
    assert!(r.reaped.is_empty(), "no se mata a un proceso por su pid");
    assert!(ajeno.vivo(), "el proceso ajeno sigue vivo");
    assert_eq!(filas(&w.core, &attempt)[0].release_reason, Some(ReleaseReason::Gone));
}

#[test]
fn sin_hora_de_creacion_no_se_puede_reconocer_y_no_se_toca() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-7");
    let mut hijo = Hijo::nuevo();
    deja_el_runtime_anterior(&w.core, &attempt, hijo.pid(), None);

    let r = w.core.process_ownership_reconcile();
    assert_eq!(r.unproven, vec![attempt.clone()], "{r:?}");
    assert!(hijo.vivo(), "ante la duda no se mata");
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Unproven, "queda a la vista");
}

#[test]
fn si_el_sistema_no_deja_probar_nada_el_proceso_queda_a_la_vista_sin_matar() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-8");
    deja_el_runtime_anterior(&w.core, &attempt, 4242, Some(777));
    // Ni la hora de creación ni la tabla de procesos se pueden leer.
    let mut os = FalsoOs { start: None, table: None, fate: Fate::Killed, terminados: vec![] };
    let r = w.core.process_ownership_reconcile_with(&mut os);
    assert_eq!(r.unproven, vec![attempt.clone()], "{r:?}");
    assert!(os.terminados.is_empty(), "sin prueba de identidad no se mata nada");
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Unproven);
}

#[test]
fn si_matarlo_no_se_puede_probar_queda_a_la_vista_y_se_reintenta_en_el_siguiente_arranque() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-9");
    deja_el_runtime_anterior(&w.core, &attempt, 4242, Some(777));
    // Está vivo (misma hora) pero el sistema no confirma que terminara.
    let mut os = FalsoOs { start: Some(777), table: Some(vec![(4242, 1)]), fate: Fate::Unknown, terminados: vec![] };
    let r = w.core.process_ownership_reconcile_with(&mut os);
    assert_eq!(r.unproven, vec![attempt.clone()], "{r:?}");
    assert!(!os.terminados.is_empty(), "se intentó cerrar con su identidad");
    assert!(os.terminados.iter().all(|p| *p == Proc { pid: 4242, start: 777 }), "solo se tocó a ese proceso: {:?}", os.terminados);
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Unproven);

    // El siguiente arranque, esta vez con un sistema que sí confirma, lo resuelve (y lo sigue viendo como de un runtime anterior).
    let mut ok = FalsoOs { start: None, table: Some(vec![]), fate: Fate::Gone, terminados: vec![] };
    let r = w.core.process_ownership_reconcile_with(&mut ok);
    assert_eq!(r.gone, vec![attempt.clone()], "{r:?}");
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Released);
}

#[test]
fn reconciliar_no_toca_lo_que_este_runtime_sostiene() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-10");
    let mut hijo = Hijo::nuevo();
    // La fila es de ESTE runtime: el arranque no la resuelve (la resuelve el latido, no un arranque que no la lanzó).
    w.core.storage.with_store(|s| s.ownership_sync(HOST, &w.core.runtime_instance, &[hecho(&attempt, hijo.pid(), Some(hijo.start()))], now_ms() as i64, 60_000).unwrap()).unwrap();
    assert_eq!(w.core.process_ownership_reconcile(), ReconcileReport::default());
    assert!(hijo.vivo());
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Held);
}

// ---------------------------------------------------------------------------------------------
// Un reinicio de verdad
// ---------------------------------------------------------------------------------------------

#[test]
fn reiniciar_el_core_con_un_proceso_de_un_runtime_caido_lo_resuelve_al_arrancar() {
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-11");
    let mut hijo = Hijo::nuevo();
    // Un runtime anterior CAYÓ sin apagarse (no pudo anotar el cierre) y dejó este proceso registrado.
    deja_el_runtime_anterior(&w.core, &attempt, hijo.pid(), Some(hijo.start()));
    let instancia_vieja = w.core.runtime_instance.clone();

    // El Core actual se apaga por el camino normal y arranca otro sobre las mismas carpetas (otro runtime, otra instancia).
    let nuevo = restart_fixture_core(w.core);
    assert_ne!(nuevo.runtime_instance, instancia_vieja);
    assert!(hijo.muere(), "el arranque del runtime nuevo cerró el proceso que dejó el runtime caído");
    let f = &filas(&nuevo, &attempt)[0];
    assert_eq!((f.state, f.release_reason, f.runtime_instance.as_str()), (OwnershipState::Released, Some(ReleaseReason::Reaped), "runtime-anterior"));
}

#[test]
fn un_apagado_ordenado_deja_constancia_de_lo_que_cerro() {
    let _serie = super::pty::pruebas::serie_custodia();
    let w = world("claude", None);
    let attempt = attempt_de(&w, "own-12");
    let _p = lanza_en_custodia(&attempt);
    w.core.process_ownership_sync().unwrap();
    assert_eq!(filas(&w.core, &attempt)[0].state, OwnershipState::Unproven);

    // `shutdown` reintenta el cierre de la custodia y, después, anota el resultado: el proceso queda liberado, no «a la vista».
    w.core.shutdown();
    let f = &filas(&w.core, &attempt)[0];
    assert_eq!((f.state, f.release_reason), (OwnershipState::Released, Some(ReleaseReason::Closed)));
}

#[test]
fn antes_del_corte_no_hay_propiedad_de_procesos_y_no_rompe_nada() {
    let (_l, _d, _c, core) = super::attention_read_tests::core_listo();
    assert!(core.process_ownership_sync().is_none());
    assert_eq!(core.process_ownership_reconcile(), ReconcileReport::default());
}
