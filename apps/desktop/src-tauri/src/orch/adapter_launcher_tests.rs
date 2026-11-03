//! El `Launcher` real (LXO-246, PR B) de extremo a extremo: Core persistente, git real, SQLite y adapters falsos en un
//! registro propio de la prueba (para poder mirar y forzar lo que llega a `start`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::adapter::fake::FakeAdapter;
use super::adapter::{AdapterError, CancelToken, Capability, CapabilityMatrix, CapabilityState, EventSink, ProbeResult, ProviderAdapter, RunHandle, RunOutcome, StartRequest};
use super::adapter_launcher::AdapterLauncher;
use super::dispatch::{DispatchResult, Launcher, PrepareError, PreparedLaunch};
use super::dispatch_tests::{event_count, row};
use super::initial_approval_tests::e2e::core_with_pending_attempt_at;
use super::provider_registry::LiveRegistry;
use super::Core;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Un repositorio con un commit, en una carpeta propia y exclusiva. Nunca se borra.
pub(in crate::orch) fn repo_with_commit() -> PathBuf {
    let tick = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let repo = std::env::temp_dir().join(format!("lxo-246b-{}-{tick}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))).join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "LXO 246"]);
    git(&repo, &["config", "user.email", "lxo-246@example.test"]);
    std::fs::write(repo.join("README.md"), "base\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    repo
}

pub(in crate::orch) fn registry_of(adapter: Arc<dyn ProviderAdapter>) -> Arc<LiveRegistry> {
    let registry = LiveRegistry::with_builder(Box::new(move || vec![Arc::clone(&adapter)]), Duration::from_secs(60));
    registry.probe_all();
    registry
}

/// Un Core con un repositorio real, su primer Attempt aprobado (provider `fake`, el de la fixture) y un lanzador real sobre `adapter`.
pub(in crate::orch) struct Fixture {
    pub(in crate::orch) core: Arc<Core>,
    pub(in crate::orch) task: String,
    pub(in crate::orch) attempt: String,
    pub(in crate::orch) repo: PathBuf,
    pub(in crate::orch) launcher: Arc<AdapterLauncher>,
}

pub(in crate::orch) fn fixture(adapter: Arc<dyn ProviderAdapter>) -> Fixture {
    fixture_with_ttl(adapter, None)
}

/// Lo mismo, con otro plazo para las peticiones del proveedor (las pruebas no esperan minutos).
pub(in crate::orch) fn fixture_with_ttl(adapter: Arc<dyn ProviderAdapter>, ttl: Option<Duration>) -> Fixture {
    let repo = repo_with_commit();
    let (core, ctx, task, attempt) = core_with_pending_attempt_at(&repo.to_string_lossy());
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    let mut launcher = AdapterLauncher::new(&core, registry_of(adapter));
    if let Some(ttl) = ttl {
        launcher = launcher.with_approval_ttl(ttl);
    }
    Fixture { core, task, attempt, repo, launcher: Arc::new(launcher) }
}

pub(in crate::orch) fn worktree_dir(f: &Fixture) -> PathBuf {
    f.repo.parent().unwrap().join("repo.lixbon-wt").join(&f.attempt)
}

fn branch(f: &Fixture) -> String {
    let run: String = f.core.dispatch_snapshot(&f.attempt).unwrap().unwrap().task.run_id;
    format!("lx/{run}/{}", f.attempt)
}

fn branches(repo: &Path) -> Vec<String> {
    git(repo, &["branch", "--format=%(refname:short)"]).lines().map(str::to_owned).collect()
}

pub(in crate::orch) fn worktree_state(core: &Core, attempt: &str) -> Option<String> {
    core.storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT state FROM worktrees WHERE attempt_id = ?1", [attempt], |r| r.get::<_, String>(0)).ok())))
        .unwrap()
        .unwrap()
}

#[test]
fn un_attempt_aprobado_se_lanza_por_el_adapter_con_su_worktree() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    // La ejecución se queda viva: el bombeo la escucha en su hilo (PR C) y esta prueba mira el estado mientras corre.
    fake.set_script(vec![super::adapter::fake::Step::Wait]);
    let f = fixture(fake.clone());

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::Launched);

    // Lo que llegó al adapter: el Attempt, su worktree real, el spec persistido, el perfil y la selección.
    let starts = fake.starts();
    assert_eq!(starts.len(), 1);
    let start = &starts[0];
    assert_eq!((start.attempt_id.as_str(), start.prompt.as_str(), start.profile.as_str()), (f.attempt.as_str(), "haz algo", "explorar"));
    assert_eq!(std::fs::canonicalize(&start.worktree).unwrap(), std::fs::canonicalize(worktree_dir(&f)).unwrap());
    assert!(start.worktree.is_dir());
    assert_eq!(git(&start.worktree, &["rev-parse", "--abbrev-ref", "HEAD"]), branch(&f));

    // Estado durable: running con claim started, un solo attempt.started y el Worktree activo vinculado.
    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "started".into(), None));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.started"), 1);
    assert_eq!(worktree_state(&f.core, &f.attempt).as_deref(), Some("active"));

    // La ejecución aceptada ya es de quien la escucha: sale de `started` y consta como proceso vivo del Core.
    assert!(f.launcher.take_started(&f.attempt).is_none());
    assert!(f.core.has_term(&f.task));

    // Un Attempt con claim no se lanza otra vez.
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::AlreadyClaimed);
    assert_eq!(fake.starts().len(), 1);
    // Se cancela para que el hilo no espere al tope del guion.
    assert_eq!(f.core.kill_term(&f.task), Ok(true));
}

#[test]
fn si_el_adapter_no_atiende_la_peticion_el_attempt_falla_y_el_worktree_se_libera() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.fail_start_with(Some(AdapterError::provider("la CLI se cerró al arrancar")));
    let f = fixture(fake.clone());

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::NotSpawned);
    assert_eq!(row(&f.core, &f.attempt), ("failed".into(), "settled".into(), Some("launch_failed".into())));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.started"), 1, "attempt.started va antes de llamar al proveedor");
    assert!(fake.starts().is_empty());
    // Nada queda: ni carpeta, ni rama; el Worktree consta como quitado.
    assert!(!worktree_dir(&f).exists());
    assert!(!branches(&f.repo).contains(&branch(&f)));
    assert_eq!(worktree_state(&f.core, &f.attempt).as_deref(), Some("removed"));
    assert!(f.launcher.take_started(&f.attempt).is_none());
}

#[test]
fn si_el_entorno_se_bloquea_justo_al_lanzar_el_attempt_se_detiene_y_nunca_falla() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.fail_start_with(Some(AdapterError::environment_blocked(super::agents::EnvBlock::CliMissing)));
    let f = fixture(fake);

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::Unavailable);
    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.failed"), 0);
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.stopped"), 1);
    assert!(!worktree_dir(&f).exists());
}

#[test]
fn si_la_capability_desaparece_antes_de_preparar_no_se_crea_nada() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    let f = fixture(fake.clone());
    // El proveedor cambió desde que se creó la Task: ya no ofrece lanzar.
    fake.set_probe(ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available().with(Capability::Start, CapabilityState::Unsupported)));
    f.launcher_registry_refresh();

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::NotLaunched { stopped: true });
    // Desde `starting`, sin attempt.started ni worktree: el proveedor y git no se tocaron.
    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.started"), 0);
    assert!(fake.starts().is_empty());
    assert!(!worktree_dir(&f).exists());
    assert!(worktree_state(&f.core, &f.attempt).is_none());
}

#[test]
fn sin_el_proveedor_registrado_no_hay_nada_que_lanzar() {
    // El registro del lanzador tiene otro proveedor: `fake` no existe para él.
    let f = fixture(Arc::new(FakeAdapter::full("otro")));
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::NotLaunched { stopped: true });
    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
    assert!(!worktree_dir(&f).exists());
}

#[test]
fn si_falla_el_worktree_el_attempt_falla_desde_starting_sin_llamar_al_proveedor() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    let f = fixture(fake.clone());
    // Una carpeta ajena ocupa el sitio del worktree: la creación falla y no se toca.
    let existing = worktree_dir(&f);
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::write(existing.join("ajeno.txt"), "no es tuyo").unwrap();

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::NotLaunched { stopped: false });
    assert_eq!(row(&f.core, &f.attempt), ("failed".into(), "settled".into(), Some("launch_failed".into())));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.started"), 0);
    assert!(fake.starts().is_empty());
    assert_eq!(std::fs::read_to_string(existing.join("ajeno.txt")).unwrap(), "no es tuyo");
}

/// Un adapter que entra en pánico al lanzar: pudo haber creado el proceso.
struct PanicAdapter;

impl ProviderAdapter for PanicAdapter {
    fn id(&self) -> &str {
        "fake"
    }
    fn probe(&self) -> ProbeResult {
        ProbeResult::ready(Some("0.0.0-panic"), CapabilityMatrix::all_available())
    }
    fn start(&self, _req: StartRequest, _cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        panic!("el adapter se rompió después de crear el proceso");
    }
    fn events(&self, _run: &RunHandle, _cancel: &CancelToken, _sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        Err(AdapterError::unknown_run())
    }
}

#[test]
fn un_panico_al_lanzar_es_un_desenlace_desconocido_y_no_se_libera_nada() {
    let f = fixture(Arc::new(PanicAdapter));

    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::OutcomeUnknown);
    // Ni se da por fallido ni se asienta, y el worktree (que el proceso puede estar usando) sigue ahí.
    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "started".into(), None));
    assert!(worktree_dir(&f).is_dir());
    assert_eq!(worktree_state(&f.core, &f.attempt).as_deref(), Some("active"));
    assert!(f.launcher.take_started(&f.attempt).is_none(), "no hay una ejecución confirmada que bombear");
    // Y no se relanza.
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::AlreadyClaimed);
}

/// Un lanzador que delega en el real y, entre `prepare` y `attempt.started`, detiene la Task (como un cierre de Run).
struct StopsBetween {
    inner: Arc<AdapterLauncher>,
    core: Arc<Core>,
    task: String,
}

impl Launcher for StopsBetween {
    fn prepare(&self, intent: &super::dispatch::DispatchIntent) -> Result<Box<dyn PreparedLaunch>, PrepareError> {
        let prepared = self.inner.prepare(intent)?;
        self.core.mutate_as(&super::events::MutationContext::core(), |tx| tx.close(&self.task, super::state::Status::Stopped, "detenida").map(|_| ())).unwrap();
        Ok(prepared)
    }
}

#[test]
fn si_el_attempt_se_cierra_tras_preparar_se_abandona_y_se_libera_el_worktree() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    let f = fixture(fake.clone());
    let task = f.core.dispatch_snapshot(&f.attempt).unwrap().unwrap().task.id;
    let stopper = StopsBetween { inner: f.launcher.clone(), core: f.core.clone(), task };

    assert_eq!(f.core.dispatch_attempt(&f.attempt, &stopper).unwrap(), DispatchResult::NotLaunched { stopped: true });
    assert!(fake.starts().is_empty(), "el proveedor no se llamó");
    assert!(!worktree_dir(&f).exists(), "abandon liberó lo que prepare creó");
    assert!(!branches(&f.repo).contains(&branch(&f)));
    assert_eq!(row(&f.core, &f.attempt).1, "settled");
}

impl Fixture {
    /// Vuelve a sondear el registro del lanzador (como el barrido en segundo plano): recoge el cambio del adapter.
    fn launcher_registry_refresh(&self) {
        self.launcher.registry_for_tests().probe_all();
    }
}
