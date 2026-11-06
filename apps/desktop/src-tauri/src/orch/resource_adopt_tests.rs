//! LXO-149/157 · Adoptar un worktree externo de extremo a extremo (migración 024): `resource_adopt_preview` y `resource_adopt` sobre worktrees REALES de git.
//! Se comprueba que solo se adopta lo limpio y comprometido, en una Task sin ejecución del mismo Project, que lo que no se puede adoptar se dice con un
//! código y no deja rastro, que el Attempt adoptado nace terminado sin inventar un historial, que repetir no hace nada y que el estado se reconstruye igual.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::attempt_e2e_tests::{world, World};
use super::compare_e2e_tests::{event_total, git};
use super::events::Channel;
use super::Caller;

impl World {
    fn adopt_repo(&self) -> PathBuf {
        self.core.project_launch_location(&self.project).unwrap()
    }

    /// Una Task del Project SIN Attempt (la intención de trabajo que aún no se ejecutó).
    fn adopt_bare_task(&self, request_id: &str, title: &str) -> String {
        let created = self
            .desktop("task_create", json!({"request_id": request_id, "project_id": self.project, "objective": "o", "title": title, "spec": "s", "repo": self.adopt_repo().to_string_lossy()}))
            .expect("task_create sin attempt");
        assert_eq!(created["status"], "Committed", "{created}");
        created["task_id"].as_str().unwrap().to_string()
    }

    /// Un worktree "externo": lo crea git a mano, fuera del repositorio, con un commit propio en su rama.
    fn adopt_external_worktree(&self, name: &str, branch: &str) -> PathBuf {
        let dir = self.adopt_repo().parent().unwrap().join(name);
        git(&self.adopt_repo(), &["worktree", "add", "-q", "-b", branch, &dir.to_string_lossy()]);
        git(&dir, &["config", "user.name", "Externo"]);
        git(&dir, &["config", "user.email", "externo@example.test"]);
        std::fs::write(dir.join("externo.txt"), "trabajo hecho fuera\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "trabajo externo"]);
        dir
    }

    fn adopt_preview(&self, path: &PathBuf) -> Value {
        self.desktop("resource_adopt_preview", json!({"project_id": self.project, "path": path.to_string_lossy()})).expect("preview")
    }

    fn adopt_it(&self, path: &PathBuf, task: &str) -> Result<Value, String> {
        self.desktop("resource_adopt", json!({"project_id": self.project, "path": path.to_string_lossy(), "task_id": task, "confirm": true}))
    }

    fn adopt_attempts_total(&self) -> i64 {
        self.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))?))).unwrap().unwrap()
    }

    fn adopt_kinds_of(&self, entity: &str) -> Vec<String> {
        self.core
            .storage
            .with_store(|s| {
                s.read(|c| {
                    let mut stmt = c.prepare("SELECT kind FROM events WHERE entity_id = ?1 ORDER BY seq")?;
                    let rows = stmt.query_map([entity], |r| r.get::<_, String>(0))?;
                    Ok(rows.collect::<Result<Vec<_>, _>>()?)
                })
            })
            .unwrap()
            .unwrap()
    }
}

fn code_of(e: &str) -> &str {
    e.split(':').next().unwrap_or(e)
}

#[test]
fn adoptar_un_worktree_limpio_crea_el_primer_attempt_ya_terminado_sin_inventar_historia() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-1", "revisar trabajo externo");
    let dir = w.adopt_external_worktree("wt-externo", "feature/externo");

    let p = w.adopt_preview(&dir);
    assert_eq!((p["branch"].as_str(), p["base"].as_str(), p["adopt"]["ok"].as_bool()), (Some("feature/externo"), Some("main"), Some(true)), "{p}");
    assert_eq!(p["tasks"], json!([{"task_id": task, "title": "revisar trabajo externo"}]));

    let r = w.adopt_it(&dir, &task).expect("la adopción");
    assert_eq!((r["status"].as_str(), r["attempt_id"].as_str()), (Some("Adopted"), Some(format!("{task}-a1").as_str())), "{r}");

    // El Attempt nació terminado y adoptado; ni arranque ni duración inventados.
    let attempt = format!("{task}-a1");
    let d = w.desktop("attempt_detail", json!({"attempt_id": attempt})).expect("attempt_detail");
    let a = &d["attempt"];
    assert_eq!((a["status"].as_str(), a["provider"].as_str(), a["adopted"].as_bool(), a["origin"].as_str()), (Some("done"), Some("external"), Some(true), Some("core")), "{a}");
    assert!(a["started_at"].is_null() && a["ended_at"].is_null(), "no hay arranque ni fin reales: {a}");
    assert_eq!(a["ended_at_known"], true);
    assert_eq!(a["worktree"]["provenance"], "adopted", "{d}");

    // Un solo hecho, de decisión; sin `attempt.started` ni `attempt.completed`.
    assert_eq!(w.adopt_kinds_of(&attempt).iter().filter(|k| k.starts_with("attempt.")).collect::<Vec<_>>(), ["attempt.adopted"]);
    // Ya no es elegible ni se puede adoptar otra vez en esa Task.
    assert_eq!(w.adopt_preview(&dir)["adopt"]["ok"], false);
}

#[test]
fn lo_que_no_se_puede_adoptar_se_dice_con_un_codigo_y_no_deja_rastro() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-2", "t");
    let dir = w.adopt_external_worktree("wt-sucio", "feature/sucio");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());

    // Sucio: cambios sin commit (también los archivos nuevos sin seguimiento).
    std::fs::write(dir.join("a_medias.txt"), "sin guardar\n").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_dirty");
    let e = w.adopt_it(&dir, &task).unwrap_err();
    assert_eq!(code_of(&e), "adopt_dirty", "{e}");
    std::fs::remove_file(dir.join("a_medias.txt")).unwrap();

    // El checkout principal no es un worktree adicional; una carpeta cualquiera no es un worktree.
    let main = w.adopt_repo();
    assert_eq!(code_of(&w.adopt_it(&main, &task).unwrap_err()), "adopt_main_checkout");
    let nada = main.parent().unwrap().join("no-es-un-worktree");
    std::fs::create_dir_all(&nada).unwrap();
    assert_eq!(code_of(&w.adopt_it(&nada, &task).unwrap_err()), "adopt_not_a_worktree");

    // Sin rama (HEAD desacoplado): no hay qué revisar ni integrar.
    let suelto = w.adopt_external_worktree("wt-suelto", "feature/suelto");
    git(&suelto, &["checkout", "-q", "--detach"]);
    assert_eq!(code_of(&w.adopt_it(&suelto, &task).unwrap_err()), "adopt_detached");

    // Sin confirmar no se hace nada.
    let e = w.desktop("resource_adopt", json!({"project_id": w.project, "path": dir.to_string_lossy(), "task_id": task})).unwrap_err();
    assert!(e.contains("confirmación"), "{e}");

    // Una Task que no existe, o que ya corrió, no recibe el worktree.
    let e = w.adopt_it(&dir, "t999").unwrap_err();
    assert_eq!(code_of(&e), "adopt_task_not_found", "{e}");

    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "nada de lo rechazado dejó rastro");
}

#[test]
fn solo_una_person_de_desktop_adopta_y_repetir_no_hace_nada() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-3", "t");
    let dir = w.adopt_external_worktree("wt-idem", "feature/idem");
    let args = json!({"project_id": w.project, "path": dir.to_string_lossy(), "task_id": task, "confirm": true});

    // Un agente no adopta, ni lee la previsualización.
    assert!(w.core.rpc_via(Channel::Ui, Caller::Agent(None), "", "resource_adopt", &args).is_err());
    assert!(w.core.rpc_via(Channel::Lxo, Caller::Agent(None), "", "resource_adopt", &args).is_err());
    assert_eq!(w.adopt_attempts_total(), 0);

    assert_eq!(w.adopt_it(&dir, &task).unwrap()["status"], "Adopted");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());
    let again = w.adopt_it(&dir, &task).expect("repetir");
    assert_eq!(again["status"], "AlreadyAdopted", "{again}");
    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "repetir no deja rastro");

    // El mismo worktree no se adopta en OTRA Task: ya tiene dueño.
    let otra = w.adopt_bare_task("ad-3b", "otra");
    assert_eq!(code_of(&w.adopt_it(&dir, &otra).unwrap_err()), "adopt_already_owned");
}

#[test]
fn con_el_core_en_solo_lectura_no_se_adopta_pero_se_previsualiza() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-4", "t");
    let dir = w.adopt_external_worktree("wt-ro", "feature/ro");
    w.core.degrade_for_tests("disco lleno");
    let p = w.adopt_preview(&dir);
    assert_eq!((p["adopt"]["ok"].as_bool(), p["adopt"]["code"].as_str(), p["health"]["writable"].as_bool()), (Some(false), Some("adopt_degraded"), Some(false)), "{p}");
    let e = w.adopt_it(&dir, &task).unwrap_err();
    assert_eq!(code_of(&e), "adopt_degraded", "{e}");
    assert_eq!(w.adopt_attempts_total(), 0);
}

#[test]
fn el_attempt_adoptado_se_reconstruye_igual_y_se_puede_revisar_con_la_evidencia_de_su_rama() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-5", "t");
    let dir = w.adopt_external_worktree("wt-pack", "feature/pack");
    w.adopt_it(&dir, &task).unwrap();
    let attempt = format!("{task}-a1");

    // La vista del almacén coincide con el estado en memoria: la Task adoptada vuelve a leerse igual desde las tablas.
    let t = w.desktop("task_detail_v2", json!({"task_id": task})).expect("task_detail_v2");
    assert_eq!(t["task"]["state"], "in_review", "lo adoptado espera revisión: {t}");
    assert_eq!(t["task"]["attempts"][0]["adopted"], true);

    // Reabrir: lo que las tablas reconstruyen es la Task adoptada, con su worktree, su rama y su Attempt.
    let load = w.core.storage.with_store(|s| s.runtime_load()).unwrap().unwrap();
    let doc = &load.doc["tasks"][&task];
    assert_eq!((doc["adopted"].as_bool(), doc["status"].as_str(), doc["branch"].as_str(), doc["agent"].as_str()), (Some(true), Some("done"), Some("feature/pack"), Some("external")), "{doc}");
    let slash = |p: &str| p.replace('\\', "/");
    assert_eq!(doc["worktree"].as_str().map(slash), Some(slash(&dir.to_string_lossy())));
    assert_eq!(load.attempts.get(&task), Some(&1));

    // La evidencia sale de git (rama contra la base), no de una ejecución que no hubo.
    let pack = w.desktop("attempt_proof_pack", json!({"attempt_id": attempt})).expect("proof pack");
    let text = pack.to_string();
    assert!(text.contains("externo.txt"), "el Proof Pack ve el archivo de la rama adoptada: {text}");
}

#[test]
fn reintentar_o_bifurcar_un_attempt_adoptado_falla_y_no_deja_nada() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-6", "t");
    let dir = w.adopt_external_worktree("wt-retry", "feature/retry");
    w.adopt_it(&dir, &task).unwrap();
    let attempt = format!("{task}-a1");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());

    let retry = w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": attempt}));
    let fork = w.desktop("attempt_fork", json!({"request_id": "fk-ad-1", "source_attempt_id": attempt}));
    assert!(retry.is_err(), "reintentar un adoptado no debe arrancar nada: {retry:?}");
    assert!(fork.is_err(), "bifurcar un adoptado no debe arrancar nada: {fork:?}");
    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "lo rechazado no deja rastro");
}

// ---- Revisión adversarial: lo que se intentó romper y ahora se rechaza ----

/// Un archivo versionado cuyo nombre CONTIENE `.lixbon` es trabajo de la persona: modificarlo sin commit es un cambio sin guardar. Solo la carpeta
/// `.lixbon` de la raíz (el entorno de Lixbon) no cuenta.
#[test]
fn un_archivo_con_lixbon_en_el_nombre_modificado_sin_commit_cuenta_como_sucio() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv-1", "t");
    let dir = w.adopt_external_worktree("wt-lixbon-nombre", "feature/lixbon");
    std::fs::write(dir.join("notas.lixbon.md"), "v1\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "notas"]);
    assert_eq!(w.adopt_preview(&dir)["adopt"]["ok"], true);
    std::fs::write(dir.join("notas.lixbon.md"), "v2 sin commit\n").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_dirty");
    assert_eq!(code_of(&w.adopt_it(&dir, &task).unwrap_err()), "adopt_dirty");
    // La carpeta de entorno de Lixbon en la raíz sí se ignora.
    git(&dir, &["checkout", "--", "notas.lixbon.md"]);
    std::fs::create_dir_all(dir.join(".lixbon")).unwrap();
    std::fs::write(dir.join(".lixbon").join("env"), "x").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["ok"], true);
}

/// Una etiqueta con el nombre de la rama no sustituye a la rama: el commit base es el `merge-base` REAL (antes `git merge-base main x` tomaba la etiqueta).
#[test]
fn una_etiqueta_con_el_nombre_de_la_rama_no_desvia_el_commit_base() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv-2", "t");
    let repo = w.adopt_repo();
    let c1 = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["commit", "--allow-empty", "-qm", "c2"]);
    let c2 = git(&repo, &["rev-parse", "HEAD"]);
    let dir = w.adopt_external_worktree("wt-amb", "feature/amb");
    git(&repo, &["tag", "feature/amb", &c1]);
    git(&repo, &["tag", "main", &c1]);
    w.adopt_it(&dir, &task).expect("la adopción");
    let base: String = w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT base_commit FROM worktrees WHERE task_id = ?1", [&task], |r| r.get(0))?))).unwrap().unwrap();
    assert_eq!(base, c2, "el commit base es el merge-base de las RAMAS, no el de una etiqueta homónima");
}

/// Una rama sin un solo commit propio (creada y vacía, o ya dentro de la base) no tiene trabajo que revisar: no se ofrece ni se adopta.
#[test]
fn una_rama_sin_commits_propios_no_se_adopta() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv-3", "t");
    let repo = w.adopt_repo();
    let dir = repo.parent().unwrap().join("wt-vacio");
    git(&repo, &["worktree", "add", "-q", "-b", "vacia", &dir.to_string_lossy()]);
    let p = w.adopt_preview(&dir);
    assert_eq!((p["adopt"]["ok"].as_bool(), p["adopt"]["code"].as_str()), (Some(false), Some("adopt_no_changes")), "{p}");
    let attempts = w.adopt_attempts_total();
    assert_eq!(code_of(&w.adopt_it(&dir, &task).unwrap_err()), "adopt_no_changes");
    assert_eq!(w.adopt_attempts_total(), attempts);
}

/// La Task debe ser del repositorio contra el que se verificó el worktree: una Task con otro `repo` no se ofrece ni lo recibe (antes quedaba un
/// Worktree con el `repo` equivocado, imposible de liberar o integrar).
#[test]
fn una_task_de_otro_repositorio_no_recibe_el_worktree() {
    let w = world("claude", None);
    let otro = std::env::temp_dir().join("lixbon-adv-otro-repo-inexistente");
    let created = w.desktop("task_create", json!({"request_id": "adv-7", "project_id": w.project, "objective": "o", "title": "ajena", "spec": "s", "repo": otro.to_string_lossy()})).unwrap();
    let ajena = created["task_id"].as_str().unwrap().to_string();
    let dir = w.adopt_external_worktree("wt-ajeno", "feature/ajeno");
    let p = w.adopt_preview(&dir);
    assert_eq!((p["adopt"]["code"].as_str(), p["tasks"].as_array().map(Vec::len)), (Some("adopt_no_task"), Some(0)), "{p}");
    let e = w.adopt_it(&dir, &ajena).unwrap_err();
    assert_eq!(code_of(&e), "adopt_task_not_eligible", "{e}");
    assert_eq!(w.adopt_attempts_total(), 0);
}

/// Dos adopciones a la vez: gana UNA, y la otra lo dice con un código estable (no con un error de SQLite), sin dejar nada a medias.
#[test]
fn dos_adopciones_a_la_vez_ganan_una_y_la_otra_lo_dice() {
    let w = world("claude", None);
    let t1 = w.adopt_bare_task("adv-5a", "uno");
    let t2 = w.adopt_bare_task("adv-5b", "dos");
    let dir = w.adopt_external_worktree("wt-carrera", "feature/carrera");
    // El MISMO worktree en dos Tasks distintas.
    for _ in 0..1 {
        let (a, b) = std::thread::scope(|s| {
            let h1 = s.spawn(|| w.adopt_it(&dir, &t1));
            let h2 = s.spawn(|| w.adopt_it(&dir, &t2));
            (h1.join().unwrap(), h2.join().unwrap())
        });
        let (ok, err) = if a.is_ok() { (a, b) } else { (b, a) };
        assert_eq!(ok.expect("una gana")["status"], "Adopted");
        let e = err.expect_err("la otra pierde");
        assert_eq!(code_of(&e), "adopt_already_owned", "{e}");
        assert_eq!(w.adopt_attempts_total(), 1);
    }
    // LA MISMA adopción dos veces a la vez: una `Adopted` y la otra `AlreadyAdopted`, nunca un error.
    let t3 = w.adopt_bare_task("adv-5c", "tres");
    let dir2 = w.adopt_external_worktree("wt-carrera2", "feature/carrera2");
    let (c, d) = std::thread::scope(|s| {
        let h1 = s.spawn(|| w.adopt_it(&dir2, &t3));
        let h2 = s.spawn(|| w.adopt_it(&dir2, &t3));
        (h1.join().unwrap(), h2.join().unwrap())
    });
    let mut estados = [c.expect("sin error")["status"].as_str().unwrap().to_string(), d.expect("sin error")["status"].as_str().unwrap().to_string()];
    estados.sort();
    assert_eq!(estados, ["Adopted", "AlreadyAdopted"]);
    assert_eq!(w.adopt_attempts_total(), 2);
}

/// Lo que dice el aviso de confirmación: adoptar no toca la carpeta, pero liberar la Task después la quita como con cualquier intento (la rama solo
/// se borra si ya está fusionada). La persona debe saberlo ANTES de confirmar.
#[test]
fn liberar_una_task_adoptada_quita_su_carpeta_y_conserva_la_rama_sin_fusionar() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv-6", "t");
    let dir = w.adopt_external_worktree("wt-release", "feature/release");
    w.adopt_it(&dir, &task).unwrap();
    assert!(dir.exists(), "adoptar no toca la carpeta");
    let r = w.desktop("release", json!({"task": task, "force": false})).expect("release");
    assert_eq!((r["worktree_removed"].as_bool(), r["branch_deleted"].as_bool()), (Some(true), Some(false)), "{r}");
    assert!(!dir.exists(), "liberar la Task quita la carpeta");
    assert!(git(&w.adopt_repo(), &["branch", "--list", "feature/release"]).contains("feature/release"), "la rama sin fusionar se conserva");
}

/// Rutas con espacios y acentos, y (en Windows) con barras distintas o el prefijo extendido, identifican el mismo worktree.
#[test]
fn la_ruta_del_worktree_se_reconoce_con_espacios_acentos_y_variantes_de_windows() {
    let w = world("claude", None);
    w.adopt_bare_task("adv-8", "t");
    let dir = w.adopt_external_worktree("wt ñandú externo", "feature/ñandú");
    let base = dir.to_string_lossy().to_string();
    let mut variantes = vec![base.clone(), base.replace('\\', "/")];
    if cfg!(windows) {
        variantes.push(format!(r"\\?\{base}"));
    }
    for v in variantes {
        let p = w.desktop("resource_adopt_preview", json!({"project_id": w.project, "path": v})).expect("preview");
        assert_eq!(p["adopt"]["ok"], true, "{v}: {p}");
    }
}

// ---- Segunda revisión adversarial (independiente) ----

/// Cerrar el Run (a mano o por inactividad: es el mismo `free_worktrees`) NUNCA quita un worktree adoptado ni borra su rama, aunque la rama esté subida
/// a su remoto. La carpeta es de la persona y trae sus archivos ignorados. Solo `release`, que es explícito, la libera.
#[test]
fn cerrar_el_run_no_libera_un_worktree_adoptado_ni_borra_su_rama() {
    for force in [false, true] {
        let w = world("claude", None);
        let task = w.adopt_bare_task("adv2-1", "t");
        let repo = w.adopt_repo();
        let remote = repo.parent().unwrap().join("remoto.git");
        git(&repo, &["init", "--bare", "-q", &remote.to_string_lossy()]);
        git(&repo, &["remote", "add", "origin", &remote.to_string_lossy()]);
        let dir = w.adopt_external_worktree("wt-cierre", "feature/cierre");
        git(&dir, &["push", "-q", "-u", "origin", "feature/cierre"]);
        w.adopt_it(&dir, &task).unwrap();
        std::fs::write(dir.join("node_modules.local"), "mis archivos ignorados").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "local"]);

        let closed = w.desktop("run_close", json!({"root_task": task, "force": force})).expect("run_close");
        assert_eq!(closed["released"], json!([]), "force={force}: {closed}");
        assert!(closed["kept"].to_string().contains("adoptado"), "force={force}: {closed}");
        assert!(dir.join("node_modules.local").exists(), "force={force}: la carpeta de la persona sigue ahí");
        assert!(git(&repo, &["branch", "--list", "feature/cierre"]).contains("feature/cierre"), "force={force}: la rama sigue");
    }
}

/// Una Task cuyo Run ya se cerró no se ofrece ni recibe el worktree (antes: ofrecida y luego un error crudo de SQLite).
#[test]
fn una_task_de_un_run_cerrado_no_se_ofrece_ni_se_adopta() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv2-2", "t");
    let dir = w.adopt_external_worktree("wt-run-cerrado", "feature/cerrado");
    w.desktop("run_close", json!({"root_task": task})).expect("cerrar el Run");
    let p = w.adopt_preview(&dir);
    assert_eq!((p["adopt"]["code"].as_str(), p["tasks"].as_array().map(Vec::len)), (Some("adopt_no_task"), Some(0)), "{p}");
    let attempts = w.adopt_attempts_total();
    let e = w.adopt_it(&dir, &task).unwrap_err();
    assert_eq!(code_of(&e), "adopt_task_not_eligible", "{e}");
    assert_eq!(w.adopt_attempts_total(), attempts);
}

/// «Limpio» no depende de la configuración de git de la persona, y de `.lixbon/` solo se ignora lo NO versionado.
#[test]
fn limpio_no_depende_de_la_configuracion_de_git_ni_ignora_lo_versionado_de_lixbon() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv2-3", "t");
    let repo = w.adopt_repo();
    let dir = w.adopt_external_worktree("wt-config", "feature/config");
    git(&repo, &["config", "status.showUntrackedFiles", "no"]);
    std::fs::write(dir.join("nuevo.txt"), "sin seguimiento").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_dirty", "un archivo nuevo cuenta aunque la configuración lo oculte");
    std::fs::remove_file(dir.join("nuevo.txt")).unwrap();
    // Un archivo de `.lixbon/` que la persona comprometió y luego modificó es trabajo suyo.
    std::fs::create_dir_all(dir.join(".lixbon")).unwrap();
    std::fs::write(dir.join(".lixbon").join("cfg"), "v1").unwrap();
    git(&dir, &["add", "-f", "."]);
    git(&dir, &["commit", "-qm", "cfg"]);
    assert_eq!(w.adopt_preview(&dir)["adopt"]["ok"], true);
    std::fs::write(dir.join(".lixbon").join("cfg"), "v2 sin commit").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_dirty");
    assert_eq!(code_of(&w.adopt_it(&dir, &task).unwrap_err()), "adopt_dirty");
}

/// Con una etiqueta `main`, git abrevia la rama como `heads/main`: la base guardada y mostrada es `main`.
#[test]
fn la_base_no_lleva_el_prefijo_heads_cuando_hay_una_etiqueta_homonima() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv2-4", "t");
    git(&w.adopt_repo(), &["tag", "main"]);
    let dir = w.adopt_external_worktree("wt-base", "feature/base");
    assert_eq!(w.adopt_preview(&dir)["base"], "main");
    w.adopt_it(&dir, &task).unwrap();
    let base: String = w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT base_branch FROM worktrees WHERE task_id = ?1", [&task], |r| r.get(0))?))).unwrap().unwrap();
    assert_eq!(base, "main");
}

/// Un worktree bloqueado a propósito (`git worktree lock`) no se adopta: Lixbon no podría liberarlo.
#[test]
fn un_worktree_bloqueado_no_se_adopta() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("adv2-5", "t");
    let dir = w.adopt_external_worktree("wt-bloqueado", "feature/bloqueado");
    git(&w.adopt_repo(), &["worktree", "lock", "--reason", "de otra herramienta", &dir.to_string_lossy()]);
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_locked");
    assert_eq!(code_of(&w.adopt_it(&dir, &task).unwrap_err()), "adopt_locked");
}

/// Una ruta larga o un Project inexistente dan un código `adopt_*`, no un error genérico.
#[test]
fn una_ruta_larga_y_un_project_inexistente_dan_codigos_claros() {
    let w = world("claude", None);
    let larga = format!("{}/{}", w.adopt_repo().to_string_lossy(), "x".repeat(300));
    let p = w.desktop("resource_adopt_preview", json!({"project_id": w.project, "path": larga})).expect("la ruta larga se previsualiza");
    assert_eq!(p["adopt"]["code"], "adopt_not_a_worktree", "{p}");
    let e = w.desktop("resource_adopt_preview", json!({"project_id": "nope", "path": "x"})).unwrap_err();
    assert!(e.contains("adopt_project_unavailable"), "{e}");
}
