//! La actualización de Attention (LXO-87) es consumible desde `orch` (LXO-88): un hermano de `store` puede
//! construir el `AttentionUpdate`, aplicarlo con `attention_update_active_in` dentro de `Store::write` e
//! inspeccionar el `UpdateOutcome`, usando solo la superficie que `store` exporta (sin `store::attention`).

use crate::store::{
    attention_update_active_in, AttentionCategory, AttentionRow, AttentionTarget, AttentionUpdate, NewAttention, Raised, Resolution, Severity, Store,
    StoreError, StoreResult, TargetKind, UpdateOutcome,
};

use super::boot_tests::dirs;

fn abre() -> (super::boot_tests::Limpia, Store) {
    let (l, _data, core) = dirs();
    std::fs::create_dir_all(&core).unwrap();
    let s = Store::open(&core, "t").unwrap();
    (l, s)
}

fn levanta(s: &mut Store) -> AttentionRow {
    let n = NewAttention {
        category: AttentionCategory::Question,
        severity: Severity::Low,
        target: AttentionTarget::new(TargetKind::Task, "t1").unwrap(),
        project_id: None,
        run_id: None,
        subject: None,
        source_event_id: None,
        correlation_id: None,
        facts: r#"{"a":1}"#.into(),
        at: 1_000,
    };
    match s.attention_raise(&n).unwrap() {
        Raised::Created(row) => row,
        otro => panic!("se esperaba Created, salió {otro:?}"),
    }
}

fn upd(severity: Option<Severity>, facts: Option<&str>, at: i64) -> AttentionUpdate {
    AttentionUpdate { severity, facts: facts.map(String::from), at }
}

#[test]
fn orch_aplica_la_actualizacion_en_su_transaccion_y_lee_el_resultado() {
    let (_l, mut s) = abre();
    let a = levanta(&mut s);
    let u = upd(Some(Severity::Critical), Some(r#"{"b":2}"#), 2_000);
    let out = s.write(|tx| attention_update_active_in(tx, &a.id, &u)).unwrap();
    let UpdateOutcome::Updated(row) = out else { panic!("se esperaba Updated, salió {out:?}") };
    assert_eq!((row.severity, row.facts.as_str(), row.updated_at), (Severity::Critical, r#"{"b":2}"#, 2_000));
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), row, "lo confirmado es lo que devolvió el helper");
}

#[test]
fn orch_distingue_resuelta_y_ausente_sin_escribir() {
    let (_l, mut s) = abre();
    let a = levanta(&mut s);
    let resuelta = match s.attention_resolve(&a.id, Resolution::Acted, 1_500).unwrap() {
        crate::store::ResolveOutcome::Resolved(r) => r,
        otro => panic!("{otro:?}"),
    };
    let u = upd(Some(Severity::Critical), None, 2_000);
    assert_eq!(s.write(|tx| attention_update_active_in(tx, &a.id, &u)).unwrap(), UpdateOutcome::AlreadyResolved(resuelta.clone()));
    assert_eq!(s.write(|tx| attention_update_active_in(tx, "att_no_existe", &u)).unwrap(), UpdateOutcome::Missing);
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), resuelta, "ni la resuelta ni nada más cambia");
}

#[test]
fn orch_la_actualizacion_se_deshace_con_la_transaccion_que_la_contiene() {
    let (_l, mut s) = abre();
    let a = levanta(&mut s);
    // Éxito dentro de la transacción + fallo posterior de quien llama (p. ej. el Event): todo se deshace.
    let r: StoreResult<()> = s.write(|tx| {
        let u = upd(Some(Severity::Critical), Some(r#"{"z":9}"#), 2_000);
        assert!(matches!(attention_update_active_in(tx, &a.id, &u)?, UpdateOutcome::Updated(_)));
        Err(StoreError::InvalidAttention("se deshace".into()))
    });
    assert!(r.is_err());
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a, "sin cambios parciales");
    // Una segunda actualización inválida (vacía) propaga el error y arrastra también a la primera.
    let r: StoreResult<()> = s.write(|tx| {
        attention_update_active_in(tx, &a.id, &upd(Some(Severity::High), None, 3_000))?;
        attention_update_active_in(tx, &a.id, &upd(None, None, 3_001))?;
        Ok(())
    });
    assert!(r.is_err());
    assert_eq!(s.attention_get(&a.id).unwrap().unwrap(), a, "la actualización inválida deshace la válida de la misma transacción");
}
