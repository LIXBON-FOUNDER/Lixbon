//! LXO-146 · Compare de extremo a extremo: `attempt_compare` sobre Attempts reales (adapters falsos, repositorios y worktrees de verdad). Se
//! comprueba lo que importa del contrato: qué se puede comparar, la procedencia de cada dato (`verified` · `agent_reported` · `unknown`),
//! que lo que falta es `unknown` y nunca un cero, que la respuesta es determinista y acotada y que leer no escribe nada.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter::AdapterError;
use super::attempt_e2e_tests::{world, World};
use super::dispatch_tests::row;
use super::{Caller, Core};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn task_of(attempt: &str) -> String {
    attempt.rsplit_once("-a").unwrap().0.to_string()
}

/// La carpeta del worktree que el Core creó para el Attempt.
fn worktree(core: &Core, attempt: &str) -> PathBuf {
    let path: String = core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT path FROM worktrees WHERE attempt_id = ?1", [attempt], |r| r.get(0))?))).unwrap().unwrap();
    PathBuf::from(path)
}

/// Un commit en la rama del Attempt con estos archivos (ruta → contenido).
fn commit(core: &Core, attempt: &str, files: &[(&str, &str)]) {
    let dir = worktree(core, attempt);
    for (path, content) in files {
        std::fs::write(dir.join(path), content).unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "trabajo"]);
}

fn event_total(core: &Core) -> i64 {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))).unwrap().unwrap()
}

impl World {
    fn compare(&self, ids: &[&str]) -> Result<Value, String> {
        self.desktop("attempt_compare", json!({ "attempt_ids": ids }))
    }

    fn fork_done(&self, source: &str, request_id: &str) -> String {
        let forked = self.desktop("attempt_fork", json!({"request_id": request_id, "source_attempt_id": source})).unwrap();
        let attempt = forked["attempt_id"].as_str().unwrap().to_string();
        self.approve(&attempt);
        self.settled(&attempt, "done");
        attempt
    }
}

fn by_id<'a>(response: &'a Value, attempt: &str) -> &'a Value {
    response["attempts"].as_array().unwrap().iter().find(|a| a["attempt_id"] == attempt).unwrap_or_else(|| panic!("falta {attempt}"))
}

#[test]
fn un_origen_y_sus_forks_se_comparan_con_los_cambios_que_el_core_calculo_con_git() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let f2 = w.fork_done(&a1, "cmp-fork-2");
    commit(&w.core, &a1, &[("README.md", "origen\n"), ("a.txt", "solo del origen\n")]);
    commit(&w.core, &f1, &[("README.md", "fork uno\n"), ("b.txt", "solo del fork\n"), ("c.txt", "otro\n")]);
    // f2 no cambia nada.

    let r = w.compare(&[&a1, &f1, &f2]).expect("la comparación");
    assert_eq!((r["v"].as_i64(), r["relation"]["kind"].as_str(), r["relation"]["root"].as_str()), (Some(1), Some("fork_family"), Some(a1.as_str())));
    assert_eq!(r["attempts"].as_array().unwrap().iter().map(|a| a["attempt_id"].as_str().unwrap()).collect::<Vec<_>>(), vec![a1.as_str(), f1.as_str(), f2.as_str()], "en el orden pedido");

    // Los cambios salen de git, ejecutado por el Core sobre su rama: `verified`, con sumas.
    let c1 = &by_id(&r, &a1)["changes"];
    assert_eq!((c1["files"]["value"].as_i64(), c1["files"]["provenance"].as_str()), (Some(2), Some("verified")));
    assert_eq!((c1["additions"]["value"].as_i64(), c1["deletions"]["value"].as_i64()), (Some(2), Some(1)), "README.md: -base +origen; a.txt: +1");
    assert_eq!(c1["list"], json!([{"path": "README.md", "additions": 1, "deletions": 1}, {"path": "a.txt", "additions": 1, "deletions": 0}]));
    assert_eq!(by_id(&r, &f1)["changes"]["files"]["value"], 3);
    // Un Attempt que de verdad no cambió nada es un cero VERIFICADO (el Core lo calculó): se distingue de «no se sabe».
    let c2 = &by_id(&r, &f2)["changes"];
    assert_eq!((c2["files"]["value"].as_i64(), c2["files"]["provenance"].as_str(), c2["truncated"].as_bool()), (Some(0), Some("verified"), Some(false)));

    // La revisión que se compara es el commit de la rama, no una deducción.
    let head: String = git(&worktree(&w.core, &a1), &["rev-parse", "HEAD"]);
    let rev = &by_id(&r, &a1)["revision"];
    assert_eq!((rev["head_commit"]["value"].as_str(), rev["head_commit"]["provenance"].as_str(), rev["source"].as_str()), (Some(head.as_str()), Some("verified"), Some("live_branch")));
    assert_eq!(rev["base_commit"]["provenance"], "verified");

    // El origen se ve como origen y los Forks, como Forks; cada uno con su selección y su host verificados.
    assert_eq!((by_id(&r, &a1)["forked_from"].as_str(), by_id(&r, &f1)["forked_from"].as_str()), (None, Some(a1.as_str())));
    let sel = &by_id(&r, &f1)["selection"];
    assert_eq!((sel["provenance"].as_str(), sel["value"]["provider"].as_str()), (Some("verified"), Some("claude")));
    assert_eq!(by_id(&r, &a1)["host"]["provenance"], "verified");

    // Solapes: el único archivo que tocaron dos Attempts.
    assert_eq!(r["overlaps"], json!({"complete": true, "total": 1, "items": [{"path": "README.md", "attempt_ids": [a1, f1]}]}));
}

#[test]
fn dos_forks_hermanos_son_comparables_y_lo_demas_no() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let f2 = w.fork_done(&a1, "cmp-fork-2");
    assert_eq!(w.compare(&[&f1, &f2]).unwrap()["relation"], json!({"kind": "fork_family", "root": a1}));

    // Un Fork y una Task ajena, o dos Forks de orígenes distintos, no tienen nada en común.
    let ajeno = w.finished("cmp-ajeno");
    for ids in [vec![f1.as_str(), ajeno.as_str()], vec![a1.as_str(), ajeno.as_str()]] {
        let e = w.compare(&ids).unwrap_err();
        assert!(e.contains("compare_not_comparable"), "{e}");
    }
    let f_ajeno = w.fork_done(&ajeno, "cmp-fork-ajeno");
    assert!(w.compare(&[&f1, &f_ajeno]).unwrap_err().contains("compare_not_comparable"));
}

#[test]
fn dos_attempts_de_la_misma_task_se_comparan_y_el_anterior_no_inventa_cambios() {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Fail(AdapterError::provider("se cayó"))]));
    let a1 = w.create("claude", "cmp-misma-task");
    w.approve(&a1);
    w.settled(&a1, "failed");
    let task = task_of(&a1);
    w.adapter.set_script(vec![Step::Output("ahora sí".into()), Step::Complete(Some("hecho a la segunda".into()))]);
    assert_eq!(w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": a1})).unwrap()["status"], "Requested");
    let a2 = format!("{task}-a2");
    w.settled(&a2, "done");
    // Un reintento trabaja en el MISMO worktree de la Task (lo registró el primer Attempt): ahí está el trabajo de la segunda.
    commit(&w.core, &a1, &[("trabajo.txt", "lo de la segunda\n")]);

    let r = w.compare(&[&a1, &a2]).unwrap();
    assert_eq!(r["relation"], json!({"kind": "same_task", "root": task}));
    // La rama de la Task es la del Attempt actual: del anterior no hay una rama propia que leer. Es «no se sabe», no «cero archivos».
    let anterior = &by_id(&r, &a1)["changes"];
    assert_eq!((anterior["files"]["value"].clone(), anterior["files"]["provenance"].as_str(), anterior["files"]["reason"].as_str()), (Value::Null, Some("unknown"), Some("not_current_attempt")));
    assert_eq!(anterior["list"], json!([]));
    assert_eq!(by_id(&r, &a2)["changes"]["files"]["value"], 1);
    assert_eq!((by_id(&r, &a1)["is_current"].as_bool(), by_id(&r, &a2)["is_current"].as_bool()), (Some(false), Some(true)));
    // El estado de cada uno, tal cual lo registró el Core.
    assert_eq!(by_id(&r, &a1)["status"]["value"]["status"], "failed");
    assert_eq!(by_id(&r, &a2)["status"]["value"]["status"], "done");
    // Sin archivos en común no hay solapes (y la lista está completa).
    assert_eq!(r["overlaps"]["total"], 0);
}

#[test]
fn lo_que_cuenta_el_agente_no_es_verified_y_lo_que_falta_es_unknown_nunca_cero() {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("Arreglé el login".into()))]));
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let r = w.compare(&[&a1, &f1]).unwrap();
    let a = by_id(&r, &a1);

    // El resumen lo escribió el agente: `agent_reported`, con su texto, jamás `verified`.
    assert_eq!((a["summary"]["provenance"].as_str(), a["summary"]["value"].as_str()), (Some("agent_reported"), Some("Arreglé el login")));
    // Las pruebas no se recogen: `unknown` con su motivo, no «0 fallos».
    assert_eq!((a["tests"]["value"].clone(), a["tests"]["provenance"].as_str(), a["tests"]["reason"].as_str()), (Value::Null, Some("unknown"), Some("not_collected")));
    // Sin artefactos registrados no se dice «0 artefactos»: se dice que no hay dato.
    assert_eq!((a["artifacts"]["provenance"].as_str(), a["artifacts"]["reason"].as_str(), &a["artifacts"]["items"]), (Some("unknown"), Some("none_recorded"), &json!([])));
    // Sin revisión, lo dice.
    assert_eq!((a["review"]["provenance"].as_str(), a["review"]["reason"].as_str()), (Some("unknown"), Some("not_reviewed")));
    // Los tiempos son del reloj del Core.
    let timing = &a["timing"];
    assert_eq!(timing["provenance"], "verified");
    assert!(timing["value"]["duration_ms"].as_i64().is_some_and(|d| d >= 0));
}

#[test]
fn un_attempt_sin_worktree_ni_trabajo_lanzado_es_unknown_en_host_revision_y_cambios() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    // Un Fork recién pedido: pendiente de aprobación, sin worktree.
    let f1 = w.desktop("attempt_fork", json!({"request_id": "cmp-fork-1", "source_attempt_id": a1})).unwrap()["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(row(&w.core, &f1).0, "pending_approval");

    let r = w.compare(&[&a1, &f1]).unwrap();
    let f = by_id(&r, &f1);
    for field in [&f["host"], &f["worktree"], &f["revision"]["base_commit"], &f["revision"]["head_commit"], &f["changes"]["files"], &f["changes"]["additions"], &f["changes"]["deletions"]] {
        assert_eq!((field["value"].clone(), field["provenance"].as_str(), field["reason"].as_str()), (Value::Null, Some("unknown"), Some("no_worktree")), "{field}");
    }
    assert_eq!((f["changes"]["total_files"].clone(), f["changes"]["truncated"].as_bool()), (Value::Null, Some(false)));
    assert_eq!(f["revision"]["source"], Value::Null);
    // Con una lista que no se pudo leer, los solapes dicen que pueden ser más de los que se ven.
    assert_eq!(r["overlaps"]["complete"], false);
    // Lo que sí se sabe sigue ahí: la selección y el estado.
    assert_eq!(f["status"]["value"]["status"], "pending_approval");
}

#[test]
fn un_diff_enorme_viaja_acotado_con_el_total_y_sin_sumas_que_engañen() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let muchos: Vec<(String, String)> = (0..205).map(|i| (format!("f{i:03}.txt"), format!("{i}\n"))).collect();
    let refs: Vec<(&str, &str)> = muchos.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
    commit(&w.core, &f1, &refs);
    commit(&w.core, &a1, &[("f000.txt", "origen\n")]);

    let r = w.compare(&[&a1, &f1]).unwrap();
    let c = &by_id(&r, &f1)["changes"];
    assert_eq!((c["files"]["value"].as_i64(), c["total_files"].as_i64(), c["truncated"].as_bool(), c["list"].as_array().map(Vec::len)), (Some(205), Some(205), Some(true), Some(200)));
    assert_eq!(c["list"][0]["path"], "f000.txt");
    assert_eq!(c["list"][199]["path"], "f199.txt", "ordenados por ruta; el resto se recorta");
    // Con la lista recortada las sumas no valen: son `unknown`, no una cifra parcial.
    assert_eq!((c["additions"]["provenance"].as_str(), c["additions"]["reason"].as_str(), c["additions"]["value"].clone()), (Some("unknown"), Some("truncated"), Value::Null));
    // Y los solapes avisan de que la lista no está completa.
    assert_eq!(r["overlaps"]["complete"], false);
    assert_eq!(r["overlaps"]["items"], json!([{"path": "f000.txt", "attempt_ids": [a1, f1]}]));
}

#[test]
fn un_archivo_binario_no_inventa_cuentas() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let dir = worktree(&w.core, &f1);
    std::fs::write(dir.join("logo.bin"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
    std::fs::write(dir.join("nota.txt"), "texto\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "binario"]);

    let r = w.compare(&[&a1, &f1]).unwrap();
    let c = &by_id(&r, &f1)["changes"];
    assert_eq!(c["files"]["value"], 2, "los archivos sí se cuentan");
    assert_eq!((c["additions"]["provenance"].as_str(), c["additions"]["reason"].as_str()), (Some("unknown"), Some("binary_files")), "pero sin cuentas de líneas fiables");
    let bin = c["list"].as_array().unwrap().iter().find(|f| f["path"] == "logo.bin").unwrap();
    assert_eq!((bin["additions"].clone(), bin["deletions"].clone()), (Value::Null, Value::Null));
}

#[test]
fn comparar_es_determinista_y_no_escribe_nada() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    commit(&w.core, &f1, &[("README.md", "fork\n")]);
    let before = event_total(&w.core);

    let first = w.compare(&[&a1, &f1]).unwrap();
    let second = w.compare(&[&a1, &f1]).unwrap();
    assert_eq!(first, second, "la misma petición da la misma respuesta");
    // El orden pedido manda, y lo demás no cambia.
    let swapped = w.compare(&[&f1, &a1]).unwrap();
    assert_eq!(swapped["attempts"][0]["attempt_id"], f1.as_str());
    assert_eq!(swapped["attempts"][1], first["attempts"][0]);
    assert_eq!(swapped["overlaps"], first["overlaps"]);
    assert_eq!(event_total(&w.core), before, "leer no escribe eventos");
    assert_eq!((row(&w.core, &a1).0.as_str(), row(&w.core, &f1).0.as_str()), ("done", "done"));
}

#[test]
fn la_peticion_se_valida_y_solo_una_persona_de_desktop_compara() {
    let w = world("claude", None);
    let a1 = w.finished("cmp-origen");
    let f1 = w.fork_done(&a1, "cmp-fork-1");
    let f2 = w.fork_done(&a1, "cmp-fork-2");
    let f3 = w.fork_done(&a1, "cmp-fork-3");
    let f4 = w.fork_done(&a1, "cmp-fork-4");

    assert!(w.compare(&[&a1]).unwrap_err().contains("de 2 a 4 Attempts"));
    assert!(w.compare(&[&a1, &f1, &f2, &f3, &f4]).unwrap_err().contains("de 2 a 4 Attempts"));
    assert!(w.compare(&[&a1, &f1, &f2, &f3]).is_ok(), "cuatro caben");
    assert!(w.compare(&[&a1, &a1]).unwrap_err().contains("está repetido"));
    assert!(w.compare(&[&a1, "t999-a1"]).unwrap_err().contains("model_not_found"));
    assert!(w.compare(&[&a1, ""]).is_err());
    for bad in [json!({}), json!({"attempt_ids": "a,b"}), json!({"attempt_ids": [1, 2]}), json!({"attempt_ids": [a1, f1], "project_id": "x"})] {
        assert!(w.desktop("attempt_compare", bad.clone()).unwrap_err().contains("model_invalid_request"), "{bad}");
    }
    // Ni un agente ni el CLI.
    let args = json!({"attempt_ids": [a1, f1]});
    assert!(w.core.rpc(Caller::Agent(Some(task_of(&a1))), "", "attempt_compare", &args).is_err());
    assert!(w.core.rpc_via(super::events::Channel::Lxo, Caller::User, "", "attempt_compare", &args).is_err());
}
