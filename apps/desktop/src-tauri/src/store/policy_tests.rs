//! Pruebas de los overrides de policy en el almacén (migración 023, LXO-209). Cubren `docs/core/POLICY.md`: la revisión que avanza de
//! uno en uno, la escritura optimista (`Stale`), que repetir no deja rastro, que fila + revisión + Event son una sola transacción
//! (también cuando el Event falla), que el SQL directo no puede saltarse los valores ni la revisión, y que antes del corte no hay
//! nada que escribir. Las REGLAS de seguridad se prueban en `orch/policy_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-policy-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Las migraciones del binario con el CORTE sustituido por una migración vacía (la 023 va después de la barrera).
fn con_el_corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

fn abre(dir: &Path, activo: bool) -> Store {
    let mut s = Store::open_with(dir, &con_el_corte_neutro(), "t").unwrap();
    if activo {
        s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    }
    s
}

fn evento(kind: &str, scope: &str) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::Decision,
        actor_kind: ActorKind::Person,
        actor_id: Some("ana".into()),
        channel: Some("ui".into()),
        client_id: Some("cli-desktop".into()),
        project_id: None,
        run_id: None,
        entity_kind: "policy".into(),
        entity_id: scope.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

fn set(kind: &str, id: &str, category: &str, level: &str) -> PolicyWrite {
    PolicyWrite::Set { scope_kind: kind.into(), scope_id: id.into(), category: category.into(), level: level.into() }
}

fn reset(kind: &str, id: &str, category: &str) -> PolicyWrite {
    PolicyWrite::Reset { scope_kind: kind.into(), scope_id: id.into(), category: category.into() }
}

fn aplica(s: &mut Store, expected: i64, w: &PolicyWrite) -> StoreResult<PolicyChange> {
    s.policy_apply_recorded(expected, w, "ana", 5_000, |_, _| Ok(evento("policy.changed", "global")))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

#[test]
fn una_base_nueva_empieza_en_la_revision_0_y_sin_overrides() {
    let t = Tmp::new();
    let s = abre(t.path(), true);
    assert_eq!(s.policy_snapshot().unwrap(), PolicySnapshot { revision: 0, rows: vec![] });
}

#[test]
fn fijar_un_nivel_avanza_la_revision_guarda_la_fila_y_deja_su_evento_en_la_misma_transaccion() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let events = cuenta(&s, "events");
    let r = s
        .policy_apply_recorded(0, &set("global", "", "steer", "deny"), "ana", 5_000, |previo, rev| {
            assert_eq!(previo, None);
            assert_eq!(rev, 1);
            Ok(evento("policy.changed", "global"))
        })
        .unwrap();
    assert_eq!(r, PolicyChange::Changed { revision: 1, previous: None });
    let snap = s.policy_snapshot().unwrap();
    assert_eq!(snap.revision, 1);
    assert_eq!(snap.level_of("global", "", "steer"), Some("deny"));
    assert_eq!(snap.rows[0].set_by, "ana");
    assert_eq!(snap.rows[0].revision, 1);
    assert_eq!(cuenta(&s, "events"), events + 1, "el cambio no existe sin su hecho");
}

#[test]
fn cambiar_de_nivel_reemplaza_la_fila_y_entrega_el_nivel_anterior() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    aplica(&mut s, 0, &set("project", "p1", "fork", "confirm")).unwrap();
    let mut visto = None;
    let r = s
        .policy_apply_recorded(1, &set("project", "p1", "fork", "deny"), "ana", 6_000, |previo, _| {
            visto = previo.map(str::to_string);
            Ok(evento("policy.changed", "project:p1"))
        })
        .unwrap();
    assert_eq!(r, PolicyChange::Changed { revision: 2, previous: Some("confirm".into()) });
    assert_eq!(visto.as_deref(), Some("confirm"));
    assert_eq!(cuenta(&s, "policy_overrides"), 1, "una fila por (ámbito, categoría)");
    assert_eq!(s.policy_snapshot().unwrap().level_of("project", "p1", "fork"), Some("deny"));
}

#[test]
fn repetir_lo_mismo_no_avanza_la_revision_ni_deja_otro_evento() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    aplica(&mut s, 0, &set("global", "", "queue", "confirm")).unwrap();
    let events = cuenta(&s, "events");
    let r = s.policy_apply_recorded(1, &set("global", "", "queue", "confirm"), "ana", 7_000, |_, _| unreachable!("sin cambio no hay Event")).unwrap();
    assert_eq!(r, PolicyChange::Unchanged { revision: 1 });
    // Volver a heredar lo que ya hereda tampoco cambia nada.
    let r = s.policy_apply_recorded(1, &reset("global", "", "stop"), "ana", 7_000, |_, _| unreachable!()).unwrap();
    assert_eq!(r, PolicyChange::Unchanged { revision: 1 });
    assert_eq!(cuenta(&s, "events"), events);
    assert_eq!(s.policy_snapshot().unwrap().revision, 1);
}

#[test]
fn una_revision_vieja_es_stale_y_no_escribe_nada() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    aplica(&mut s, 0, &set("global", "", "queue", "confirm")).unwrap();
    let events = cuenta(&s, "events");
    // El cliente leyó la revisión 0, pero ya va por la 1.
    let r = s.policy_apply_recorded(0, &set("global", "", "steer", "deny"), "ana", 8_000, |_, _| unreachable!("stale no llega al Event")).unwrap();
    assert_eq!(r, PolicyChange::Stale { current: 1 });
    // Una revisión del futuro tampoco vale.
    let r = s.policy_apply_recorded(9, &reset("global", "", "queue"), "ana", 8_000, |_, _| unreachable!()).unwrap();
    assert_eq!(r, PolicyChange::Stale { current: 1 });
    let snap = s.policy_snapshot().unwrap();
    assert_eq!((snap.revision, snap.rows.len()), (1, 1));
    assert_eq!(cuenta(&s, "events"), events);
}

#[test]
fn volver_a_heredar_borra_el_override_avanza_la_revision_y_la_historia_queda_en_los_eventos() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    aplica(&mut s, 0, &set("attempt", "t-a1", "steer", "deny")).unwrap();
    let r = s.policy_apply_recorded(1, &reset("attempt", "t-a1", "steer"), "ana", 9_000, |previo, rev| {
        assert_eq!((previo, rev), (Some("deny"), 2));
        Ok(evento("policy.changed", "attempt:t-a1"))
    });
    assert_eq!(r.unwrap(), PolicyChange::Changed { revision: 2, previous: Some("deny".into()) });
    let snap = s.policy_snapshot().unwrap();
    assert_eq!((snap.revision, snap.rows.len()), (2, 0));
    assert_eq!(cuenta(&s, "events"), 2, "cambiar la policy no reescribe la historia: los dos hechos siguen ahí");
}

#[test]
fn si_el_evento_falla_no_queda_ni_la_fila_ni_la_revision() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let r = s.policy_apply_recorded(0, &set("global", "", "steer", "deny"), "ana", 5_000, |_, _| Err(StoreError::InvalidEvent("evento inválido".into())));
    assert!(r.is_err());
    let snap = s.policy_snapshot().unwrap();
    assert_eq!((snap.revision, snap.rows.len()), (0, 0));
    assert_eq!(cuenta(&s, "events"), 0);
}

#[test]
fn el_sql_directo_no_puede_saltarse_los_valores_ni_la_revision() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let insert = |kind: &str, id: &str, cat: &str, level: &str| format!("INSERT INTO policy_overrides VALUES ('{kind}', '{id}', '{cat}', '{level}', 'ana', 1, 1)");
    assert!(sql(&mut s, &insert("global", "", "steer", "deny")).is_ok());
    assert!(sql(&mut s, &insert("global", "", "inventada", "deny")).is_err(), "categoría fuera del contrato");
    assert!(sql(&mut s, &insert("global", "", "queue", "root")).is_err(), "nivel fuera del contrato");
    assert!(sql(&mut s, &insert("global", "x", "queue", "deny")).is_err(), "el global no tiene id de ámbito");
    assert!(sql(&mut s, &insert("project", "", "queue", "deny")).is_err(), "un project necesita su id");
    assert!(sql(&mut s, &insert("team", "t", "queue", "deny")).is_err(), "no hay roles ni equipos (F9)");
    assert!(sql(&mut s, "UPDATE policy_state SET revision = 5").is_err(), "la revisión solo avanza de uno en uno");
    assert!(sql(&mut s, "UPDATE policy_state SET revision = 0").is_err(), "ni retrocede");
    assert!(sql(&mut s, "DELETE FROM policy_state").is_err());
    assert!(sql(&mut s, "INSERT INTO policy_state (id, revision) VALUES (2, 0)").is_err(), "un único contador");
    assert!(sql(&mut s, "UPDATE policy_state SET revision = 1").is_ok());
}

#[test]
fn antes_del_corte_leer_da_la_policy_vacia_y_escribir_es_modelo_inactivo() {
    let t = Tmp::new();
    let mut s = abre(t.path(), false);
    assert_eq!(s.policy_snapshot().unwrap(), PolicySnapshot { revision: 0, rows: vec![] });
    let r = s.policy_apply_recorded(0, &set("global", "", "steer", "deny"), "ana", 1, |_, _| unreachable!());
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    assert_eq!(cuenta(&s, "policy_overrides"), 0);
}

#[test]
fn sobrevive_a_reabrir_el_almacen() {
    let t = Tmp::new();
    {
        let mut s = abre(t.path(), true);
        aplica(&mut s, 0, &set("project", "p1", "integrate", "deny")).unwrap();
    }
    let s = abre(t.path(), true);
    let snap = s.policy_snapshot().unwrap();
    assert_eq!(snap.revision, 1);
    assert_eq!(snap.level_of("project", "p1", "integrate"), Some("deny"));
}

#[test]
fn la_fila_no_guarda_secretos_rutas_ni_claves() {
    let t = Tmp::new();
    let s = abre(t.path(), true);
    let columnas: Vec<String> = s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('policy_overrides') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(columnas, ["scope_kind", "scope_id", "category", "level", "set_by", "set_at", "revision"]);
}

/// La 023 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_023_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 23).expect("existe la 023");
    assert_eq!(m.name, "policy");
    assert_eq!(m.checksum(), "0102159c37545c116cca9b3831e02de4153d23d820a696eb8acdf447ea35a68a", "una migración publicada no se edita");
}
