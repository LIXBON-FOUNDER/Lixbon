//! Arranque y parada del Core: hilos de barrido, servidor local y cierre de runs inactivos.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use serde_json::json;
use super::host::Host;
use super::events::MutationContext;
use super::boot_authority::{Authoritative, BootResult};
use super::effect_journal::RecoveryReport;
use super::mirror::{self, Reconciled};
use super::store_boot::{OpenStoreError, StorageReport};
use super::{Core, IDLE_CLOSE_MS, SWEEP_EVERY, Settings, agents, core_dir, data_dir, discovery_file, lxo_path, read_json, server, skill, state, write_json, write_private_json};
use super::state::{Kind, State};
use super::fsio::cli_installation_file;
use crate::secure_store::{self, SecretStore};

/// Prueba de que se llama desde el arranque: `Core::adopt_state` la exige y solo
/// este módulo puede crearla (el campo y el constructor son privados aquí).
pub(super) struct BootProof(());

impl BootProof {
    fn new() -> Self {
        BootProof(())
    }

    /// Las pruebas preparan el estado inicial como lo haría el arranque.
    #[cfg(test)]
    pub(super) fn for_tests() -> Self {
        BootProof(())
    }
}

impl Core {
    /// Arranca el Core. `Err` solo si hay un motivo BLOQUEANTE: `core.lock` tomado
    /// por otro Core o inaccesible (sin él no hay un único escritor garantizado), una
    /// base incompatible con este binario, o el protocolo de autoridad (C2b): marcador
    /// inválido, marcador y base contradictorios, `state.json` ilegible o ausente en
    /// una instalación existente, o la base inaccesible con evidencia de promoción. En
    /// ese caso no se arrancan ni el servidor ni los hilos, y quien llama debe
    /// terminar. Solo un fallo de la base ANTES de promover (disco, permisos, base
    /// corrupta, copia o valla que no se pudieron hacer) deja el Core funcionando,
    /// degradado, con `state.json`; con la valla cruzada nunca se vuelve a él.
    pub fn init(self: &Arc<Self>, host: Arc<dyn Host>) -> Result<(), String> {
        self.init_in(host, &data_dir(), &core_dir())
    }

    /// `init` con las carpetas explícitas: `data` (`settings.json` y `state.json`
    /// legacy) y `core` (`lixbon.db`, `core.lock`, `backups/`).
    pub(super) fn init_in(self: &Arc<Self>, host: Arc<dyn Host>, data: &Path, core: &Path) -> Result<(), String> {
        self.set_host(host);
        // 1. El bloqueo de instancia va ANTES de leer o reescribir state.json: un
        // segundo Core no puede llegar a hacer `orphan_all()` sobre el estado del
        // primero. Si no se puede garantizar el único escritor (tomado, no creable,
        // inaccesible), no se arranca: cualquier error aquí es bloqueante.
        if let Err(e) = self.acquire_instance_lock(core) {
            return Err(self.refuse_to_start(&e));
        }
        // 2. Autoridad del estado (C2b): marcador + base + legado -> `decide_boot` -> acción.
        // Abre la base SOLO hasta donde permite la valla, valida y promociona (o carga el
        // estado de SQLite). Todo fallo posterior a la valla, o con evidencia de
        // promoción, es BLOQUEANTE: no se vuelve a `state.json`. No se lee ni se
        // reescribe `state.json` antes de saber qué manda.
        let boot = match self.boot_authority(data, core) {
            Ok(b) => b,
            Err(e) => return Err(self.refuse_to_start(&e)),
        };
        let settings: Settings = read_json(&data.join("settings.json")).unwrap_or_default();
        let proof = BootProof::new();
        match boot {
            BootResult::Authoritative(a) => self.finish_authoritative(&proof, data, *a),
            BootResult::Legacy => {
                // Política de bootstrap (almacén degradado ANTES de promocionar): el estado
                // sale de `state.json` como siempre. Aquí `state.json` es legible o no existe:
                // un archivo ilegible ya bloqueó el arranque en `decide_boot`.
                let mut st: State = read_json(&data.join("state.json")).unwrap_or_default();
                st.orphan_all();
                let _ = write_json(&data.join("state.json"), &st);
                self.adopt_state(&proof, st); // carga inicial: no es una mutación
            }
        }
        // Reconciliar hechos v2 agrega solo `effect.observed`; nunca vuelve a ejecutar
        // Git, PTY ni filesystem. En modo legacy no hay Event Log y las líneas se conservan.
        match self.reconcile_unrecorded_effects(data) {
            Ok(report) => self.announce_reconciled_effects(&report),
            Err(error) => eprintln!("[core] no se pudo leer el journal de efectos ({:?})", error.kind()),
        }
        // Líneas v1/corruptas o v2 que no pudieron importarse requieren revisión: se avisa,
        // no se esconde ni se descarta su diagnóstico.
        match Self::unrecorded_effects(data) {
            Ok(unrecorded) if unrecorded > 0 => {
                let msg = format!("{unrecorded} acción(es) externa(s) se ejecutaron sin quedar registradas (ver unrecorded-effects.jsonl en {}): revísalas antes de repetirlas.", data.display());
                eprintln!("[core] {msg}");
                if let Some(host) = self.host.get() {
                    host.notify("Lixbon: acciones sin registrar", &msg);
                }
            }
            Ok(_) => {}
            Err(_) => {
                let msg = "No se pudo leer unrecorded-effects.jsonl; revísalo antes de repetir acciones externas.";
                eprintln!("[core] {msg}");
                if let Some(host) = self.host.get() {
                    host.notify("Lixbon: journal de efectos no disponible", msg);
                }
            }
        }
        let enabled = settings.enabled;
        if let Ok(mut s) = self.settings.lock() {
            *s = settings;
        }
        if enabled {
            let _ = self.start_server();
            skill::refresh_outdated(&lxo_path().to_string_lossy());
            // Preguntar a cada CLI por sus modelos tarda: se hace ya para que el
            // primer `lxo agents` del coordinador responda al momento.
            std::thread::spawn(|| agents::available(false));
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(core) = weak.upgrade() {
                core.close_idle_runs();
                drop(core);
                std::thread::sleep(SWEEP_EVERY);
            }
        });
        // Vencimiento de lanzamientos pendientes (y de los de coordinadores que ya no siguen).
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(core) = weak.upgrade() {
                core.sweep_pending();
                drop(core);
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        // Relleno perezoso de `project_id` (slice D): fuera del camino crítico del arranque, con
        // presupuesto de tiempo, idempotente. Sin registro (almacén degradado) no hace nada.
        // En pruebas se llama a mano para que sea determinista.
        if !cfg!(test) {
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || {
                if let Some(core) = weak.upgrade() {
                    if let Err(e) = core.backfill_projects(super::projects::BACKFILL_BUDGET) {
                        eprintln!("[core] relleno de proyectos: {e}");
                    }
                }
            });
        }
        Ok(())
    }

    /// SQLite manda: adopta su estado, instala su persistencia y deja el espejo vigente.
    fn finish_authoritative(&self, proof: &BootProof, data: &Path, a: Authoritative) {
        let Authoritative { state, rev, doc, promotion_id, known_legacy_hash, promoted_now, marker_pending, needs_orphan } = a;
        self.adopt_state(proof, state); // carga inicial: no es una mutación
        self.install_persistence(proof, self.storage.sqlite_persistence(data, rev));
        // El espejo es una copia: un fallo aquí no invalida nada, solo se diagnostica.
        match mirror::reconcile(data, rev, &doc, known_legacy_hash.as_deref()) {
            Ok(Reconciled::DivergentPreserved(copy)) => {
                let msg = format!("state.json contenía cambios que no vienen de SQLite (probablemente lo escribió una versión anterior de Lixbon). SQLite manda; se conservó una copia en {}", copy.display());
                eprintln!("[core] {msg}");
                if let Some(host) = self.host.get() {
                    host.notify("Lixbon: cambios ajenos en state.json", &msg);
                }
            }
            Ok(_) => {}
            Err(e) => self.mirror_failed_at_boot(proof, &e.to_string()),
        }
        if needs_orphan {
            self.close_orphans();
        }
        // `close_orphans` puede haber avanzado la fila: el informe lleva la revisión
        // realmente confirmada al terminar el arranque, no la que se cargó.
        let rev = match self.storage.confirmed_rev() {
            Ok(Some(confirmed)) => confirmed,
            other => {
                eprintln!("[core] no se pudo releer la revisión confirmada tras el arranque ({other:?}); se informa la cargada");
                rev
            }
        };
        self.storage.set_ready(StorageReport { rev, promotion_id, promoted_now, marker_pending });
    }

    /// Cierra las tareas que quedaron abiertas al apagarse el Core anterior. Pasa por
    /// `mutate` (persiste en SQLite); si no hay nada que cerrar, no escribe.
    fn close_orphans(&self) {
        let r = self.mutate(|tx| {
            if !tx.tasks.values().any(|t| !t.status.is_final() && !t.external) {
                tx.no_change();
                return Ok(());
            }
            tx.orphan_all();
            Ok(())
        });
        if let Err(e) = r {
            eprintln!("[core] no se pudieron cerrar las tareas huérfanas: {e}");
        }
    }

    /// El Core no puede arrancar: lo dice por `stderr` y avisa a la persona.
    fn refuse_to_start(&self, e: &OpenStoreError) -> String {
        let msg = format!("Lixbon no puede iniciar el Core: {e}");
        eprintln!("[core] {msg}");
        if let Some(host) = self.host.get() {
            host.notify("Lixbon no puede iniciar", &msg);
        }
        msg
    }

    pub(super) fn close_idle_runs(&self) {
        let live = self.live_ids();
        let idle = self.lock().idle_runs(state::now_ms(), IDLE_CLOSE_MS, &live);
        for run in idle {
            let noted = self.mutate(|st| {
                let Some(root) = st.runs.get(&run).map(|r| r.root.clone()) else {
                    st.no_change();
                    return Ok(false);
                };
                if let Ok(id) = st.post(&root, &root, Kind::Note, "Run cerrado por inactividad (30 min sin actividad ni hijas en marcha)", None) {
                    st.mark_read(&[id]);
                }
                Ok(true)
            });
            if !matches!(noted, Ok(true)) {
                continue;
            }
            let _ = self.close_run(&MutationContext::core(), &run, false);
        }
    }

    pub fn shutdown(&self) {
        // Sin el mapa de terminales bloqueado mientras corre cada matador (ver `kill_all_terms`).
        self.kill_all_terms();
        // Procesos cuya construcción falló y no se pudieron matar entonces (ver `pty::reap_unowned`).
        super::pty::reap_unowned();
        self.stop_server();
    }

    pub(super) fn start_server(self: &Arc<Self>) -> Result<(), String> {
        let secrets = secure_store::default_store();
        self.start_server_with(secrets.as_ref(), &cli_installation_file(), &discovery_file())
    }

    pub(super) fn start_server_with(
        self: &Arc<Self>,
        secrets: &dyn SecretStore,
        installation_file: &Path,
        discovery: &Path,
    ) -> Result<(), String> {
        let mut slot = self.server.lock().map_err(|_| "Estado interno corrupto")?;
        if slot.is_some() {
            return Ok(());
        }
        let _ = std::fs::remove_file(discovery);
        let identity = self.ensure_cli_identity_with(installation_file, secrets)?;
        self.revoke_stale_cli_and_agent_credentials(&identity.client_id)?;
        let h = server::start(self.clone())?;
        if let Err(error) = write_private_json(discovery, &json!({
            "port": h.port,
            "client_id": identity.client_id,
            "installation_id": identity.installation_id,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "lxo": lxo_path(),
        })) {
            h.stop();
            return Err(error);
        }
        *slot = Some(h);
        Ok(())
    }

    pub(super) fn stop_server(&self) {
        self.stop_server_with(&discovery_file());
    }

    pub(super) fn stop_server_with(&self, discovery: &Path) {
        if let Some(h) = self.server.lock().ok().and_then(|mut s| s.take()) {
            h.stop();
            let _ = std::fs::remove_file(discovery);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::{MemoryStore, SecretKey, SecretStore};
    use crate::store::{ClientAuthentication, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

    fn register_agent(core: &Core, task: &str, installation: &str, secret: &str) {
        let registration = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new(installation, None).unwrap(),
        )
        .unwrap();
        let credential = ClientCredential::new(ClientPrincipal::Agent(task.into()), secret).unwrap();
        core.storage
            .with_store(|store| store.register_client(&registration, &credential, state::now_ms() as i64))
            .unwrap()
            .unwrap();
    }

    #[test]
    fn arranque_publica_solo_metadatos_y_un_reinicio_revoca_tokens_agent() {
        let (_cleanup, data, core_dir) = super::super::boot_tests::dirs();
        let (core, _host, started) = super::super::boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secrets = MemoryStore::new();
        let install_dir = data.join("cli");
        std::fs::create_dir_all(&install_dir).unwrap();
        let install_file = install_dir.join("cli-client.json");
        let discovery = install_dir.join("orch.json");
        let agent_token_before = "agent-before-restart-token-test-only-32bytes";
        let old_person_token = "old-person-cli-token-before-recovery-test-32bytes";
        register_agent(&core, "task-before-restart", "install-agent-before-restart", agent_token_before);
        let old_person_registration = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new("old-person-installation", None).unwrap(),
        ).unwrap();
        let old_person_credential = ClientCredential::new(ClientPrincipal::Person("user".into()), old_person_token).unwrap();
        core.storage.with_store(|store| store.register_client(&old_person_registration, &old_person_credential, state::now_ms() as i64)).unwrap().unwrap();

        core.start_server_with(&secrets, &install_file, &discovery).unwrap();
        let first: serde_json::Value = serde_json::from_slice(&std::fs::read(&discovery).unwrap()).unwrap();
        assert!(first["port"].as_u64().is_some());
        assert!(first["client_id"].as_str().is_some());
        assert!(first["installation_id"].as_str().is_some());
        assert!(first["version"].as_str().is_some());
        assert!(first["lxo"].as_str().is_some());
        assert!(first.get("token").is_none());
        assert!(!first.to_string().contains(agent_token_before));
        assert!(matches!(core.authenticate_client_status(agent_token_before).unwrap(), ClientAuthentication::Revoked(_)));
        assert!(matches!(core.authenticate_client_status(old_person_token).unwrap(), ClientAuthentication::Revoked(_)));

        let installation_id = first["installation_id"].as_str().unwrap().to_string();
        let client_id = first["client_id"].as_str().unwrap().to_string();
        let key = SecretKey::lixbon(&format!("client/cli/{installation_id}")).unwrap();
        let person_secret = secrets.get(&key).unwrap().expose().to_string();
        assert!(!first.to_string().contains(&person_secret));

        let agent_token_after = "agent-during-run-token-test-only-32-bytes";
        register_agent(&core, "task-during-run", "install-agent-during-run", agent_token_after);
        core.stop_server_with(&discovery);
        core.start_server_with(&secrets, &install_file, &discovery).unwrap();
        let second: serde_json::Value = serde_json::from_slice(&std::fs::read(&discovery).unwrap()).unwrap();
        assert_eq!(second["installation_id"], installation_id);
        assert_eq!(second["client_id"], client_id);
        assert_eq!(secrets.get(&key).unwrap().expose(), person_secret);
        assert!(matches!(core.authenticate_client_status(agent_token_after).unwrap(), ClientAuthentication::Revoked(_)));
        core.stop_server_with(&discovery);
        assert!(!discovery.exists());
    }
}

impl Core {
    /// La reconciliación demuestra que el efecto ocurrió, pero NO repara `legacy_state`: la persona debe
    /// comprobar el estado (tarea, rama, PR, proceso) antes de repetir la acción.
    fn announce_reconciled_effects(&self, report: &RecoveryReport) {
        if let Some(kind) = report.ack_failed {
            eprintln!("[core] no se pudo compactar el journal de efectos ({kind:?}); se reintentará al arrancar");
        }
        if report.recovered == 0 {
            return;
        }
        const LISTED: usize = 5;
        let mut listed = report
            .recovered_effects
            .iter()
            .take(LISTED)
            .map(|effect| format!("{}/{} (tarea {})", effect.operation, effect.kind, effect.task))
            .collect::<Vec<_>>()
            .join(", ");
        if report.recovered > LISTED {
            listed.push_str(&format!(" y {} más", report.recovered - LISTED));
        }
        let msg = format!(
            "{} acción(es) externa(s) ya ocurrida(s) se añadieron al Event Log, pero Lixbon NO ha reparado el estado: {listed}. Comprueba el estado (tarea, rama, PR o proceso) antes de repetirlas.",
            report.recovered
        );
        eprintln!("[core] {msg}");
        if let Some(host) = self.host.get() {
            host.notify("Lixbon: acciones recuperadas, estado sin reparar", &msg);
        }
    }
}
