//! Pruebas del registro de proyectos en el almacén (migración 003, slice D).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::projects::new_project_id;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-proj-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

fn fp(commits: &[&str], remotes: &[&str]) -> Fingerprint {
    Fingerprint { root_commits: commits.iter().map(|s| s.to_string()).collect(), remotes: remotes.iter().map(|s| s.to_string()).collect(), default_branch: Some("main".into()) }
}

fn loc(path: &str) -> NewLocation {
    NewLocation { machine: "m1".into(), path: path.into(), display_path: path.to_uppercase(), primary: true }
}

fn raw_err(s: &mut Store, sql: &str) -> bool {
    s.write(|tx| {
        tx.execute_batch(sql)?;
        Ok(())
    })
    .is_err()
}

#[test]
fn la_003_se_aplica_desde_cero_y_solo_crea_las_dos_tablas_de_d() {
    let tmp = Tmp::new();
    let s = abre(tmp.path());
    let lista = embedded();
    assert_eq!(lista.iter().map(|m| (m.version, m.name)).collect::<Vec<_>>(), vec![(1, "core"), (2, "authority_fence"), (3, "projects")]);
    assert_eq!(s.migration_report().to_version, 3);
    let tablas: Vec<String> = s
        .read(|c| {
            let mut stmt = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(tablas, vec!["legacy_state", "meta", "project_locations", "projects", "schema_migrations"], "nada de E, F1 ni G");
}

/// El checksum de una migración es el SHA-256 de TODO su texto (sin `\r`), COMENTARIOS INCLUIDOS: el
/// almacén guarda ese valor al aplicarla y se niega a abrir una base cuya migración cambió. Por eso
/// ni siquiera se «corrige» un comentario de una migración ya publicada (ver `docs/core/MIGRACIONES.md`).
#[test]
fn un_comentario_cambia_el_checksum_asi_que_una_migracion_publicada_no_se_toca_ni_por_documentacion() {
    let a = Migration::new(1, "x", "-- comentario viejo\nCREATE TABLE a (x INTEGER) STRICT;\n");
    let b = Migration::new(1, "x", "-- comentario corregido\nCREATE TABLE a (x INTEGER) STRICT;\n");
    assert_ne!(a.checksum(), b.checksum(), "un comentario distinto es otro checksum");
    // Lo único que no cuenta es el fin de línea (core.autocrlf).
    let crlf = Migration::new(1, "x", "-- comentario viejo\r\nCREATE TABLE a (x INTEGER) STRICT;\r\n");
    assert_eq!(a.checksum(), crlf.checksum());
    // El caso real: la 001 publicada con SOLO un comentario corregido ya no abre una base existente.
    let original = embedded()[0];
    let editado: &'static str = Box::leak(format!("-- comentario corregido\n{}", original.sql).into_boxed_str());
    let editada = Migration::new(1, original.name, editado);
    assert_ne!(original.checksum(), editada.checksum());
    let tmp = Tmp::new();
    drop(Store::open_with(tmp.path(), &[original], "t").unwrap());
    match Store::open_with(tmp.path(), &[editada], "t") {
        Err(StoreError::ChecksumMismatch { version: 1, .. }) => {}
        otro => panic!("se esperaba ChecksumMismatch y salió {otro:?}"),
    }
}

/// Las migraciones publicadas quedan CONGELADAS. Si un checksum cambia, alguien editó una migración ya
/// publicada (aunque fuera un comentario): invalidaría las instalaciones existentes. Se crea una
/// migración nueva; nunca se edita la anterior.
#[test]
fn las_migraciones_publicadas_no_se_editan() {
    let esperado = [
        (1, "core", "b4bfd527bb7f20e011b7435091dd84a4e5f9738484446a11032dfc7b1fe9248a"),
        (2, "authority_fence", "85fff4a938f08b2b0f566d75e1d1eea6aca7d89586060b84ee303b39d340afbe"),
        (3, "projects", "ae5b5563ed06c996b45eb3e7d24e759b8799d2236cf882dd43621fa19bc5257e"),
    ];
    let lista = embedded();
    assert!(lista.len() >= esperado.len());
    for (m, (v, n, c)) in lista.iter().zip(esperado) {
        assert_eq!((m.version, m.name), (v, n));
        assert_eq!(m.checksum(), c, "la migración {v:03}_{n} cambió: una migración publicada no se edita");
    }
}

#[test]
fn crear_un_proyecto_guarda_identidad_huella_y_ubicacion_principal() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let p = s.project_create("api", &fp(&["c1", "c2"], &["github.com/o/api"]), &loc("c:/proyectos/api")).unwrap();
    assert!(!p.archived && p.remote_project_id.is_none() && p.team_project_id.is_none(), "Team queda vacío");
    assert_eq!(p.fingerprint, fp(&["c1", "c2"], &["github.com/o/api"]));
    assert_eq!(p.settings, "{}");
    let ls = s.project_locations(Some(&p.id)).unwrap();
    assert_eq!(ls.len(), 1);
    assert!(ls[0].primary && !ls[0].missing);
    assert_eq!((ls[0].path.as_str(), ls[0].display_path.as_str()), ("c:/proyectos/api", "C:/PROYECTOS/API"));
    assert_eq!(s.project_by_location("m1", "c:/proyectos/api").unwrap().as_deref(), Some(p.id.as_str()));
    assert_eq!(s.project_by_location("otra-maquina", "c:/proyectos/api").unwrap(), None, "la ubicación es por máquina");
}

#[test]
fn los_ids_son_uuid_v7_ordenables_por_creacion() {
    let a = new_project_id();
    std::thread::sleep(std::time::Duration::from_millis(3));
    let b = new_project_id();
    for id in [&a, &b] {
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'7', "versión 7: {id}");
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'), "variante RFC 4122: {id}");
    }
    assert!(a < b, "orden temporal: {a} < {b}");
}

#[test]
fn una_ruta_pertenece_a_un_solo_proyecto_y_la_ubicacion_principal_es_unica() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = s.project_create("a", &fp(&["c1"], &[]), &loc("c:/a")).unwrap();
    let b = s.project_create("b", &fp(&["c9"], &[]), &loc("c:/b")).unwrap();
    // La ruta de `a` no se puede dar a `b`.
    let r = s.location_put(&b.id, &loc("c:/a"));
    assert!(matches!(r, Err(StoreError::ProjectConflict(_))), "{r:?}");
    // Otra ubicación principal para `a` reemplaza a la anterior (sigue habiendo UNA).
    s.location_put(&a.id, &loc("d:/a-clon")).unwrap();
    let ls = s.project_locations(Some(&a.id)).unwrap();
    assert_eq!(ls.len(), 2);
    assert_eq!(ls.iter().filter(|l| l.primary).map(|l| l.path.as_str()).collect::<Vec<_>>(), vec!["d:/a-clon"]);
    // Una ubicación no principal convive.
    s.location_put(&a.id, &NewLocation { primary: false, ..loc("e:/a-otra") }).unwrap();
    assert_eq!(s.project_locations(Some(&a.id)).unwrap().iter().filter(|l| l.primary).count(), 1);
    // Y un proyecto inexistente no recibe ubicaciones.
    assert!(matches!(s.location_put("no-existe", &loc("c:/z")), Err(StoreError::ProjectConflict(_))));
}

#[test]
fn la_base_impone_sus_reglas_aunque_el_codigo_falle() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let p = s.project_create("p", &fp(&[], &[]), &loc("c:/p")).unwrap();
    // FK real: no hay ubicación sin proyecto.
    assert!(raw_err(&mut s, "INSERT INTO project_locations (project_id, machine, path, display_path, last_seen) VALUES ('fantasma', 'm1', 'c:/x', 'c:/x', 1)"));
    // Dos principales en el mismo proyecto y máquina: el índice parcial lo impide.
    assert!(raw_err(
        &mut s,
        &format!("INSERT INTO project_locations (project_id, machine, path, display_path, last_seen, is_primary) VALUES ('{}', 'm1', 'c:/segunda', 'c:/segunda', 1, 1)", p.id)
    ));
    // Estado, nombre y JSON inválidos.
    assert!(raw_err(&mut s, "INSERT INTO projects (id, name, created_at, updated_at, fingerprint, state) VALUES ('x', 'n', 1, 1, '{}', 'borrado')"));
    assert!(raw_err(&mut s, "INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES ('x', '', 1, 1, '{}')"));
    assert!(raw_err(&mut s, "INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES ('x', 'n', 1, 1, 'no es json')"));
    // No se puede borrar un proyecto que tiene ubicaciones (el historial se archiva, no se borra).
    assert!(raw_err(&mut s, &format!("DELETE FROM projects WHERE id = '{}'", p.id)));
}

#[test]
fn archivar_oculta_sin_borrar_y_se_puede_restaurar() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = s.project_create("a", &fp(&["c1"], &[]), &loc("c:/a")).unwrap();
    let b = s.project_create("b", &fp(&["c2"], &[]), &loc("c:/b")).unwrap();
    assert!(s.project_set_archived(&a.id, true).unwrap());
    assert_eq!(s.projects(false).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["b"]);
    assert_eq!(s.projects(true).unwrap().len(), 2, "archivado = oculto, no borrado");
    assert_eq!(s.project_locations(Some(&a.id)).unwrap().len(), 1, "su historial de ubicaciones sigue");
    assert!(s.project(&a.id).unwrap().unwrap().archived);
    assert!(s.project_set_archived(&a.id, false).unwrap());
    assert_eq!(s.projects(false).unwrap().iter().map(|p| p.id.clone()).collect::<Vec<_>>(), vec![a.id.clone(), b.id.clone()], "orden de creación");
    assert!(!s.project_set_archived("no-existe", true).unwrap());
}

#[test]
fn proyectos_que_comparten_un_commit_raiz() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let a = s.project_create("a", &fp(&["r1", "r2"], &[]), &loc("c:/a")).unwrap();
    let b = s.project_create("b", &fp(&["r2"], &[]), &loc("c:/b")).unwrap();
    let _c = s.project_create("c", &fp(&["r9"], &[]), &loc("c:/c")).unwrap();
    s.project_set_archived(&b.id, true).unwrap();
    let mut esperado = vec![a.id.clone(), b.id.clone()];
    esperado.sort();
    assert_eq!(s.projects_sharing_root_commit(&["r2".into()]).unwrap(), esperado, "también los archivados: se pregunta, no se duplica");
    assert_eq!(s.projects_sharing_root_commit(&["r1".into(), "r2".into()]).unwrap().len(), 2, "sin duplicados");
    assert!(s.projects_sharing_root_commit(&[]).unwrap().is_empty());
    assert!(s.projects_sharing_root_commit(&["nada".into()]).unwrap().is_empty());
}

#[test]
fn una_ubicacion_desaparecida_se_marca_y_al_volver_se_recupera() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let p = s.project_create("p", &fp(&[], &[]), &loc("c:/p")).unwrap();
    s.location_mark("m1", "c:/p", true).unwrap();
    assert!(s.project_locations(Some(&p.id)).unwrap()[0].missing);
    s.location_mark("m1", "c:/p", false).unwrap();
    assert!(!s.project_locations(Some(&p.id)).unwrap()[0].missing);
}

#[test]
fn la_huella_se_puede_actualizar_y_meta_set_es_idempotente() {
    let tmp = Tmp::new();
    let mut s = abre(tmp.path());
    let p = s.project_create("p", &fp(&["c1"], &[]), &loc("c:/p")).unwrap();
    assert!(s.project_set_fingerprint(&p.id, &fp(&["c1"], &["github.com/o/p"])).unwrap());
    assert_eq!(s.project(&p.id).unwrap().unwrap().fingerprint.remotes, vec!["github.com/o/p"]);
    s.meta_set("projects_backfilled", "1").unwrap();
    s.meta_set("projects_backfilled", "2").unwrap();
    assert_eq!(s.meta("projects_backfilled").unwrap().as_deref(), Some("2"));
}

#[test]
fn reabrir_conserva_los_proyectos_y_no_vuelve_a_migrar() {
    let tmp = Tmp::new();
    let id = {
        let mut s = abre(tmp.path());
        s.project_create("p", &fp(&["c1"], &["github.com/o/p"]), &loc("c:/p")).unwrap().id
    };
    let s = abre(tmp.path());
    assert!(s.migration_report().applied.is_empty(), "ya estaba al día");
    assert_eq!(s.project(&id).unwrap().unwrap().name, "p");
    assert_eq!(s.project_locations(None).unwrap().len(), 1);
}
