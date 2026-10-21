//! Pruebas del modelo autoritativo de Attention (migración 006, LXO-87).
//!
//! Cubren el contrato de `docs/core/ATTENTION.md`: identidad, deduplicación, resolver sin borrar
//! historia, actualizar severity/facts de la activa, Attention ≠ unread, ausencia de textos de interfaz
//! en el dominio y destino resoluble sin rutas absolutas. Los tiempos (`at`) los fija quien llama: todo es determinista.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::attention::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-att-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

fn abre(dir: &Path) -> Store {
    Store::open_with(dir, &embedded(), "t").unwrap()
}

fn hasta_la_005() -> Vec<Migration> {
    embedded().into_iter().filter(|m| m.version <= 5).collect()
}

/// Lo que conoce un binario de G: hasta la 006 (las posteriores se prueban en su propio slice).
fn hasta_la_006() -> Vec<Migration> {
    embedded().into_iter().filter(|m| m.version <= 6).collect()
}

fn destino(kind: TargetKind, id: &str) -> AttentionTarget {
    AttentionTarget::new(kind, id).unwrap()
}

/// Un hecho mínimo: la tarea `t1` falló.
fn nuevo(category: AttentionCategory) -> NewAttention {
    NewAttention {
        category,
        severity: Severity::High,
        target: destino(TargetKind::Task, "t1"),
        project_id: Some("p1".into()),
        run_id: Some("r1".into()),
        subject: None,
        source_event_id: None,
        correlation_id: None,
        facts: "{}".into(),
        at: 1_000,
    }
}

fn creada(r: Raised) -> AttentionRow {
    match r {
        Raised::Created(row) => row,
        other => panic!("se esperaba Created: {other:?}"),
    }
}

fn existente(r: Raised) -> AttentionRow {
    match r {
        Raised::Existing(row) => row,
        other => panic!("se esperaba Existing: {other:?}"),
    }
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

/// ¿El SQL crudo falla? (para probar lo que la propia tabla impone, sin pasar por Rust).
fn falla(s: &mut Store, sql: &str) -> Option<String> {
    s.write(|tx| {
        tx.execute_batch(sql)?;
        Ok(())
    })
    .err()
    .map(|e| e.to_string())
}

const FP: &str = "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'";

/// Una fila válida escrita a mano; las pruebas la rompen con `replace` para ver qué impone la base.
fn insert_crudo(id: &str) -> String {
    format!(
        "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, created_at, updated_at) \
         VALUES ('{id}', {FP}, 1, 'failed', 'high', 'active', 'task', 't1', 1, 1)"
    )
}

// ── Categorías, severidad y estados: conjuntos cerrados ─────────────────────────────────────────

#[test]
fn las_categorias_iniciales_son_exactamente_las_siete_del_contrato() {
    let codigos: Vec<&str> = AttentionCategory::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(codigos, ["question", "approval", "review_ready", "conflict", "failed", "environment_blocked", "risk"]);
    for c in AttentionCategory::ALL {
        assert_eq!(AttentionCategory::parse(c.as_str()).unwrap(), c, "ida y vuelta");
    }
    assert!(AttentionCategory::parse("info").is_err());
    assert!(AttentionCategory::parse("Failed").is_err(), "los códigos son exactos, sin normalizar");
}

#[test]
fn la_severidad_es_un_orden_total_normalizado_y_la_fija_el_core() {
    let codigos: Vec<&str> = Severity::ALL.iter().map(|s| s.as_str()).collect();
    assert_eq!(codigos, ["critical", "high", "medium", "low"], "de más a menos urgente");
    let ranks: Vec<u8> = Severity::ALL.iter().map(|s| s.rank()).collect();
    assert_eq!(ranks, [0, 1, 2, 3], "rank 0 = más urgente");
    for s in Severity::ALL {
        assert_eq!(Severity::parse(s.as_str()).unwrap(), s);
    }
    assert!(Severity::parse("urgent").is_err());
}

#[test]
fn el_estado_solo_admite_active_y_resolved_sin_snoozed() {
    assert_eq!(AttentionStatus::parse("active").unwrap(), AttentionStatus::Active);
    assert_eq!(AttentionStatus::parse("resolved").unwrap(), AttentionStatus::Resolved);
    assert!(AttentionStatus::parse("snoozed").is_err(), "pospuesto es política de cliente/persona, no del dominio");
    let mut s = abre(Tmp::new().path());
    let e = falla(&mut s, &insert_crudo("x").replace("'active'", "'snoozed'"));
    assert!(e.is_some(), "la tabla también lo impone");
}

#[test]
fn la_base_impone_los_conjuntos_cerrados() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    assert!(falla(&mut s, &insert_crudo("ok")).is_none(), "la fila base es válida");
    for (id, roto) in [
        ("c", insert_crudo("c").replace("'failed'", "'info'")),
        ("v", insert_crudo("v").replace("'high'", "'urgent'")),
        ("fp", insert_crudo("fp").replace(FP, "'corta'")),
        ("oc", insert_crudo("oc").replace(", 1, 'failed'", ", 0, 'failed'")),
    ] {
        assert!(falla(&mut s, &roto).is_some(), "{id}: la tabla debe rechazarla");
    }
}

#[test]
fn la_base_impone_la_coherencia_del_ciclo_de_vida() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    // activa con resolved_at
    assert!(falla(&mut s, "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, created_at, updated_at, resolved_at, resolution) VALUES ('a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'failed', 'high', 'active', 'task', 't', 1, 1, 5, 'acted')").is_some());
    // resuelta sin resolved_at / sin resolución
    assert!(falla(&mut s, "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, created_at, updated_at) VALUES ('b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'failed', 'high', 'resolved', 'task', 't', 1, 1)").is_some());
    // resuelta antes de crearse
    assert!(falla(&mut s, "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, created_at, updated_at, resolved_at, resolution) VALUES ('c', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'failed', 'high', 'resolved', 'task', 't', 10, 10, 5, 'acted')").is_some());
    // resolución fuera del conjunto cerrado
    assert!(falla(&mut s, "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, created_at, updated_at, resolved_at, resolution) VALUES ('d', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'failed', 'high', 'resolved', 'task', 't', 1, 1, 5, 'visto')").is_some());
}

// ── Identidad ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_identidad_es_determinista_y_no_depende_de_hora_severidad_ni_origen() {
    let a = nuevo(AttentionCategory::Failed);
    let b = NewAttention { severity: Severity::Low, at: 9_999, source_event_id: Some("e-1".into()), correlation_id: Some("c-1".into()), facts: r#"{"k":1}"#.into(), project_id: None, run_id: None, ..a.clone() };
    assert_eq!(a.fingerprint(), b.fingerprint(), "el hecho es el mismo");
    assert_eq!(a.fingerprint().len(), 64);
    assert!(a.fingerprint().bytes().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a.fingerprint(), NewAttention { category: AttentionCategory::Conflict, ..a.clone() }.fingerprint(), "otra categoría = otro hecho");
    assert_ne!(a.fingerprint(), NewAttention { target: destino(TargetKind::Task, "t2"), ..a.clone() }.fingerprint(), "otro destino = otro hecho");
    assert_ne!(a.fingerprint(), NewAttention { target: destino(TargetKind::Run, "t1"), ..a.clone() }.fingerprint(), "otro tipo de destino = otro hecho");
    assert_ne!(a.fingerprint(), NewAttention { subject: Some("q-7".into()), ..a.clone() }.fingerprint(), "el subject distingue hechos del mismo destino");
}

#[test]
fn el_fingerprint_no_es_ambiguo_entre_campos() {
    // Sin separador, ("task","ab"+"c") y ("task","a"+"bc") colisionarían.
    let x = NewAttention { target: destino(TargetKind::Task, "ab"), subject: Some("c".into()), ..nuevo(AttentionCategory::Question) };
    let y = NewAttention { target: destino(TargetKind::Task, "a"), subject: Some("bc".into()), ..nuevo(AttentionCategory::Question) };
    assert_ne!(x.fingerprint(), y.fingerprint());
    assert!(NewAttention { subject: Some(String::new()), ..nuevo(AttentionCategory::Question) }.check().is_err(), "un subject vacío no se confunde con ausente");
}

#[test]
fn el_id_se_deriva_del_hecho_y_la_ocurrencia_y_la_reconstruccion_lo_repite() {
    let hecho = nuevo(AttentionCategory::Failed);
    let id_de = |dir: &Path| {
        let mut s = abre(dir);
        let a = creada(s.attention_raise(&hecho).unwrap());
        s.attention_resolve(&a.id, Resolution::ConditionCleared, 2_000).unwrap();
        let b = creada(s.attention_raise(&NewAttention { at: 3_000, ..hecho.clone() }).unwrap());
        (a.id, a.occurrence, b.id, b.occurrence)
    };
    let (t1, t2) = (Tmp::new(), Tmp::new());
    let primera = id_de(t1.path());
    let segunda = id_de(t2.path());
    assert_eq!(primera, segunda, "mismo historial ⇒ mismos ids en una instalación reconstruida");
    assert_eq!((primera.1, primera.3), (1, 2));
    assert_ne!(primera.0, primera.2, "una recurrencia tras resolver es otra ocurrencia con otro id");
    assert!(primera.0.starts_with("att_") && primera.0.len() == 4 + 32, "{}", primera.0);
}

// ── Deduplicación ───────────────────────────────────────────────────────────────────────────────

#[test]
fn un_mismo_hecho_no_crea_dos_activos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    let b = existente(s.attention_raise(&NewAttention { severity: Severity::Low, at: 5_000, source_event_id: Some("e-9".into()), ..nuevo(AttentionCategory::Failed) }).unwrap());
    assert_eq!(a, b, "devuelve el activo existente SIN modificarlo (severidad, hora y origen originales)");
    assert_eq!(cuenta(&s, "attention_items"), 1);
}

#[test]
fn hechos_distintos_conviven_activos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    creada(s.attention_raise(&nuevo(AttentionCategory::Conflict)).unwrap());
    creada(s.attention_raise(&NewAttention { target: destino(TargetKind::Task, "t2"), ..nuevo(AttentionCategory::Failed) }).unwrap());
    creada(s.attention_raise(&NewAttention { subject: Some("q-1".into()), ..nuevo(AttentionCategory::Question) }).unwrap());
    creada(s.attention_raise(&NewAttention { subject: Some("q-2".into()), ..nuevo(AttentionCategory::Question) }).unwrap());
    assert_eq!(cuenta(&s, "attention_items"), 5);
}

#[test]
fn la_base_impone_un_solo_activo_por_hecho_aunque_el_codigo_falle() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    assert!(falla(&mut s, &insert_crudo("uno")).is_none());
    let otro_activo = insert_crudo("dos").replace(", 1, 'failed'", ", 2, 'failed'");
    assert!(falla(&mut s, &otro_activo).is_some(), "el índice único parcial lo rechaza");
    // Mismo (fingerprint, occurrence) tampoco.
    assert!(falla(&mut s, &insert_crudo("tres")).is_some());
}

// ── Resolver ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn resolver_marca_la_fila_con_resolved_at_y_motivo_y_la_conserva() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Approval)).unwrap());
    assert_eq!((a.status, a.created_at, a.updated_at, a.resolved_at, a.resolution), (AttentionStatus::Active, 1_000, 1_000, None, None));
    let r = match s.attention_resolve(&a.id, Resolution::Acted, 4_000).unwrap() {
        ResolveOutcome::Resolved(r) => r,
        o => panic!("{o:?}"),
    };
    assert_eq!((r.status, r.created_at, r.updated_at, r.resolved_at, r.resolution), (AttentionStatus::Resolved, 1_000, 4_000, Some(4_000), Some(Resolution::Acted)));
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), r, "persistido tal cual");
    assert_eq!(cuenta(&s, "attention_items"), 1, "resolver no borra la fila");
}

#[test]
fn resolver_dos_veces_es_idempotente_y_no_reescribe_la_historia() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    let primera = match s.attention_resolve(&a.id, Resolution::Acted, 4_000).unwrap() {
        ResolveOutcome::Resolved(r) => r,
        o => panic!("{o:?}"),
    };
    let segunda = s.attention_resolve(&a.id, Resolution::Superseded, 9_000).unwrap();
    assert_eq!(segunda, ResolveOutcome::AlreadyResolved(primera.clone()));
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), primera, "ni resolved_at ni el motivo cambian");
}

#[test]
fn resolver_un_id_desconocido_o_con_hora_anterior_a_la_creacion() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    assert_eq!(s.attention_resolve("att_no_existe", Resolution::Acted, 5).unwrap(), ResolveOutcome::Missing);
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    let e = s.attention_resolve(&a.id, Resolution::Acted, 999).unwrap_err();
    assert!(matches!(e, StoreError::InvalidAttention(_)), "{e:?}");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap().status, AttentionStatus::Active, "sin efecto");
}

#[test]
fn tras_resolver_el_mismo_hecho_puede_volver_a_requerir_atencion() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    s.attention_resolve(&a.id, Resolution::ConditionCleared, 2_000).unwrap();
    let b = creada(s.attention_raise(&NewAttention { at: 3_000, ..nuevo(AttentionCategory::Failed) }).unwrap());
    assert_eq!((b.occurrence, b.status, b.created_at), (2, AttentionStatus::Active, 3_000));
    assert_eq!(a.fingerprint, b.fingerprint, "mismo hecho, otra ocurrencia");
    assert_eq!(cuenta(&s, "attention_items"), 2, "la ocurrencia resuelta se conserva como historia");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap().status, AttentionStatus::Resolved);
}

#[test]
fn una_fila_resuelta_no_vuelve_a_activa_ni_se_borra_ni_cambia_su_identidad() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    assert!(falla(&mut s, &format!("UPDATE attention_items SET category = 'risk' WHERE id = '{}'", a.id)).is_some(), "categoría inmutable");
    assert!(falla(&mut s, &format!("UPDATE attention_items SET target_id = 't9' WHERE id = '{}'", a.id)).is_some(), "destino inmutable");
    assert!(falla(&mut s, &format!("DELETE FROM attention_items WHERE id = '{}'", a.id)).is_some(), "no se borra");
    s.attention_resolve(&a.id, Resolution::Acted, 2_000).unwrap();
    assert!(falla(&mut s, &format!("UPDATE attention_items SET status = 'active', resolved_at = NULL, resolution = NULL WHERE id = '{}'", a.id)).is_some(), "resolved es terminal");
    assert!(falla(&mut s, &format!("UPDATE attention_items SET severity = 'low' WHERE id = '{}'", a.id)).is_some(), "severidad inmutable una vez resuelta");
    assert_eq!(cuenta(&s, "attention_items"), 1);
}

// ── Actualizar la Attention activa (severity / facts) ───────────────────────────────────────────

fn upd(severity: Option<Severity>, facts: Option<&str>, at: i64) -> AttentionUpdate {
    AttentionUpdate { severity, facts: facts.map(String::from), at }
}

fn actualizada(r: UpdateOutcome) -> AttentionRow {
    match r {
        UpdateOutcome::Updated(row) => row,
        other => panic!("se esperaba Updated: {other:?}"),
    }
}

/// Un hecho con todo el contexto relleno, para ver que la actualización no toca nada más.
fn completo() -> NewAttention {
    NewAttention {
        subject: Some("q-1".into()),
        source_event_id: Some("0192f0a1-0000-7000-8000-0000000000c3".into()),
        correlation_id: Some("corr-1".into()),
        facts: r#"{"a":1}"#.into(),
        ..nuevo(AttentionCategory::Question)
    }
}

#[test]
fn actualizar_solo_la_severidad_conserva_facts_e_identidad() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let b = actualizada(s.attention_update_active(&a.id, &upd(Some(Severity::Critical), None, 2_000)).unwrap());
    assert_eq!(b, AttentionRow { severity: Severity::Critical, updated_at: 2_000, ..a.clone() }, "cambian severity y updated_at, nada más");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), b, "persistido tal cual");
    assert_eq!(cuenta(&s, "attention_items"), 1, "no se duplica");
}

#[test]
fn actualizar_solo_los_facts_conserva_la_severidad_e_identidad() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let b = actualizada(s.attention_update_active(&a.id, &upd(None, Some(r#"{"b":2}"#), 2_000)).unwrap());
    assert_eq!(b, AttentionRow { facts: r#"{"b":2}"#.into(), updated_at: 2_000, ..a.clone() }, "los facts REEMPLAZAN a los anteriores");
    assert_eq!(cuenta(&s, "attention_items"), 1);
}

#[test]
fn actualizar_severidad_y_facts_a_la_vez_y_repetidas_veces() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let b = actualizada(s.attention_update_active(&a.id, &upd(Some(Severity::Low), Some(r#"{"c":3}"#), 2_000)).unwrap());
    assert_eq!(b, AttentionRow { severity: Severity::Low, facts: r#"{"c":3}"#.into(), updated_at: 2_000, ..a.clone() });
    // Se puede escalar y bajar: la severidad no es monótona. `at` tampoco tiene que crecer (solo ≥ created_at).
    let c = actualizada(s.attention_update_active(&a.id, &upd(Some(Severity::High), None, 1_500)).unwrap());
    assert_eq!((c.severity, c.facts.as_str(), c.updated_at), (Severity::High, r#"{"c":3}"#, 1_500));
    // `at == created_at` es válido.
    assert_eq!(actualizada(s.attention_update_active(&a.id, &upd(None, Some("{}"), 1_000)).unwrap()).updated_at, 1_000);
    assert_eq!(cuenta(&s, "attention_items"), 1);
    // Facts exactamente en el límite de 2048 bytes.
    let limite = format!(r#"{{"k":"{}"}}"#, "x".repeat(MAX_FACTS_BYTES - 8));
    assert_eq!(limite.len(), MAX_FACTS_BYTES);
    assert_eq!(actualizada(s.attention_update_active(&a.id, &upd(None, Some(&limite), 3_000)).unwrap()).facts, limite);
}

#[test]
fn actualizar_la_activa_no_cambia_nunca_la_identidad_ni_el_ciclo_de_vida() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let b = actualizada(s.attention_update_active(&a.id, &upd(Some(Severity::Critical), Some(r#"{"z":9}"#), 9_000)).unwrap());
    assert_eq!(
        (&b.id, &b.fingerprint, b.occurrence, b.category, &b.target, &b.project_id, &b.run_id, &b.subject, &b.source_event_id, &b.correlation_id, b.created_at),
        (&a.id, &a.fingerprint, a.occurrence, a.category, &a.target, &a.project_id, &a.run_id, &a.subject, &a.source_event_id, &a.correlation_id, a.created_at)
    );
    assert_eq!((b.status, b.resolved_at, b.resolution), (AttentionStatus::Active, None, None), "sigue activa");
}

#[test]
fn raise_duplicado_tras_actualizar_devuelve_la_activa_actualizada_sin_escribir() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let b = actualizada(s.attention_update_active(&a.id, &upd(Some(Severity::Critical), Some(r#"{"z":9}"#), 2_000)).unwrap());
    // Levantar el mismo hecho con otra severidad/facts/hora/origen NO modifica la activa (Existing intacto).
    let c = existente(s.attention_raise(&NewAttention { severity: Severity::Low, facts: "{}".into(), at: 5_000, source_event_id: Some("e-9".into()), ..completo() }).unwrap());
    assert_eq!(c, b);
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), b);
    assert_eq!(cuenta(&s, "attention_items"), 1);
}

#[test]
fn una_actualizacion_invalida_se_rechaza_sin_cambios_parciales() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let demasiado = format!(r#"{{"k":"{}"}}"#, "x".repeat(MAX_FACTS_BYTES));
    let casos = [
        ("facts no objeto", upd(Some(Severity::Critical), Some("[1]"), 2_000)),
        ("facts escalar", upd(Some(Severity::Critical), Some("1"), 2_000)),
        ("facts null", upd(Some(Severity::Critical), Some("null"), 2_000)),
        ("facts JSON roto", upd(Some(Severity::Critical), Some("{"), 2_000)),
        ("facts vacío", upd(Some(Severity::Critical), Some(""), 2_000)),
        ("facts de más de 2048 bytes", upd(Some(Severity::Critical), Some(&demasiado), 2_000)),
        ("hora anterior a la creación (con severidad válida)", upd(Some(Severity::Critical), Some(r#"{"b":2}"#), 999)),
        ("hora anterior a la creación solo severidad", upd(Some(Severity::Critical), None, -5)),
        ("actualización vacía", upd(None, None, 2_000)),
    ];
    for (que, u) in casos {
        let e = s.attention_update_active(&a.id, &u).unwrap_err();
        assert!(matches!(e, StoreError::InvalidAttention(_)), "{que}: {e:?}");
        assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a, "{que}: la fila no cambió (ni severidad ni updated_at)");
    }
    // Los facts se miden en BYTES, no en caracteres: 1100 «é» (2 bytes) superan el límite.
    let multibyte = format!(r#"{{"k":"{}"}}"#, "é".repeat(1100));
    assert!(multibyte.chars().count() < MAX_FACTS_BYTES && multibyte.len() > MAX_FACTS_BYTES);
    assert!(matches!(s.attention_update_active(&a.id, &upd(None, Some(&multibyte), 2_000)).unwrap_err(), StoreError::InvalidAttention(_)));
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a);
}

#[test]
fn la_severidad_de_una_actualizacion_es_un_conjunto_cerrado() {
    // El tipo `Severity` no admite valores fuera del conjunto; un código desconocido ni siquiera se parsea.
    assert!(matches!(Severity::parse("urgent"), Err(StoreError::InvalidAttention(_))));
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    assert!(falla(&mut s, &format!("UPDATE attention_items SET severity = 'urgent' WHERE id = '{}'", a.id)).is_some(), "y la base lo rechaza igualmente");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a);
}

#[test]
fn actualizar_una_resuelta_se_rechaza_y_no_la_reabre() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let r = match s.attention_resolve(&a.id, Resolution::Acted, 2_000).unwrap() {
        ResolveOutcome::Resolved(r) => r,
        o => panic!("{o:?}"),
    };
    let o = s.attention_update_active(&a.id, &upd(Some(Severity::Critical), Some(r#"{"z":9}"#), 3_000)).unwrap();
    assert_eq!(o, UpdateOutcome::AlreadyResolved(r.clone()), "distinto de Updated: no se confunde con éxito");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), r, "sigue resuelta, sin tocar severity, facts ni updated_at");
    // Reabrir tampoco se puede por SQL: levantar el hecho crea OTRA ocurrencia y la resuelta no se toca.
    let b = creada(s.attention_raise(&NewAttention { at: 4_000, ..completo() }).unwrap());
    assert_eq!((b.occurrence, b.status, b.severity), (2, AttentionStatus::Active, Severity::High));
    let b2 = actualizada(s.attention_update_active(&b.id, &upd(Some(Severity::Critical), None, 5_000)).unwrap());
    assert_eq!(b2.severity, Severity::Critical);
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), r, "la historia resuelta no cambia");
    assert_eq!(cuenta(&s, "attention_items"), 2);
}

#[test]
fn actualizar_un_id_desconocido_es_missing() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    assert_eq!(s.attention_update_active("att_no_existe", &upd(Some(Severity::Low), None, 5)).unwrap(), UpdateOutcome::Missing);
    assert_eq!(cuenta(&s, "attention_items"), 0);
}

#[test]
fn la_actualizacion_participa_en_la_transaccion_de_quien_llama() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    let u = upd(Some(Severity::Critical), Some(r#"{"z":9}"#), 2_000);
    let r: StoreResult<()> = s.write(|tx| {
        actualizada(attention_update_active_in(tx, &a.id, &u)?);
        Err(StoreError::InvalidAttention("se deshace".into()))
    });
    assert!(r.is_err());
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a, "si la transacción se deshace, la actualización también");
}

#[test]
fn el_limite_sql_de_campos_protegidos_de_una_activa() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&completo()).unwrap());
    // Permitido en una activa: severity, facts y updated_at (también por SQL directo).
    for ok in [
        "severity = 'low'",
        "facts = '{\"q\":1}'",
        "updated_at = 7000",
        "severity = 'critical', facts = '{}', updated_at = 8000",
    ] {
        assert_eq!(falla(&mut s, &format!("UPDATE attention_items SET {ok} WHERE id = '{}'", a.id)), None, "{ok}");
    }
    let tras_ok = s.attention_get(&a.id).unwrap().unwrap();
    assert_eq!((tras_ok.severity, tras_ok.facts.as_str(), tras_ok.updated_at), (Severity::Critical, "{}", 8_000));
    // Protegido: todo lo demás.
    for ko in [
        "id = 'otro'",
        "fingerprint = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
        "occurrence = 2",
        "category = 'risk'",
        "target_kind = 'run'",
        "target_id = 't9'",
        "project_id = 'p9'",
        "project_id = NULL",
        "run_id = 'r9'",
        "subject = 'otro'",
        "subject = NULL",
        "source_event_id = 'e9'",
        "correlation_id = 'c9'",
        "created_at = 0",
        "created_at = 500, updated_at = 500",
    ] {
        assert!(falla(&mut s, &format!("UPDATE attention_items SET {ko} WHERE id = '{}'", a.id)).is_some(), "{ko} debe seguir prohibido");
    }
    // Resolver por SQL: la transición pura sí; resolver ADEMÁS cambiando severity o facts, no.
    assert!(falla(&mut s, &format!("UPDATE attention_items SET status = 'resolved', resolved_at = 9000, resolution = 'acted', updated_at = 9000, severity = 'low' WHERE id = '{}'", a.id)).is_some());
    assert!(falla(&mut s, &format!("UPDATE attention_items SET status = 'resolved', resolved_at = 9000, resolution = 'acted', updated_at = 9000, facts = '{{\"x\":1}}' WHERE id = '{}'", a.id)).is_some());
    assert!(falla(&mut s, &format!("DELETE FROM attention_items WHERE id = '{}'", a.id)).is_some(), "no se borra");
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), tras_ok, "ningún rechazo dejó cambios");
    assert_eq!(falla(&mut s, &format!("UPDATE attention_items SET status = 'resolved', resolved_at = 9000, resolution = 'acted', updated_at = 9000 WHERE id = '{}'", a.id)), None);
    // Resuelta: ni siquiera severity, facts o updated_at.
    for ko in ["severity = 'low'", "facts = '{}'", "updated_at = 9500", "status = 'active', resolved_at = NULL, resolution = NULL"] {
        assert!(falla(&mut s, &format!("UPDATE attention_items SET {ko} WHERE id = '{}'", a.id)).is_some(), "resuelta: {ko} debe seguir prohibido");
    }
}

// ── Attention no copia ni consume el Event Log ──────────────────────────────────────────────────

fn evento_informativo() -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 500,
        v: 1,
        kind: "task.updated".into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: Some("p1".into()),
        run_id: None,
        entity_kind: "task".into(),
        entity_id: "t1".into(),
        correlation_id: Some("corr-1".into()),
        idem_key: None,
        payload: "{}".into(),
    }
}

#[test]
fn un_evento_informativo_no_crea_attention_y_attention_no_crea_eventos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.append_events(&[evento_informativo()]).unwrap();
    assert_eq!(cuenta(&s, "attention_items"), 0, "el almacén no deriva Attention de los eventos por defecto");
    creada(s.attention_raise(&nuevo(AttentionCategory::Failed)).unwrap());
    assert_eq!(cuenta(&s, "events"), 1, "levantar Attention no duplica ni escribe en el Event Log");
}

#[test]
fn resolver_no_borra_ni_toca_los_eventos_y_la_referencia_al_origen_es_blanda() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let e = evento_informativo();
    s.append_events(std::slice::from_ref(&e)).unwrap();
    let antes = s.events_page(&EventQuery::default()).unwrap().events;
    let a = creada(s.attention_raise(&NewAttention { source_event_id: Some(e.id.clone()), correlation_id: Some("corr-1".into()), ..nuevo(AttentionCategory::Failed) }).unwrap());
    s.attention_resolve(&a.id, Resolution::Acted, 2_000).unwrap();
    assert_eq!(s.events_page(&EventQuery::default()).unwrap().events, antes, "el Event Log queda intacto");
    let fila = s.attention_get(&a.id).unwrap().unwrap();
    assert_eq!((fila.source_event_id.as_deref(), fila.correlation_id.as_deref()), (Some(e.id.as_str()), Some("corr-1")));
    // Referencia blanda: un origen que no existe (p. ej. evento de otra instalación) no bloquea.
    creada(s.attention_raise(&NewAttention { source_event_id: Some("evento-que-no-esta".into()), subject: Some("otro".into()), ..nuevo(AttentionCategory::Failed) }).unwrap());
}

#[test]
fn el_evento_origen_y_la_attention_se_confirman_o_se_deshacen_juntos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let e = evento_informativo();
    let r: StoreResult<()> = s.write(|tx| {
        super::events::insert_events(tx, std::slice::from_ref(&e), None)?;
        attention_raise_in(tx, &NewAttention { source_event_id: Some(e.id.clone()), ..nuevo(AttentionCategory::Failed) })?;
        Err(StoreError::InvalidAttention("fallo forzado".into()))
    });
    assert!(r.is_err());
    assert_eq!((cuenta(&s, "events"), cuenta(&s, "attention_items")), (0, 0), "ROLLBACK de ambos");
    s.write(|tx| {
        super::events::insert_events(tx, std::slice::from_ref(&e), None)?;
        attention_raise_in(tx, &NewAttention { source_event_id: Some(e.id.clone()), ..nuevo(AttentionCategory::Failed) })?;
        Ok(())
    })
    .unwrap();
    assert_eq!((cuenta(&s, "events"), cuenta(&s, "attention_items")), (1, 1), "COMMIT de ambos");
}

// ── Attention ≠ unread, y sin textos de interfaz ────────────────────────────────────────────────

fn columnas(s: &Store) -> Vec<String> {
    s.read(|c| {
        let mut st = c.prepare("SELECT name FROM pragma_table_info('attention_items') ORDER BY cid")?;
        let v = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    })
    .unwrap()
}

#[test]
fn attention_no_es_unread_el_esquema_no_tiene_estado_de_lectura_ni_de_cliente() {
    let tmp = Tmp::new();
    let s = abre(tmp.path());
    let cols = columnas(&s);
    assert_eq!(
        cols,
        [
            "id", "fingerprint", "occurrence", "category", "severity", "status", "target_kind", "target_id", "project_id", "run_id", "subject",
            "source_event_id", "correlation_id", "facts", "created_at", "updated_at", "resolved_at", "resolution"
        ],
        "el contrato de columnas es cerrado: añadir una exige decisión explícita"
    );
    for c in &cols {
        for prohibida in ["read", "seen", "unread", "snooze", "dismiss", "client", "device", "user", "assignee", "badge", "count"] {
            assert!(!c.contains(prohibida), "la columna «{c}» mezcla Attention con lectura/política de cliente («{prohibida}»)");
        }
    }
}

#[test]
fn attention_sigue_activa_sea_cual_sea_el_estado_de_lectura_de_la_actividad() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let e = evento_informativo();
    s.append_events(std::slice::from_ref(&e)).unwrap();
    let a = creada(s.attention_raise(&NewAttention { source_event_id: Some(e.id), ..nuevo(AttentionCategory::Failed) }).unwrap());
    // «Leer» la actividad (consultar eventos, reabrir el almacén) no resuelve nada: solo resolve() cambia el estado.
    let _ = s.events_page(&EventQuery::default()).unwrap();
    drop(s);
    let s = abre(tmp.path());
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap().status, AttentionStatus::Active);
}

#[test]
fn el_dominio_solo_usa_codigos_estables_sin_textos_de_interfaz() {
    let codigo = |s: &str| !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') && !s.starts_with('_') && !s.ends_with('_');
    for c in AttentionCategory::ALL {
        assert!(codigo(c.as_str()), "{}", c.as_str());
    }
    for v in Severity::ALL {
        assert!(codigo(v.as_str()));
    }
    for k in TargetKind::ALL {
        assert!(codigo(k.as_str()), "{}", k.as_str());
    }
    for r in Resolution::ALL {
        assert!(codigo(r.as_str()));
    }
    assert!(codigo(AttentionStatus::Active.as_str()) && codigo(AttentionStatus::Resolved.as_str()));
    // Los `facts` son datos estructurados (objeto JSON acotado), no un cuerpo de mensaje.
    let facts = |f: &str| NewAttention { facts: f.into(), ..nuevo(AttentionCategory::Failed) }.check();
    assert!(facts("{}").is_ok() && facts(r#"{"reason":"agent_idle_timeout"}"#).is_ok());
    assert!(facts("[]").is_err() && facts("\"texto\"").is_err() && facts("no json").is_err());
    assert!(facts(&format!(r#"{{"k":"{}"}}"#, "x".repeat(MAX_FACTS_BYTES))).is_err(), "acotado");
}

// ── Destino resoluble, sin rutas absolutas ──────────────────────────────────────────────────────

#[test]
fn el_destino_rechaza_rutas_absolutas_y_valores_vacios() {
    for malo in ["", "   ", "C:\\Users\\yo\\api", "C:/Users/yo/api", "c:foo", "/home/yo/api", "\\\\servidor\\share", "a\\b", "~/api", "../api"] {
        assert!(AttentionTarget::new(TargetKind::Project, malo).is_err(), "«{malo}» no es una identidad lógica");
    }
    assert!(AttentionTarget::new(TargetKind::Project, &"x".repeat(201)).is_err());
    for bueno in ["0192f0a0-7b1c-7000-8000-000000000000", "t1", "run:3", "task.1-a_b"] {
        assert!(AttentionTarget::new(TargetKind::Task, bueno).is_ok(), "{bueno}");
    }
}

#[test]
fn la_base_tambien_rechaza_rutas_absolutas_como_destino() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    for malo in ["C:\\\\x", "C:/x", "/home/x", "a\\\\b"] {
        let sql = insert_crudo("r").replace("'t1'", &format!("'{malo}'"));
        assert!(falla(&mut s, &sql).is_some(), "{malo}");
    }
}

#[test]
fn los_tipos_de_destino_son_el_vocabulario_de_entidades_del_core() {
    let codigos: Vec<&str> = TargetKind::ALL.iter().map(|k| k.as_str()).collect();
    assert_eq!(codigos, ["project", "task", "run", "spawn_request", "attempt", "thread", "worktree", "artifact", "review", "integration", "agent", "decision", "policy"]);
    for k in TargetKind::ALL {
        assert_eq!(TargetKind::parse(k.as_str()).unwrap(), k);
    }
    assert!(TargetKind::parse("path").is_err() && TargetKind::parse("attention").is_err(), "una Attention no apunta a otra");
}

#[test]
fn el_destino_sigue_resolviendo_aunque_cambie_la_ruta_local_del_proyecto() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let fp = Fingerprint { root_commits: vec!["c1".into()], ..Default::default() };
    let loc = |p: &str| NewLocation { machine: "m1".into(), path: p.into(), display_path: p.into(), primary: true };
    let p = s.project_create("api", &fp, &loc("c:/viejo/api")).unwrap();
    let a = creada(s.attention_raise(&NewAttention { target: destino(TargetKind::Project, &p.id), project_id: Some(p.id.clone()), run_id: None, ..nuevo(AttentionCategory::EnvironmentBlocked) }).unwrap());
    s.location_put(&p.id, &loc("d:/nuevo/api")).unwrap();
    let otra = s.attention_get(&a.id).unwrap().unwrap();
    assert_eq!(otra, a, "la fila no depende de ninguna ruta");
    assert!(!otra.target.id.contains("viejo") && !otra.target.id.contains("nuevo"));
    let resuelto = s.project(&otra.target.id).unwrap().expect("el destino sigue resolviendo por su id lógico");
    assert_eq!(resuelto.id, p.id);
    assert_eq!(s.project_by_location("m1", "d:/nuevo/api").unwrap().as_deref(), Some(p.id.as_str()), "y la ruta nueva lleva al mismo proyecto");
}

// ── Persistencia determinista y migración ───────────────────────────────────────────────────────

#[test]
fn reabrir_el_almacen_devuelve_exactamente_las_mismas_filas() {
    let tmp = Tmp::new();
    let (a, b) = {
        let mut s = abre(tmp.path());
        let a = creada(s.attention_raise(&NewAttention { source_event_id: Some("e".into()), facts: r#"{"reason":"x"}"#.into(), ..nuevo(AttentionCategory::Failed) }).unwrap());
        let b = creada(s.attention_raise(&NewAttention { subject: Some("q".into()), severity: Severity::Critical, ..nuevo(AttentionCategory::Question) }).unwrap());
        let ResolveOutcome::Resolved(b) = s.attention_resolve(&b.id, Resolution::Superseded, 7_000).unwrap() else { panic!() };
        (a, b)
    };
    let s = abre(tmp.path());
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a);
    assert_eq!(s.attention_get(&b.id).unwrap().unwrap(), b);
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap().facts, r#"{"reason":"x"}"#);
}

#[test]
fn la_migracion_006_se_aplica_sobre_una_base_en_la_005_y_no_toca_lo_anterior() {
    let tmp = Tmp::new();
    {
        let mut s = Store::open_with(tmp.path(), &hasta_la_005(), "t").unwrap();
        s.meta_set("marca", "intacta").unwrap();
        assert_eq!(s.schema_version().unwrap(), 5);
    }
    let s = Store::open_with(tmp.path(), &hasta_la_006(), "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 6);
    assert_eq!((s.migration_report().from_version, s.migration_report().applied.clone()), (5, vec![6]));
    assert_eq!(s.meta("marca").unwrap().as_deref(), Some("intacta"));
    assert_eq!(cuenta(&s, "attention_items"), 0, "sin relleno histórico: Attention empieza vacía");
}

#[test]
fn una_base_con_la_006_no_la_abre_un_binario_que_no_la_conoce() {
    let tmp = Tmp::new();
    drop(Store::open_with(tmp.path(), &hasta_la_006(), "t").unwrap());
    let r = Store::open_with(tmp.path(), &hasta_la_005(), "t");
    assert!(matches!(r, Err(StoreError::DatabaseNewer { .. }) | Err(StoreError::UnknownMigration { .. })), "{r:?}");
    assert_eq!(Store::open_with(tmp.path(), &hasta_la_006(), "t").unwrap().schema_version().unwrap(), 6, "y no se modificó nada");
}

/// La 006 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_006_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 6).expect("existe la 006");
    assert_eq!(m.name, "attention");
    assert_eq!(m.checksum(), "a0c70f9f461e93520466cd2dd31e4051469decd880edd47a65f9fe52f65fe453", "una migración publicada no se edita");
}

/// Vectores de identidad del contrato (`docs/core/ATTENTION.md`, «Identidad»). Si cambian, cambia la
/// identidad de TODA Attention ya persistida o reconstruida: es un cambio de contrato, no un refactor.
#[test]
fn los_vectores_de_identidad_del_contrato_no_cambian() {
    let falla_t = NewAttention { target: destino(TargetKind::Task, "0192f0a0-7b1c-7000-8000-0000000000a1"), ..nuevo(AttentionCategory::Failed) };
    assert_eq!(falla_t.fingerprint(), "30e6fc17321af6c249914dde7f108e5b45340fefed9879f92b632c83751b3fbb");
    let pregunta = NewAttention { subject: Some("msg-42".into()), ..NewAttention { category: AttentionCategory::Question, ..falla_t.clone() } };
    assert_eq!(pregunta.fingerprint(), "4dc13a650e8f500fd6961c1da1ff308bb701a7591d5c6b6d76a739f8dfd065c8");
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = creada(s.attention_raise(&falla_t).unwrap());
    assert_eq!(a.id, "att_954184304320b2663da4bdfc5d2942bd");
    s.attention_resolve(&a.id, Resolution::ConditionCleared, 2_000).unwrap();
    let b = creada(s.attention_raise(&NewAttention { at: 3_000, ..falla_t }).unwrap());
    assert_eq!((b.id.as_str(), b.occurrence), ("att_51efafc44ec6225c4ff1a24e76ccbc28", 2));
    assert_eq!(creada(s.attention_raise(&pregunta).unwrap()).id, "att_7d66f4a292ea58a8f15435e6d421ce6f");
}
