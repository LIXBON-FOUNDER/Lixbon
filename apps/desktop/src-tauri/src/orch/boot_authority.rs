//! Arranque autoritativo (slice C2b): observa, decide con [`decide_boot`] y actúa.
//!
//! Aquí vive la ÚNICA ruta que promociona `state.json` a SQLite. El orden es el del
//! diseño (`LIXBON-C2-diseno.md` §11.3), con el estado intermedio FENCED:
//!
//! ```text
//! LEGACY   validar el legado y la base · calcular la identidad · copia verificada `pre-authority`
//!   │      aplicar la valla (migración 002): C1/C2a ya no pueden abrir la instalación
//! FENCED   publicar `authority.json` = promoting {promotion_id, db_id, source_hash, source_bytes,
//!   │                                              sqlite_bootstrap_rev, sqlite_target_rev}
//! PROMOTING  COMMIT autoritativo (UNA transacción: fila, modo y metadata de autoridad)
//!   │
//! COMMITTED  publicar `authority.json` = authoritative
//!   │
//! AUTHORITATIVE
//! ```
//!
//! * La valla va **después** del preflight y de la copia: si el legado no es
//!   promocionable, o no se puede hacer la copia, la instalación sigue siendo
//!   LEGACY y los binarios antiguos pueden seguir abriéndola.
//! * La valla va **antes** de `promoting`: no hay ventana en la que C1/C2a puedan
//!   arrancar, ignorar el marcador y producir efectos externos.
//! * Una vez FENCED, el Core **nunca** degrada a `state.json`: un fallo posterior
//!   bloquea el arranque. Solo antes de la valla rige la política de bootstrap
//!   (degradar a `state.json` y reintentar en el siguiente arranque).
//! * El documento promovido sale de la ÚNICA lectura de `state.json` que se hasheó
//!   en la intención; antes del COMMIT se vuelve a leer solo para detectar cambios.
//!
//! # Migraciones posteriores a la valla (003+)
//! Se aplican en UN solo sitio ([`Core::apply_post_fence_migrations`]).
//!
//! **Invariante.** 003+ exige que `decide_boot` haya DEMOSTRADO que no hay contradicción entre el
//! protocolo externo (`authority.json`) y la autoridad interna (SQLite). No exige que el marcador
//! quede publicado: es la semántica de C2b y se conserva. SQLite es la autoridad; un marcador
//! inválido, futuro o contradictorio BLOQUEA; un marcador ausente con SQLite autoritativo válido es
//! reconstruible, y un `promoting` coherente con un COMMIT ya hecho es recuperable. La acción sobre
//! el marcador (reconstruir / confirmar) se INTENTA antes de levantar el techo, pero si su
//! publicación falla queda `marker_pending` y se reintenta en el siguiente arranque, sin impedir la
//! migración.
//!
//! ```text
//! 1. abrir (techo = valla)      el registro interno de SQLite NO basta para migrar
//! 2. decide_boot                marcador + base + legado; cualquier contradicción BLOQUEA aquí
//! 3. acción sobre el marcador   reconstruir (ausente) / confirmar (promoting coherente) / nada;
//!                               si la publicación falla -> `marker_pending`, no bloquea
//! 4. migraciones 003+           ya demostrada la coherencia; publicado o pendiente
//! ```
//!
//! Por qué el intento va antes que la migración: el marcador se deriva solo de la metadata de
//! autoridad (que una migración posterior no toca), así que no hay interacción entre ambos pasos.
//! Una caída entre 3 y 4 deja una instalación coherente que el siguiente arranque termina de
//! migrar; una migración que falla deja la base en la 002 y, si el marcador se pudo publicar, ya
//! correcto. Con la publicación pendiente la base puede quedar migrada con el marcador ausente o
//! en `promoting`: ambos son estados que C2b ya sabe resolver (`RebuildMarker` / `Complete`).
//! Ninguna ruta que BLOQUEA o DEGRADA llega al paso 4.

use std::path::{Path, PathBuf};

use super::authority::{
    classify_legacy, clean_staging, decide_boot, read_marker, write_marker, BlockReason, Boot, BootInputs, DbProbe, Legacy, Marker, MarkerRead, NO_SOURCE,
};
use super::fsio;
use super::mirror;
use super::state::State;
use super::store_boot::OpenStoreError;
use super::Core;
use crate::store::{self, new_uuid, sha256_hex, PromotionPlan, Store};

/// Lo que deja un arranque en el que SQLite manda.
pub(super) struct Authoritative {
    pub state: State,
    /// `rev` de la fila de SQLite tras el arranque.
    pub rev: i64,
    /// Documento (texto) de esa fila: lo que refleja el espejo.
    pub doc: String,
    pub promotion_id: String,
    /// SHA-256 del legado que se promocionó, para no tratarlo como ajeno al reconciliar.
    pub known_legacy_hash: Option<String>,
    pub promoted_now: bool,
    pub marker_pending: bool,
    /// ¿Hay que cerrar las tareas abiertas (`orphan_all`) pasando por `mutate`? Solo
    /// cuando el estado se cargó de SQLite; el promovido ya viene con ellas cerradas.
    pub needs_orphan: bool,
    /// Desde el corte Task/Attempt el estado vive en las tablas (LXO-232): `doc` va vacío y no hay espejo.
    pub on_tables: bool,
}

pub(super) enum BootResult {
    Authoritative(Box<Authoritative>),
    /// Política de bootstrap: el almacén quedó degradado y el Core sigue con `state.json`.
    Legacy,
}

/// Errores de la promoción, ya clasificados.
#[derive(Debug)]
pub(super) enum PromoteError {
    /// Antes de la valla y sin nada publicado: se puede seguir en modo legacy.
    Recoverable(String),
    /// La valla ya se cruzó (o hay intención publicada): no se degrada.
    Blocking(String),
    /// `state.json` cambió entre la intención y el COMMIT.
    LegacyChanged,
}

pub(super) struct Promoted {
    pub state: State,
    pub doc: String,
    pub plan: PromotionPlan,
    pub marker_pending: bool,
}

pub(super) struct PromoteCtx<'a> {
    pub core: &'a Path,
    pub data: &'a Path,
    /// Bytes de la única lectura de `state.json` (`None` = no había).
    pub legacy_bytes: Option<&'a [u8]>,
    /// La intención ya publicada que se rehace, si la hay.
    pub resume: Option<&'a Marker>,
}

fn state_path(data: &Path) -> PathBuf {
    data.join("state.json")
}

/// ¿Hay copias diagnósticas de `state.json`? Son rastro de una instalación existente.
fn diagnostic_copies_exist(data: &Path) -> bool {
    std::fs::read_dir(data)
        .map(|rd| {
            rd.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                ["state.json.invalido-", "state.json.divergente-", "state.json.cambiado-"].iter().any(|p| n.starts_with(p))
            })
        })
        .unwrap_or(false)
}

/// ¿Existen copias `pre-authority`? Indicio de que la promoción llegó a empezar.
fn pre_authority_backups_exist(core: &Path) -> bool {
    std::fs::read_dir(core.join("backups"))
        .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().contains("pre-authority")))
        .unwrap_or(false)
}

fn authority_error(detail: impl Into<String>) -> OpenStoreError {
    OpenStoreError::Authority { detail: detail.into() }
}

impl Core {
    /// Observa la instalación, decide y actúa. `Err` = bloqueante (el Core no arranca).
    pub(super) fn boot_authority(&self, data: &Path, core: &Path) -> Result<BootResult, OpenStoreError> {
        clean_staging(core);
        let marker = read_marker(core);
        let (legacy_bytes, legacy) = match std::fs::read(state_path(data)) {
            Ok(b) => {
                let l = classify_legacy(Some(&b));
                (Some(b), l)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, Legacy::Absent),
            Err(e) => (None, Legacy::Unreadable(format!("no se pudo leer: {e}"))),
        };
        let traces = diagnostic_copies_exist(data);
        let evidence = pre_authority_backups_exist(core);

        // Con marcador y sin base no se abre nada: abrir la recrearía vacía.
        if !matches!(marker, MarkerRead::Absent) && !core.join("lixbon.db").exists() {
            let d = decide_boot(&BootInputs { marker: &marker, probe: &DbProbe::FileMissing, legacy: &legacy, traces, evidence });
            let Boot::Block(reason) = d else { unreachable!("marcador sin base siempre bloquea") };
            return Err(self.block(&reason, data, core));
        }

        let probe = match self.storage.open_for_boot(core) {
            Ok(()) => match self.storage.with_store(|s| s.authority_facts()) {
                Some(Ok(f)) => DbProbe::Opens(f),
                Some(Err(e)) => DbProbe::Unopenable(e.to_string()),
                None => DbProbe::Unopenable("el almacén no está abierto".into()),
            },
            Err(e) if e.is_blocking() => return Err(e),
            Err(e) => DbProbe::Unopenable(e.to_string()),
        };

        let decision = decide_boot(&BootInputs { marker: &marker, probe: &probe, legacy: &legacy, traces, evidence });
        match decision {
            Boot::Block(reason) => Err(self.block(&reason, data, core)),
            Boot::DegradeC1 => {
                let why = match &probe {
                    DbProbe::Unopenable(m) => m.clone(),
                    _ => "el almacén no está disponible".into(),
                };
                self.degrade_storage(&OpenStoreError::Other { detail: why });
                Ok(BootResult::Legacy)
            }
            Boot::Normal => {
                self.apply_post_fence_migrations()?;
                self.cut_if_switched(data, core)?;
                self.load_authoritative(&probe, false, false)
            }
            Boot::RebuildMarker => {
                let DbProbe::Opens(f) = &probe else { unreachable!() };
                let rebuilt = f.auth.as_ref().and_then(|a| Marker::from_database(f, a)).ok_or_else(|| authority_error("no se pudo reconstruir el marcador de autoridad desde la base"))?;
                let pending = write_marker(core, &rebuilt, ("marker_final_tmp", "marker_final_published")).is_err();
                self.apply_post_fence_migrations()?;
                self.cut_if_switched(data, core)?;
                self.load_authoritative(&probe, false, pending)
            }
            Boot::Complete => {
                let MarkerRead::Valid(m) = &marker else { unreachable!() };
                let pending = write_marker(core, &m.confirmed(), ("marker_final_tmp", "marker_final_published")).is_err();
                self.apply_post_fence_migrations()?;
                self.cut_if_switched(data, core)?;
                self.load_authoritative(&probe, false, pending)
            }
            Boot::Redo => {
                let MarkerRead::Valid(m) = &marker else { unreachable!() };
                self.promote(data, core, legacy_bytes.as_deref(), Some(m))
            }
            Boot::Promote { .. } | Boot::PromoteFresh { .. } => self.promote(data, core, legacy_bytes.as_deref(), None),
        }
    }

    /// Carga el estado de la fila de SQLite (arranque ya promovido).
    fn load_authoritative(&self, probe: &DbProbe, promoted_now: bool, marker_pending: bool) -> Result<BootResult, OpenStoreError> {
        let DbProbe::Opens(f) = probe else { unreachable!() };
        let auth = f.auth.as_ref();
        // Base cortada (LXO-232): el estado se reconstruye desde las tablas; `legacy_state` está congelado.
        if let Some(state) = self.storage.load_from_tables()? {
            let rev = self.storage.confirmed_rev().map_err(|e| authority_error(e))?.unwrap_or(0);
            return Ok(BootResult::Authoritative(Box::new(Authoritative {
                state,
                rev,
                doc: String::new(),
                promotion_id: auth.map(|a| a.promotion_id.clone()).unwrap_or_default(),
                known_legacy_hash: None,
                promoted_now,
                marker_pending,
                needs_orphan: true,
                on_tables: true,
            })));
        }
        let row = self
            .storage
            .with_store(|s| s.legacy_state())
            .ok_or_else(|| authority_error("el almacén no está abierto"))?
            .map_err(OpenStoreError::from)?
            .ok_or_else(|| authority_error("la base es autoritativa pero no tiene fila de estado"))?;
        let state: State = serde_json::from_str(&row.doc)
            .map_err(|e| authority_error(format!("el estado guardado en SQLite no se puede interpretar: {e}. No se usa state.json en su lugar")))?;
        Ok(BootResult::Authoritative(Box::new(Authoritative {
            state,
            rev: row.rev,
            doc: row.doc,
            promotion_id: auth.map(|a| a.promotion_id.clone()).unwrap_or_default(),
            known_legacy_hash: auth.map(|a| a.source_hash.clone()).filter(|h| h != NO_SOURCE),
            promoted_now,
            marker_pending,
            needs_orphan: true,
            on_tables: false,
        })))
    }

    /// Ejecuta la promoción (o rehace una intención publicada).
    fn promote(&self, data: &Path, core: &Path, legacy_bytes: Option<&[u8]>, resume: Option<&Marker>) -> Result<BootResult, OpenStoreError> {
        let ctx = PromoteCtx { core, data, legacy_bytes, resume };
        let outcome = self.storage.with_store(|store| promote_in_store(store, &ctx)).ok_or_else(|| authority_error("el almacén no está abierto"))?;
        match outcome {
            Ok(p) => {
                // La promoción terminó (COMMIT y marcador): desde aquí la instalación es autoritativa.
                self.apply_post_fence_migrations()?;
                if self.cut_if_switched(data, core)? {
                    // Recién promovida y cortada en el mismo arranque: el estado ya vive en las tablas.
                    let state = self.storage.load_from_tables()?.ok_or_else(|| authority_error("el corte terminó pero la base no está cortada"))?;
                    let rev = self.storage.confirmed_rev().map_err(authority_error)?.unwrap_or(0);
                    return Ok(BootResult::Authoritative(Box::new(Authoritative {
                        state,
                        rev,
                        doc: String::new(),
                        promotion_id: p.plan.promotion_id,
                        known_legacy_hash: None,
                        promoted_now: true,
                        marker_pending: p.marker_pending,
                        needs_orphan: false,
                        on_tables: true,
                    })));
                }
                Ok(BootResult::Authoritative(Box::new(Authoritative {
                    known_legacy_hash: Some(p.plan.source_hash.clone()).filter(|h| h != NO_SOURCE),
                    rev: p.plan.sqlite_target_rev,
                    promotion_id: p.plan.promotion_id,
                    state: p.state,
                    doc: p.doc,
                    promoted_now: true,
                    marker_pending: p.marker_pending,
                    needs_orphan: false,
                    on_tables: false,
                })))
            }
            Err(PromoteError::Recoverable(why)) => {
                self.degrade_storage(&OpenStoreError::Other { detail: format!("no se pudo preparar la promoción a SQLite ({why}); se reintentará en el siguiente arranque") });
                Ok(BootResult::Legacy)
            }
            Err(PromoteError::Blocking(why)) => Err(authority_error(format!("la promoción a SQLite no se pudo completar: {why}. Nada se ha perdido: state.json y la copia pre-authority siguen donde estaban"))),
            Err(PromoteError::LegacyChanged) => Err(self.block(&BlockReason::LegacyChangedAfterIntent, data, core)),
        }
    }

    /// Aplica las migraciones posteriores a la valla (003+). El ÚNICO sitio que lo hace, y solo se
    /// llega aquí desde las ramas autoritativas de [`Core::boot_authority`], es decir, con
    /// `decide_boot` ya habiendo demostrado que no hay contradicción (ver la cabecera del módulo);
    /// NO depende de que el marcador haya quedado publicado (`marker_pending`). Un fallo es siempre BLOQUEANTE: la instalación ya es autoritativa, así que nunca se
    /// vuelve a `state.json`, y la transacción deshecha deja la base como estaba (v2).
    fn apply_post_fence_migrations(&self) -> Result<(), OpenStoreError> {
        let outcome = self.storage.migrate_authoritative().ok_or_else(|| authority_error("el almacén no está abierto"))?;
        match outcome {
            Ok(_) => Ok(()),
            Err(e) => {
                let e = OpenStoreError::from(e);
                if e.is_blocking() {
                    Err(e)
                } else {
                    Err(authority_error(format!(
                        "no se pudieron aplicar las migraciones del almacén: {e}. La instalación es autoritativa en SQLite: no se vuelve a state.json. La base quedó como estaba"
                    )))
                }
            }
        }
    }

    /// El corte Task/Attempt en el arranque (LXO-234): tras las migraciones anteriores y con `core.lock` tomado, solo con
    /// el interruptor de dogfood y sin una espera de restauración. `true` si cortó ahora. Si falla, el arranque se
    /// bloquea (D13): la transacción del corte se deshizo y la base quedó como estaba.
    fn cut_if_switched(&self, data: &Path, core: &Path) -> Result<bool, OpenStoreError> {
        if !super::agentic_cut::switch_on() {
            return Ok(false);
        }
        if super::agentic_cut::held(core) {
            eprintln!("[core] {} está puesto, pero tras restaurar la copia previa no se vuelve a cortar ({} en {})", super::agentic_cut::SWITCH, super::agentic_cut::HOLD_FILE, core.display());
            return Ok(false);
        }
        let outcome = self.storage.with_store(|s| super::agentic_cut::run(s, core, data, env!("CARGO_PKG_VERSION"))).ok_or_else(|| authority_error("el almacén no está abierto"))?;
        match outcome {
            Ok(super::agentic_cut::CutReport::Applied { backup, before, after }) => {
                eprintln!(
                    "[core] corte Task/Attempt aplicado: {} Tasks, {} Attempts (copia previa: {})",
                    before.tasks,
                    after.attempts,
                    backup.display()
                );
                super::startup_cut::record(super::startup_cut::applied_view(&backup));
                // Con el corte aplicado cae la barrera: las migraciones posteriores a él (015…) se aplican en ESTE arranque y
                // no en el siguiente. Si no, durante toda esta sesión la base no admitiría las causas de entorno nuevas.
                self.apply_post_fence_migrations()?;
                Ok(true)
            }
            Ok(super::agentic_cut::CutReport::AlreadyCut) => {
                super::startup_cut::record(super::startup_cut::already_cut_view());
                Ok(false)
            }
            Err(e) => {
                let msg = format!(
                    "no se pudo pasar al modelo Task/Attempt: {e}. La base no cambió. Para arrancar con el modelo anterior, quita {}=1",
                    super::agentic_cut::SWITCH
                );
                super::startup_cut::record(super::startup_cut::failed_view(&msg));
                Err(authority_error(msg))
            }
        }
    }

    /// Convierte un bloqueo en error de arranque, conservando antes las copias
    /// diagnósticas que correspondan. Ningún mensaje sugiere borrar el marcador.
    fn block(&self, reason: &BlockReason, data: &Path, core: &Path) -> OpenStoreError {
        let copy = match reason {
            BlockReason::LegacyUnreadable(_) => mirror::preserve_copy(data, "invalido").ok(),
            BlockReason::LegacyChangedAfterIntent => mirror::preserve_copy(data, "cambiado").ok(),
            _ => None,
        };
        let mut detail = reason.to_string();
        if let Some(c) = &copy {
            detail.push_str(&format!(" (copia: {})", c.display()));
        }
        detail.push_str(&format!(
            ". Datos: {}; almacén: {}; copias de seguridad: {}. No copies state.json sobre la base ni la base sobre state.json: hace falta un conjunto coherente de artefactos",
            data.display(),
            core.display(),
            core.join("backups").display()
        ));
        authority_error(detail)
    }
}

/// La promoción propiamente dicha, sobre un `Store` ya abierto bajo `core.lock`.
pub(super) fn promote_in_store(store: &mut Store, ctx: &PromoteCtx<'_>) -> Result<Promoted, PromoteError> {
    // Antes de la valla un fallo es recuperable (política de bootstrap); con la valla
    // ya aplicada, nunca se vuelve a `state.json`.
    let fail = |store: &Store, why: String| -> PromoteError {
        if store.is_fenced().unwrap_or(true) {
            PromoteError::Blocking(why)
        } else {
            PromoteError::Recoverable(why)
        }
    };

    let db_id = store.ensure_db_id().map_err(|e| fail(store, e.to_string()))?;

    // La identidad de la promoción: la intención ya publicada, o una nueva.
    let plan = match ctx.resume {
        Some(m) => m.plan(),
        None => {
            let (source_hash, source_bytes) = match ctx.legacy_bytes {
                Some(b) => (sha256_hex(b), b.len() as u64),
                None => (NO_SOURCE.to_string(), 0),
            };
            let bootstrap = store.legacy_state().map_err(|e| fail(store, e.to_string()))?.map(|r| r.rev).unwrap_or(0);
            // Una revisión corrupta (negativa, `i64::MAX`) no se promociona: bloquea, no desborda.
            PromotionPlan::new(new_uuid(), source_hash, source_bytes, bootstrap).map_err(|e| PromoteError::Blocking(e.to_string()))?
        }
    };

    // El documento sale de los bytes que se hashearon (una sola lectura).
    let mut state: State = match ctx.legacy_bytes {
        Some(b) => serde_json::from_slice(b).map_err(|e| fail(store, format!("state.json no es un estado válido: {e}")))?,
        None => State::default(),
    };
    state.orphan_all();
    let doc = serde_json::to_string(&state).map_err(|e| fail(store, e.to_string()))?;

    let promoting = match ctx.resume {
        Some(m) => m.clone(),
        None => {
            // 1. Copia verificada: ANTES de la valla, así un fallo aquí no cruza nada.
            let backup = store.backup("pre-authority").map_err(|e| fail(store, e.to_string()))?;
            store.verify_backup(&backup).map_err(|e| fail(store, e.to_string()))?;
            if let Some(b) = ctx.legacy_bytes {
                let dest = ctx.core.join("backups").join(format!("state.pre-authority.{}.json", &plan.source_hash[..8]));
                fsio::write_atomic_durable(&dest, b, true).map_err(|e| fail(store, format!("no se pudo copiar state.json a backups: {e}")))?;
                let back = std::fs::read(&dest).map_err(|e| fail(store, e.to_string()))?;
                if sha256_hex(&back) != plan.source_hash {
                    return Err(fail(store, "la copia de state.json no coincide con el original".into()));
                }
            }
            store::crash_point("backup_done");

            // 2. La valla (migración 002). Si falla y no quedó aplicada, seguimos LEGACY.
            if !store.is_fenced().map_err(|e| fail(store, e.to_string()))? {
                if let Err(e) = store.apply_fence(&store::embedded(), env!("CARGO_PKG_VERSION")) {
                    return Err(fail(store, format!("no se pudo aplicar la valla de compatibilidad: {e}")));
                }
            }

            // 3. La intención, ya con la valla puesta. Si no se puede publicar no hay
            // marcador y, como la valla ya se cruzó, no se degrada: se bloquea.
            let promoting = Marker::promoting(&plan, &db_id);
            write_marker(ctx.core, &promoting, ("marker_promoting_tmp", "marker_promoting_published"))
                .map_err(|e| PromoteError::Blocking(format!("no se pudo publicar authority.json: {e}")))?;
            promoting
        }
    };

    // 4. Última comprobación del legado antes del COMMIT: detecta, no cambia lo que se promueve.
    let now = std::fs::read(state_path(ctx.data)).ok();
    let unchanged = match (&now, plan.source_hash.as_str()) {
        (None, NO_SOURCE) => true,
        (Some(b), h) if h != NO_SOURCE => sha256_hex(b) == h && b.len() as u64 == plan.source_bytes,
        _ => false,
    };
    if !unchanged {
        return Err(PromoteError::LegacyChanged);
    }

    // 5. T2: una sola transacción.
    store.promote_to_authoritative(&plan, &doc).map_err(|e| PromoteError::Blocking(e.to_string()))?;

    // 6. T3: confirmar. Si falla, el marcador `promoting` ya impide el fallback.
    let marker_pending = write_marker(ctx.core, &promoting.confirmed(), ("marker_final_tmp", "marker_final_published")).is_err();
    Ok(Promoted { state, doc, plan, marker_pending })
}

