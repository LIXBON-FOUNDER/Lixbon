//! Pruebas del Event Log en el almacén (migración 004, slice E, etapa E1a).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::legacy::META_MODE;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-ev-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Lo que conoce un binario de D: hasta la 003.
fn hasta_la_003() -> Vec<Migration> {
    embedded().into_iter().filter(|m| m.version <= 3).collect()
}

/// Un almacén en modo autoritativo con la fila `legacy_state` en `rev = 1` (lo mínimo que exige
/// `commit_authoritative`; el protocolo completo de autoridad se prueba en `authority_tests`).
fn autoritativa(dir: &Path) -> Store {
    let mut s = abre(dir);
    s.write(|tx| {
        tx.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 1, 0, '{\"a\":0}', 1)", [])?;
        tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", rusqlite::params![META_MODE, MODE_SQLITE_AUTHORITATIVE])?;
        Ok(())
    })
    .unwrap();
    s
}

fn ev(kind: &str) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.to_string(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: None,
        run_id: None,
        entity_kind: "core".into(),
        entity_id: "core".into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

fn con_idem(kind: &str, key: &str) -> NewEvent {
    NewEvent { idem_key: Some(key.into()), ..ev(kind) }
}

fn cuenta(s: &Store) -> i64 {
    s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)).unwrap()
}

fn rev_y_doc(s: &Store) -> (i64, String) {
    let l = s.legacy_state().unwrap().unwrap();
    (l.rev, l.doc)
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

fn insert_crudo(payload_sql: &str, extra_cols: &str, extra_vals: &str) -> String {
    format!(
        "INSERT INTO events (id, at, v, kind, class, actor_kind, entity_kind, entity_id, payload{extra_cols}) VALUES ('{}', 1, 1, 'k', 'state', 'system', 'core', 'core', {payload_sql}{extra_vals})",
        new_uuid_v7()
    )
}

// ---------------------------------------------------------------------------------------------
// Migración
// ---------------------------------------------------------------------------------------------

#[test]
fn la_004_se_aplica_sobre_una_base_con_la_003_conservando_todo() {
    let tmp = Tmp::new();
    let id = {
        let mut s = Store::open_with(tmp.path(), &hasta_la_003(), "t").unwrap();
        assert_eq!(s.schema_version().unwrap(), 3);
        assert!(s.read(|c| Ok(c.prepare("SELECT 1 FROM events").is_err())).unwrap(), "antes de la 004 no hay tabla de eventos");
        let p = s
            .project_create(
                "api",
                &Fingerprint { root_commits: vec!["c1".into()], ..Default::default() },
                &NewLocation { machine: "m".into(), path: "c:/api".into(), display_path: "C:/api".into(), primary: true },
            )
            .unwrap();
        s.meta_set("marca", "intacta").unwrap();
        p.id
    };
    let s = abre(tmp.path());
    assert_eq!(s.schema_version().unwrap(), (super::cut_migration().version - 1), "sube a la última migración del binario");
    assert_eq!(s.migration_report().from_version, 3, "se aplicaron 004 y las siguientes");
    assert_eq!(s.project(&id).unwrap().unwrap().name, "api", "la 004 no toca los proyectos");
    assert_eq!(s.meta("marca").unwrap().as_deref(), Some("intacta"));
    assert_eq!(cuenta(&s), 0, "sin relleno histórico: los eventos empiezan en el despliegue");
}

#[test]
fn una_base_con_la_005_no_la_abre_un_binario_que_no_la_conoce() {
    let tmp = Tmp::new();
    drop(abre(tmp.path()));
    let r = Store::open_with(tmp.path(), &hasta_la_003(), "t");
    assert!(matches!(r, Err(StoreError::DatabaseNewer { .. }) | Err(StoreError::UnknownMigration { .. })), "{r:?}");
    // Y no se modificó nada: con el binario completo sigue abriendo igual.
    assert_eq!(abre(tmp.path()).schema_version().unwrap(), (super::cut_migration().version - 1));
}

#[test]
fn la_004_es_la_siguiente_migracion_y_su_checksum_esta_fijado() {
    let lista = embedded();
    // Las migraciones posteriores (006 attention…) fijan su propia lista en sus pruebas.
    assert_eq!(lista.iter().take(5).map(|m| (m.version, m.name)).collect::<Vec<_>>(), vec![(1, "core"), (2, "authority_fence"), (3, "projects"), (4, "events"), (5, "clients")]);
    let m = &lista[3];
    assert_eq!(m.checksum(), "f6ab10ae4bacd44cb7b5bcf920bf84538931034976c28360a1bd00ac78bd712b", "una migración publicada no se edita (cree una nueva)");
    // Y las tres anteriores siguen congeladas (su pin completo está en `projects_tests`).
    assert_eq!(lista[2].checksum(), "ae5b5563ed06c996b45eb3e7d24e759b8799d2236cf882dd43621fa19bc5257e");
}

// ---------------------------------------------------------------------------------------------
// La tabla impone sus reglas aunque el código falle
// ---------------------------------------------------------------------------------------------

#[test]
fn update_y_delete_abortan_por_trigger() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.append_events(&[ev("k.uno")]).unwrap();
    let e = falla(&mut s, "UPDATE events SET kind = 'otro'").expect("UPDATE debe abortar");
    assert!(e.contains("append-only"), "{e}");
    let e = falla(&mut s, "DELETE FROM events").expect("DELETE debe abortar");
    assert!(e.contains("append-only"), "{e}");
    assert_eq!(cuenta(&s), 1);
    let e = falla(&mut s, "UPDATE events SET payload = '{}' WHERE seq = 1").expect("también por fila");
    assert!(e.contains("append-only"), "{e}");
    assert_eq!(s.events_page(&EventQuery::default()).unwrap().events[0].kind, "k.uno", "intacto");
}

#[test]
fn un_payload_de_mas_de_8_kib_se_rechaza_tambien_desde_sqlite_y_se_mide_en_bytes() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    // Exactamente 8192 bytes: cabe. `{"x":"…"}` mide 8 bytes más que la cadena.
    let justo = format!("'{{\"x\":\"{}\"}}'", "a".repeat(MAX_PAYLOAD_BYTES - 8));
    assert_eq!(falla(&mut s, &insert_crudo(&justo, "", "")), None, "8192 bytes caben");
    let pasado = format!("'{{\"x\":\"{}\"}}'", "a".repeat(MAX_PAYLOAD_BYTES - 7));
    let e = falla(&mut s, &insert_crudo(&pasado, "", "")).expect("8193 bytes no caben");
    assert!(e.to_lowercase().contains("constraint") || e.contains("CHECK"), "{e}");
    // BYTES, no caracteres: 3000 × «€» son 3000 caracteres (< 8192) pero 9000 bytes.
    let euros = format!("'{{\"x\":\"{}\"}}'", "€".repeat(3000));
    assert!(falla(&mut s, &insert_crudo(&euros, "", "")).is_some(), "el límite cuenta bytes, no caracteres");
    assert_eq!(cuenta(&s), 1, "solo entró el que cabía");
    // Y Rust lo rechaza antes de abrir ninguna transacción.
    let grande = NewEvent { payload: format!("{{\"x\":\"{}\"}}", "€".repeat(3000)), ..ev("k.grande") };
    assert!(matches!(s.append_events(&[grande]), Err(StoreError::InvalidEvent(_))));
    assert_eq!(cuenta(&s), 1);
}

#[test]
fn la_tabla_rechaza_json_invalido_clases_desconocidas_y_agentes_sin_identidad() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    assert!(falla(&mut s, &insert_crudo("'no es json'", "", "")).is_some(), "payload no JSON");
    let id = new_uuid_v7();
    let base = |class: &str, actor: &str, actor_id: &str, kind: &str| {
        format!(
            "INSERT INTO events (id, at, v, kind, class, actor_kind, actor_id, entity_kind, entity_id, payload) VALUES ('{id}', 1, 1, '{kind}', '{class}', '{actor}', {actor_id}, 'core', 'core', '{{}}')"
        )
    };
    assert!(falla(&mut s, &base("project", "system", "NULL", "k")).is_some(), "`project` no es una clase");
    assert!(falla(&mut s, &base("state", "client", "NULL", "k")).is_some(), "actor desconocido");
    assert!(falla(&mut s, &base("state", "agent", "NULL", "k")).is_some(), "un agente exige identidad");
    assert!(falla(&mut s, &base("state", "system", "NULL", "")).is_some(), "kind vacío");
    assert_eq!(falla(&mut s, &base("state", "agent", "'t1'", "k")), None, "el caso válido sí entra");
}

#[test]
fn las_referencias_son_blandas_y_sobreviven_al_archivado_de_un_proyecto() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    // Un evento puede nombrar un proyecto, un run, un cliente y una entidad que no existen (sin FK).
    let fantasma = NewEvent {
        project_id: Some("proyecto-que-no-existe".into()),
        run_id: Some("r99".into()),
        client_id: Some("cliente-que-no-existe".into()),
        entity_kind: "task".into(),
        entity_id: "t99".into(),
        ..ev("k.fantasma")
    };
    s.append_events(&[fantasma]).unwrap();
    // Un proyecto real: sus eventos sobreviven a archivarlo.
    let p = s
        .project_create(
            "web",
            &Fingerprint { root_commits: vec!["c2".into()], ..Default::default() },
            &NewLocation { machine: "m".into(), path: "c:/web".into(), display_path: "C:/web".into(), primary: true },
        )
        .unwrap();
    s.append_events(&[NewEvent { project_id: Some(p.id.clone()), entity_kind: "project".into(), entity_id: p.id.clone(), ..ev("k.web") }]).unwrap();
    assert!(s.project_set_archived(&p.id, true).unwrap());
    let page = s.events_page(&EventQuery::default()).unwrap();
    assert_eq!(page.events.len(), 2, "archivar el proyecto no toca su historia");
    assert_eq!(page.events[1].project_id.as_deref(), Some(p.id.as_str()));
}

// ---------------------------------------------------------------------------------------------
// Idempotencia: UNIQUE (kind, idem_key)
// ---------------------------------------------------------------------------------------------

#[test]
fn la_misma_clave_en_el_mismo_kind_deduplica_y_en_otro_kind_no_colisiona() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let r = s.append_events(&[con_idem("spawn.resolved", "p1"), con_idem("spawn.resolved", "p1"), con_idem("task.created", "p1")]).unwrap();
    assert!(matches!(r[0], Inserted::New(_)));
    assert_eq!(r[1], Inserted::Duplicate, "mismo kind + misma clave = mismo hecho");
    assert!(matches!(r[2], Inserted::New(_)), "otro kind con la misma clave no colisiona");
    assert_eq!(cuenta(&s), 2);
    // Repetir el lote no añade nada.
    let again = s.append_events(&[con_idem("spawn.resolved", "p1"), con_idem("task.created", "p1")]).unwrap();
    assert_eq!(again, vec![Inserted::Duplicate, Inserted::Duplicate]);
    assert_eq!(cuenta(&s), 2);
    // Sin clave no hay deduplicación.
    s.append_events(&[ev("k.libre"), ev("k.libre")]).unwrap();
    assert_eq!(cuenta(&s), 4);
}

// ---------------------------------------------------------------------------------------------
// Orden y cursor
// ---------------------------------------------------------------------------------------------

#[test]
fn el_orden_es_seq_y_la_hora_no_participa() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    // Misma hora en dos commits distintos, y un tercero con una hora ANTERIOR: el orden es el de inserción.
    s.append_events(&[NewEvent { at: 5_000, ..ev("k.a") }]).unwrap();
    s.append_events(&[NewEvent { at: 5_000, ..ev("k.b") }]).unwrap();
    s.append_events(&[NewEvent { at: 1, ..ev("k.c") }]).unwrap();
    let page = s.events_page(&EventQuery::default()).unwrap();
    assert_eq!(page.events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["k.a", "k.b", "k.c"]);
    let seqs: Vec<i64> = page.events.iter().map(|e| e.seq).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq estrictamente creciente: {seqs:?}");
    assert_eq!(page.events[2].at, 1, "una hora anterior no reordena");
    assert_eq!(page.head_seq, seqs[2]);
}

#[test]
fn el_cursor_pagina_sin_duplicar_ni_saltar_en_las_dos_direcciones() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let lote: Vec<NewEvent> = (0..25).map(|i| ev(&format!("k.{i}"))).collect();
    s.append_events(&lote).unwrap();
    let head = s.events_head().unwrap();
    assert_eq!(head, 25);

    // Hacia delante (after, exclusivo).
    let (mut vistos, mut cursor, mut paginas) = (vec![], None, 0);
    loop {
        let p = s.events_page(&EventQuery { after: cursor, limit: Some(10), ..Default::default() }).unwrap();
        paginas += 1;
        vistos.extend(p.events.iter().map(|e| e.seq));
        match (p.has_more, p.next_cursor) {
            (true, Some(c)) => cursor = Some(c),
            (false, _) => break,
            (true, None) => panic!("has_more sin cursor"),
        }
    }
    assert_eq!((paginas, vistos), (3, (1..=25).collect::<Vec<i64>>()));

    // Hacia atrás (before, exclusivo), del más nuevo al más antiguo.
    let (mut vistos, mut cursor) = (vec![], None);
    loop {
        let p = s.events_page(&EventQuery { before: cursor, limit: Some(10), newest_first: true, ..Default::default() }).unwrap();
        vistos.extend(p.events.iter().map(|e| e.seq));
        match (p.has_more, p.next_cursor) {
            (true, Some(c)) => cursor = Some(c),
            _ => break,
        }
    }
    assert_eq!(vistos, (1..=25).rev().collect::<Vec<i64>>());

    // Exclusivos: after=N excluye N; before=N excluye N; tras el último no hay nada.
    fn seqs(s: &Store, q: EventQuery) -> Vec<i64> {
        s.events_page(&q).unwrap().events.iter().map(|e| e.seq).collect()
    }
    assert_eq!(seqs(&s, EventQuery { after: Some(23), ..Default::default() }), vec![24, 25]);
    assert_eq!(seqs(&s, EventQuery { before: Some(3), ..Default::default() }), vec![1, 2]);
    assert_eq!(seqs(&s, EventQuery { after: Some(25), ..Default::default() }), Vec::<i64>::new());
    assert_eq!(seqs(&s, EventQuery { after: Some(5), before: Some(9), ..Default::default() }), vec![6, 7, 8]);
    // Un evento nuevo después de leer aparece en la siguiente página hacia delante, sin duplicar.
    s.append_events(&[ev("k.nuevo")]).unwrap();
    assert_eq!(seqs(&s, EventQuery { after: Some(25), ..Default::default() }), vec![26]);
}

#[test]
fn los_limites_de_pagina_y_los_cursores_invalidos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let lote: Vec<NewEvent> = (0..(MAX_PAGE + 20)).map(|i| ev(&format!("k.{i}"))).collect();
    s.append_events(&lote).unwrap();
    let p = s.events_page(&EventQuery { limit: Some(10_000), ..Default::default() }).unwrap();
    assert_eq!((p.events.len(), p.has_more), (MAX_PAGE, true), "el máximo es 500");
    let p = s.events_page(&EventQuery::default()).unwrap();
    assert_eq!(p.events.len(), DEFAULT_PAGE);
    assert!(matches!(s.events_page(&EventQuery { limit: Some(0), ..Default::default() }), Err(StoreError::InvalidEvent(_))));
    assert!(matches!(s.events_page(&EventQuery { after: Some(-1), ..Default::default() }), Err(StoreError::InvalidEvent(_))));
    assert!(matches!(s.events_page(&EventQuery { before: Some(-1), ..Default::default() }), Err(StoreError::InvalidEvent(_))));
    let vacio = Tmp::new();
    let s2 = abre(vacio.path());
    let p = s2.events_page(&EventQuery::default()).unwrap();
    assert_eq!((p.events.len(), p.has_more, p.next_cursor, p.head_seq), (0, false, None, 0));
}

#[test]
fn reabrir_conserva_los_eventos_y_el_orden_continua() {
    let tmp = Tmp::new();
    {
        let mut s = abre(tmp.path());
        s.append_events(&[ev("k.uno"), ev("k.dos")]).unwrap();
    }
    let mut s = abre(tmp.path());
    assert_eq!(cuenta(&s), 2);
    s.append_events(&[ev("k.tres")]).unwrap();
    let kinds: Vec<_> = s.events_page(&EventQuery::default()).unwrap().events.iter().map(|e| (e.seq, e.kind.clone())).collect();
    assert_eq!(kinds, vec![(1, "k.uno".into()), (2, "k.dos".into()), (3, "k.tres".into())]);
}

// ---------------------------------------------------------------------------------------------
// Rechazo previo (nada llega a la base)
// ---------------------------------------------------------------------------------------------

#[test]
fn un_evento_mal_formado_se_rechaza_antes_de_tocar_la_base() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let malos = [
        NewEvent { payload: "[1,2]".into(), ..ev("k.lista") },
        NewEvent { payload: "{no json".into(), ..ev("k.roto") },
        NewEvent { actor_kind: ActorKind::Agent, actor_id: None, ..ev("k.agente") },
        NewEvent { entity_id: String::new(), ..ev("k.sinentidad") },
        NewEvent { idem_key: Some(String::new()), ..ev("k.idem") },
        NewEvent { kind: "x".repeat(65), ..ev("k.largo") },
        NewEvent { v: 0, ..ev("k.version") },
    ];
    for m in malos {
        let kind = m.kind.clone();
        // El bueno va PRIMERO: si se insertara antes de validar el resto, quedaría en la base.
        let r = s.append_events(&[ev("k.bueno"), m]);
        assert!(matches!(r, Err(StoreError::InvalidEvent(_))), "{kind}: {r:?}");
    }
    assert_eq!(cuenta(&s), 0, "ninguno llegó a insertarse");
}

// ---------------------------------------------------------------------------------------------
// Atomicidad con legacy_state
// ---------------------------------------------------------------------------------------------

#[test]
fn la_mutacion_y_sus_eventos_se_confirman_juntos_con_el_mismo_state_rev() {
    let tmp = Tmp::new();
    let mut s = autoritativa(tmp.path());
    let rev = s.commit_authoritative_with_events(1, "{\"a\":1}", &[ev("k.a"), ev("k.b"), ev("k.c")]).unwrap();
    assert_eq!(rev, 2);
    assert_eq!(rev_y_doc(&s), (2, "{\"a\":1}".into()));
    let page = s.events_page(&EventQuery::default()).unwrap();
    assert_eq!(page.events.len(), 3);
    assert!(page.events.iter().all(|e| e.state_rev == Some(2)), "los hechos de un mismo commit comparten EXACTAMENTE el mismo state_rev");
    assert_eq!(page.events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["k.a", "k.b", "k.c"], "en el orden en que se emitieron");
    // Otro commit: otro state_rev. Uno sin eventos no inventa ninguno.
    s.commit_authoritative_with_events(2, "{\"a\":2}", &[ev("k.d")]).unwrap();
    s.commit_authoritative(3, "{\"a\":3}").unwrap();
    s.commit_authoritative_with_events(4, "{\"a\":4}", &[ev("k.e"), ev("k.f")]).unwrap();
    let revs: Vec<_> = s.events_page(&EventQuery::default()).unwrap().events.iter().map(|e| e.state_rev).collect();
    assert_eq!(revs, vec![Some(2), Some(2), Some(2), Some(3), Some(5), Some(5)]);
}

#[test]
fn un_error_en_el_segundo_evento_deshace_el_primero_y_la_mutacion() {
    let tmp = Tmp::new();
    let mut s = autoritativa(tmp.path());
    let antes = rev_y_doc(&s);
    // El segundo evento reutiliza el id del primero: SQLite lo rechaza DESPUÉS de haber insertado el
    // primero y de haber actualizado `legacy_state`.
    let a = ev("k.uno");
    let b = NewEvent { id: a.id.clone(), ..ev("k.dos") };
    let r = s.commit_authoritative_with_events(1, "{\"a\":99}", &[a, b]);
    assert!(matches!(r, Err(StoreError::Sqlite(_))), "{r:?}");
    assert_eq!(rev_y_doc(&s), antes, "ni la nueva rev ni el nuevo documento");
    assert_eq!(cuenta(&s), 0, "ni el primer evento");
    // La base sigue sana: el mismo commit con eventos válidos funciona desde la misma rev.
    assert_eq!(s.commit_authoritative_with_events(1, "{\"a\":99}", &[ev("k.uno"), ev("k.dos")]).unwrap(), 2);
    assert_eq!(cuenta(&s), 2);
}

#[test]
fn un_conflicto_de_rev_o_un_documento_invalido_no_dejan_eventos() {
    let tmp = Tmp::new();
    let mut s = autoritativa(tmp.path());
    let r = s.commit_authoritative_with_events(7, "{\"a\":1}", &[ev("k.a")]);
    assert!(matches!(r, Err(StoreError::RevConflict { expected: 7, actual: Some(1) })), "{r:?}");
    let r = s.commit_authoritative_with_events(1, "no json", &[ev("k.a")]);
    assert!(matches!(r, Err(StoreError::InvalidDocument(_))), "{r:?}");
    let r = s.commit_authoritative_with_events(1, "{}", &[NewEvent { payload: "[]".into(), ..ev("k.mal") }]);
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))), "{r:?}");
    assert_eq!(cuenta(&s), 0);
    assert_eq!(s.legacy_state().unwrap().unwrap().rev, 1);
}

#[test]
fn un_hecho_ya_registrado_no_impide_confirmar_la_mutacion() {
    let tmp = Tmp::new();
    let mut s = autoritativa(tmp.path());
    s.commit_authoritative_with_events(1, "{\"a\":1}", &[con_idem("k.hecho", "x")]).unwrap();
    // El mismo hecho de nuevo (p. ej. una reentrega): la mutación se confirma, el evento no se duplica.
    s.commit_authoritative_with_events(2, "{\"a\":2}", &[con_idem("k.hecho", "x"), ev("k.otro")]).unwrap();
    assert_eq!(s.legacy_state().unwrap().unwrap().rev, 3);
    assert_eq!(cuenta(&s), 2);
}

#[test]
fn sin_autoridad_no_se_escribe_ni_el_estado_ni_los_eventos() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.write(|tx| {
        tx.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 1, 0, '{}', 1)", [])?;
        Ok(())
    })
    .unwrap();
    let r = s.commit_authoritative_with_events(1, "{\"a\":1}", &[ev("k.a")]);
    assert!(matches!(r, Err(StoreError::NotAuthoritative)), "{r:?}");
    assert_eq!((cuenta(&s), s.legacy_state().unwrap().unwrap().rev), (0, 1));
}

#[test]
fn una_mutacion_sin_eventos_no_toca_la_tabla_y_funciona_en_una_base_sin_la_004() {
    let tmp = Tmp::new();
    // Una base de D: autoritativa pero sin la 004 (no existe la tabla `events`).
    let mut s = Store::open_with(tmp.path(), &hasta_la_003(), "t").unwrap();
    s.write(|tx| {
        tx.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 1, 0, '{}', 1)", [])?;
        tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", rusqlite::params![META_MODE, MODE_SQLITE_AUTHORITATIVE])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(s.commit_authoritative(1, "{\"a\":1}").unwrap(), 2, "sin eventos, como siempre");
    // Con eventos falla de forma limpia y deshace también la mutación.
    let r = s.commit_authoritative_with_events(2, "{\"a\":2}", &[ev("k.a")]);
    assert!(matches!(r, Err(StoreError::Sqlite(_))), "{r:?}");
    assert_eq!(rev_y_doc(&s), (2, "{\"a\":1}".into()), "ni la nueva rev");
}

#[test]
fn los_eventos_standalone_no_llevan_state_rev() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.append_events(&[ev("k.suelto")]).unwrap();
    assert_eq!(s.events_page(&EventQuery::default()).unwrap().events[0].state_rev, None);
}

// ---------------------------------------------------------------------------------------------
// Filtros de lectura (LXO-83)
// ---------------------------------------------------------------------------------------------

fn con(kind: &str, project: Option<&str>, run: Option<&str>, entity: (&str, &str), class: EventClass) -> NewEvent {
    NewEvent {
        project_id: project.map(Into::into),
        run_id: run.map(Into::into),
        entity_kind: entity.0.into(),
        entity_id: entity.1.into(),
        class,
        ..ev(kind)
    }
}

fn filtrado(s: &Store, q: EventQuery) -> Vec<i64> {
    s.events_page(&q).unwrap().events.iter().map(|e| e.seq).collect()
}

#[test]
fn los_filtros_se_combinan_con_and_y_conservan_el_orden_por_seq() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.append_events(&[
        con("task.created", Some("p1"), Some("r1"), ("task", "t1"), EventClass::State),
        con("task.status_changed", Some("p1"), Some("r1"), ("task", "t1"), EventClass::State),
        con("task.created", Some("p2"), Some("r2"), ("task", "t2"), EventClass::State),
        con("decision.recorded", Some("p1"), Some("r1"), ("task", "t1"), EventClass::Decision),
        con("effect.observed", Some("p1"), Some("r1"), ("task", "t1"), EventClass::Effect),
        con("project.registered", Some("p3"), None, ("project", "p3"), EventClass::State),
    ])
    .unwrap();
    let q = EventQuery::default;
    assert_eq!(filtrado(&s, EventQuery { project_id: Some("p1".into()), ..q() }), vec![1, 2, 4, 5]);
    assert_eq!(filtrado(&s, EventQuery { run_id: Some("r2".into()), ..q() }), vec![3]);
    assert_eq!(filtrado(&s, EventQuery { entity_kind: Some("task".into()), entity_id: Some("t1".into()), ..q() }), vec![1, 2, 4, 5]);
    assert_eq!(filtrado(&s, EventQuery { entity_kind: Some("project".into()), ..q() }), vec![6]);
    assert_eq!(filtrado(&s, EventQuery { kind: Some("task.created".into()), ..q() }), vec![1, 3]);
    assert_eq!(filtrado(&s, EventQuery { kind_prefix: Some("task.".into()), ..q() }), vec![1, 2, 3]);
    assert_eq!(filtrado(&s, EventQuery { class: Some(EventClass::Decision), ..q() }), vec![4]);
    assert_eq!(filtrado(&s, EventQuery { project_id: Some("p1".into()), kind_prefix: Some("task.".into()), after: Some(1), ..q() }), vec![2]);
    assert_eq!(filtrado(&s, EventQuery { project_id: Some("nadie".into()), ..q() }), Vec::<i64>::new());
}

#[test]
fn el_prefijo_de_kind_es_literal_y_sensible_a_mayusculas() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    s.append_events(&[ev("a_b.x"), ev("axb.x"), ev("a%b.x"), ev("A_B.x")]).unwrap();
    let por_prefijo = |p: &str| filtrado(&s, EventQuery { kind_prefix: Some(p.into()), ..Default::default() });
    assert_eq!(por_prefijo("a_b"), vec![1]);
    assert_eq!(por_prefijo("a%"), vec![3]);
    assert_eq!(por_prefijo("A_"), vec![4]);
    assert_eq!(por_prefijo("a"), vec![1, 2, 3]);
}

#[test]
fn un_filtro_mal_formado_es_un_error_y_no_se_ignora() {
    let tmp = Tmp::new();
    let s = abre(tmp.path());
    let malos = [
        EventQuery { project_id: Some(String::new()), ..Default::default() },
        EventQuery { kind: Some("a".into()), kind_prefix: Some("a".into()), ..Default::default() },
        EventQuery { entity_id: Some("t1".into()), ..Default::default() },
    ];
    for q in malos {
        assert!(matches!(s.events_page(&q), Err(StoreError::InvalidEvent(_))), "{q:?}");
    }
}

#[test]
fn la_pagina_filtrada_pagina_sin_saltar_y_head_seq_es_global() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let lote: Vec<NewEvent> = (0..30).map(|i| con("k.x", Some(if i % 3 == 0 { "p" } else { "q" }), None, ("core", "core"), EventClass::State)).collect();
    s.append_events(&lote).unwrap();
    let (mut vistos, mut cursor) = (vec![], None);
    loop {
        let p = s.events_page(&EventQuery { project_id: Some("p".into()), after: cursor, limit: Some(4), ..Default::default() }).unwrap();
        assert_eq!(p.head_seq, 30);
        vistos.extend(p.events.iter().map(|e| e.seq));
        match (p.has_more, p.next_cursor) {
            (true, Some(c)) => cursor = Some(c),
            _ => break,
        }
    }
    assert_eq!(vistos, (0..10).map(|i| 1 + i * 3).collect::<Vec<i64>>());
}
