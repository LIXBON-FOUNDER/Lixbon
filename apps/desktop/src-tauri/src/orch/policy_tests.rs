//! LXO-209 · Policy efectiva de autonomía. Dos niveles de prueba:
//!
//! * **Puras**: la matriz actor × categoría, la precedencia global → project → attempt, los pisos y las reglas de escritura (`check_write`).
//! * **De extremo a extremo** por `rpc_authenticated_via`, el camino de Desktop/CLI/Mobile: que la policy se REVALIDA al ejecutar (una foto
//!   vieja no autoriza), que un cliente no amplía su alcance afirmando otra superficie, que Mobile no eleva lo que el Core clasifica
//!   `elevated`/`deny`, y que cada cambio deja su Event `policy.changed` sin secretos ni historia reescrita.

use serde_json::{json, Value};

use super::attempt_e2e_tests::{world, World};
use super::events::Channel;
use super::policy::*;
use crate::store::{AuthenticatedClient, ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity, PolicyOverrideRow, PolicySnapshot, PolicyWrite};

// ── Puras ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

fn snap(rows: &[(&str, &str, &str, &str)]) -> PolicySnapshot {
    PolicySnapshot {
        revision: rows.len() as i64,
        rows: rows
            .iter()
            .map(|(k, i, c, l)| PolicyOverrideRow { scope_kind: (*k).into(), scope_id: (*i).into(), category: (*c).into(), level: (*l).into(), set_by: "ana".into(), set_at: 1, revision: 1 })
            .collect(),
    }
}

fn level(s: &PolicySnapshot, actor: ActorClass, cat: Category, project: Option<&str>, attempt: Option<&str>) -> &'static str {
    resolve(s, actor, cat, project, attempt).level.as_str()
}

const DESKTOP_CONFIRM: [Category; 5] = [Category::Start, Category::Review, Category::Integrate, Category::Cleanup, Category::ProviderPermissions];

#[test]
fn la_matriz_base_deja_a_desktop_como_estaba_y_a_los_demas_sin_nada() {
    for c in CATEGORIES {
        let esperado = if DESKTOP_CONFIRM.contains(&c) { Level::Confirm } else { Level::Allow };
        assert_eq!(baseline(ActorClass::DesktopPerson, c), esperado, "{}", c.as_str());
        // Mobile, automatización y agentes: nada de estas categorías (invariante 3: un agente no hereda el alcance humano).
        for a in [ActorClass::MobilePerson, ActorClass::Automation, ActorClass::Agent] {
            assert_eq!(baseline(a, c), Level::Deny, "{} para {}", c.as_str(), a.as_str());
        }
        // El CLI solo puede PEDIR un Attempt; la aprobación sigue siendo de Desktop.
        let cli = if c == Category::Start { Level::Confirm } else { Level::Deny };
        assert_eq!(baseline(ActorClass::CliPerson, c), cli, "{}", c.as_str());
        assert_eq!(baseline(ActorClass::Core, c), Level::Allow);
    }
}

#[test]
fn el_nivel_efectivo_es_el_mas_restrictivo_de_las_capas_y_gana_la_mas_cercana_en_un_empate() {
    let s = snap(&[("global", "", "fork", "confirm"), ("project", "p1", "fork", "elevated"), ("attempt", "t-a1", "fork", "deny")]);
    let d = ActorClass::DesktopPerson;
    assert_eq!(level(&s, d, Category::Fork, None, None), "confirm");
    assert_eq!(level(&s, d, Category::Fork, Some("p1"), None), "elevated");
    assert_eq!(level(&s, d, Category::Fork, Some("p1"), Some("t-a1")), "deny");
    assert_eq!(level(&s, d, Category::Fork, Some("otro"), None), "confirm", "el override de un Project no se filtra a otro");
    assert_eq!(resolve(&s, d, Category::Fork, Some("p1"), Some("t-a1")).source, Source::Attempt);
    assert_eq!(resolve(&s, d, Category::Fork, Some("p1"), None).source, Source::Project);
    assert_eq!(resolve(&s, d, Category::Fork, None, None).source, Source::Global);
    // Empate entre el global y el project: manda el más específico.
    let tie = snap(&[("global", "", "fork", "confirm"), ("project", "p1", "fork", "confirm")]);
    assert_eq!(resolve(&tie, d, Category::Fork, Some("p1"), None).source, Source::Project);
    // Sin overrides: la base.
    assert_eq!(resolve(&snap(&[]), d, Category::Fork, None, None).source, Source::Baseline);
}

#[test]
fn un_override_mas_cercano_nunca_da_mas_permiso_que_el_de_arriba() {
    let s = snap(&[("global", "", "queue", "deny"), ("project", "p1", "queue", "allow")]);
    assert_eq!(level(&s, ActorClass::DesktopPerson, Category::Queue, Some("p1"), None), "deny");
}

#[test]
fn el_piso_de_cada_categoria_no_baja_de_confirm_aunque_la_fila_diga_allow() {
    // Una fila que el CHECK admite pero las reglas no deberían producir: aun así la resolución no baja del piso.
    let s = snap(&[("global", "", "integrate", "allow"), ("global", "", "cleanup", "allow")]);
    for c in [Category::Integrate, Category::Cleanup] {
        assert_eq!(level(&s, ActorClass::DesktopPerson, c, None, None), "confirm", "{}", c.as_str());
    }
    // Para un actor sin nada, el piso no lo "sube" a confirm: sigue en deny.
    assert_eq!(level(&snap(&[]), ActorClass::Agent, Category::Integrate, None, None), "deny");
}

#[test]
fn un_nivel_guardado_que_no_se_entiende_falla_cerrado() {
    let s = snap(&[("global", "", "steer", "root")]);
    assert_eq!(level(&s, ActorClass::DesktopPerson, Category::Steer, None, None), "deny");
}

fn project(id: &str) -> Scope {
    Scope { kind: ScopeKind::Project, id: Some(id.into()), project: None }
}

fn attempt(id: &str, project: &str) -> Scope {
    Scope { kind: ScopeKind::Attempt, id: Some(id.into()), project: Some(project.into()) }
}

fn global() -> Scope {
    Scope { kind: ScopeKind::Global, id: None, project: None }
}

fn rej(r: Result<(WriteCheck, PolicyWrite), Rejection>) -> &'static str {
    r.map(|_| "ok").unwrap_or_else(|e| e.code)
}

#[test]
fn las_reglas_de_escritura_rechazan_bajar_del_piso_y_aflojar_desde_un_ambito_inferior() {
    let s = snap(&[("global", "", "fork", "confirm"), ("project", "p1", "fork", "deny")]);
    // Piso: review/integrate/cleanup/start/provider_permissions nunca en allow.
    for c in DESKTOP_CONFIRM {
        assert_eq!(rej(check_write(&s, &global(), c, Some(Level::Allow))), "policy_below_floor", "{}", c.as_str());
        assert_eq!(rej(check_write(&s, &global(), c, Some(Level::Confirm))), "ok");
    }
    // Un project solo endurece: «allow» o «confirm» con el global en confirm → solo ≥ confirm.
    assert_eq!(rej(check_write(&s, &project("p2"), Category::Fork, Some(Level::Allow))), "policy_cannot_loosen");
    assert_eq!(rej(check_write(&s, &project("p2"), Category::Fork, Some(Level::Confirm))), "ok", "igualar lo de arriba fija el nivel");
    assert_eq!(rej(check_write(&s, &project("p2"), Category::Fork, Some(Level::Deny))), "ok");
    // Un attempt solo endurece respecto a su project.
    assert_eq!(rej(check_write(&s, &attempt("t-a1", "p1"), Category::Fork, Some(Level::Confirm))), "policy_cannot_loosen");
    assert_eq!(rej(check_write(&s, &attempt("t-a1", "p1"), Category::Fork, Some(Level::Deny))), "ok");
}

#[test]
fn aflojar_exige_confirmacion_y_endurecer_no_y_la_direccion_dice_que_paso() {
    let s = snap(&[("global", "", "steer", "deny")]);
    // deny → allow en el global: aflojar.
    let (loosen, _) = check_write(&s, &global(), Category::Steer, Some(Level::Allow)).unwrap();
    assert_eq!((loosen.direction, loosen.needs_confirm, loosen.before, loosen.after), (super::attempt_ops::PolicyDirection::Loosen, true, Level::Deny, Level::Allow));
    // Volver a heredar un deny también afloja (la base es allow): lo dice como reset pero exige confirmar igual.
    let (reset, _) = check_write(&s, &global(), Category::Steer, None).unwrap();
    assert_eq!((reset.direction, reset.needs_confirm), (super::attempt_ops::PolicyDirection::Reset, true));
    // allow → confirm: endurecer.
    let (tight, _) = check_write(&snap(&[]), &global(), Category::Steer, Some(Level::Confirm)).unwrap();
    assert_eq!((tight.direction, tight.needs_confirm), (super::attempt_ops::PolicyDirection::Tighten, false));
    // Fijar el mismo nivel efectivo: Same, sin confirmar.
    let (same, _) = check_write(&snap(&[]), &global(), Category::Steer, Some(Level::Allow)).unwrap();
    assert_eq!((same.direction, same.needs_confirm), (super::attempt_ops::PolicyDirection::Same, false));
}

// ── De extremo a extremo ────────────────────────────────────────────────────────────────────────────────────────────────────────

fn client(w: &World, surface: ClientSurface, principal: ClientPrincipal, tag: &str) -> AuthenticatedClient {
    let registration = ClientRegistration::new(surface, DeviceIdentity::new(format!("install-policy-{tag}"), None).unwrap()).unwrap();
    let credential = ClientCredential::new(principal, format!("policy-secret-{tag}-padding-to-32-bytes-or-more")).unwrap();
    w.core.storage.with_store(|s| s.register_client(&registration, &credential, 100)).expect("almacén abierto").expect("alta del cliente")
}

fn as_client(w: &World, c: &AuthenticatedClient, cmd: &str, args: Value) -> Result<Value, String> {
    w.core.rpc_authenticated_via(c, &ClientClaims::default(), channel_of(c), "", cmd, &args)
}

/// El transporte fija el canal: Desktop entra por la interfaz y el resto por el servidor local.
fn channel_of(c: &AuthenticatedClient) -> Channel {
    if c.identity().surface() == ClientSurface::Desktop { Channel::Ui } else { Channel::Lxo }
}

impl World {
    fn eff(&self) -> Value {
        self.desktop("policy_effective", json!({})).expect("policy_effective")
    }

    fn set(&self, kind: &str, id: Option<&str>, category: &str, level: &str, confirm: bool) -> Result<Value, String> {
        let rev = self.eff()["revision"].as_i64().unwrap();
        self.desktop("policy_set", json!({"scope": {"kind": kind, "id": id}, "category": category, "level": level, "expected_revision": rev, "confirm": confirm}))
    }

    fn unset(&self, kind: &str, id: Option<&str>, category: &str, confirm: bool) -> Result<Value, String> {
        let rev = self.eff()["revision"].as_i64().unwrap();
        self.desktop("policy_reset", json!({"scope": {"kind": kind, "id": id}, "category": category, "expected_revision": rev, "confirm": confirm}))
    }
}

fn cat<'a>(eff: &'a Value, category: &str) -> &'a Value {
    eff["categories"].as_array().unwrap().iter().find(|c| c["category"] == category).unwrap()
}

fn steer(w: &World, attempt: &str, confirm: bool) -> Result<Value, String> {
    w.desktop("attempt_steer", json!({"attempt_id": attempt, "request_id": "r-steer", "body": "otra cosa", "confirm": confirm}))
}

/// El Command pasó la policy: si falla, es por otra razón (el Attempt no corre), nunca con un código `policy_`.
fn paso_la_policy(r: &Result<Value, String>) -> bool {
    !matches!(r, Err(e) if e.starts_with("policy_"))
}

fn is(r: Result<Value, String>, code: &str) -> bool {
    matches!(&r, Err(e) if e.starts_with(code))
}

fn policy_events(w: &World) -> Vec<(Value, String, Option<String>, Option<String>)> {
    w.core
        .storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload, actor_kind, actor_id, channel FROM events WHERE kind = 'policy.changed' ORDER BY seq")?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().map(|(p, k, a, c)| (serde_json::from_str(&p).unwrap(), k, a, c)).collect())
            })
        })
        .unwrap()
        .unwrap()
}

#[test]
fn policy_effective_trae_la_matriz_los_diez_niveles_y_el_origen_de_cada_uno() {
    let w = world("claude", None);
    let e = w.eff();
    assert_eq!(e["v"], 1);
    assert_eq!(e["revision"], 0);
    assert_eq!(e["actor"], json!({"class": "desktop_person", "can_edit": true}));
    assert_eq!(e["categories"].as_array().unwrap().len(), 10);
    assert_eq!(e["levels"], json!(["allow", "confirm", "elevated", "deny"]));
    let steer = cat(&e, "steer");
    assert_eq!((steer["level"].as_str(), steer["source"].as_str(), steer["reason"].as_str(), steer["enforced"].as_bool()), (Some("allow"), Some("baseline"), Some("baseline_default"), Some(true)));
    let integrate = cat(&e, "integrate");
    assert_eq!((integrate["level"].as_str(), integrate["floor"].as_str()), (Some("confirm"), Some("confirm")));
    // Desde LXO-247 `attempt_answer` gobierna `answer` y `provider_permissions`: las diez categorías tienen punto de aplicación.
    assert_eq!(cat(&e, "answer")["enforced"], true);
    assert_eq!(cat(&e, "provider_permissions")["enforced"], true);
    // La matriz actor × categoría viaja completa.
    assert_eq!(e["baseline_matrix"]["mobile_person"]["steer"], "deny");
    assert_eq!(e["baseline_matrix"]["cli_person"]["start"], "confirm");
    assert_eq!(e["baseline_matrix"]["desktop_person"]["queue"], "allow");
}

#[test]
fn una_foto_vieja_de_la_interfaz_no_autoriza_nada_la_policy_se_revalida_al_ejecutar() {
    let w = world("claude", None);
    let foto = w.eff();
    assert_eq!(cat(&foto, "steer")["level"], "allow");
    // Entre que la interfaz leyó y el clic, alguien endurece la policy.
    assert_eq!(w.set("global", None, "steer", "deny", false).unwrap()["status"], "Changed");
    assert!(is(steer(&w, "nope-a1", true), "policy_denied"), "ni confirm: true salta un deny");
    // Aflojar de nuevo exige confirmación; sin ella no cambia nada.
    assert!(is(w.unset("global", None, "steer", false), "policy_confirm_required"));
    assert!(is(steer(&w, "nope-a1", false), "policy_denied"));
    assert_eq!(w.unset("global", None, "steer", true).unwrap()["status"], "Changed");
    assert!(paso_la_policy(&steer(&w, "nope-a1", false)));
}

#[test]
fn confirm_exige_confirm_true_y_elevated_no_se_puede_dar_aun() {
    let w = world("claude", None);
    w.set("global", None, "queue", "confirm", false).unwrap();
    let q = |confirm: bool| w.desktop("attempt_queue", json!({"attempt_id": "nope-a1", "request_id": "r-q", "body": "luego", "confirm": confirm}));
    assert!(is(q(false), "policy_confirm_required"));
    assert!(paso_la_policy(&q(true)));
    w.set("global", None, "queue", "elevated", false).unwrap();
    assert!(is(q(true), "policy_out_of_band_required"), "elevated pide una confirmación fuera de banda que no existe: confirm no basta");
}

#[test]
fn los_overrides_de_project_y_de_attempt_endurecen_solo_su_ambito_y_dicen_su_origen() {
    let w = world("claude", None);
    let a1 = w.create("claude", "r-a1");
    let fork = |confirm: bool| w.desktop("attempt_fork", json!({"request_id": "r-f", "source_attempt_id": a1, "confirm": confirm}));
    w.set("project", Some(&w.project), "fork", "deny", false).unwrap();
    assert!(is(fork(true), "policy_denied"));
    let e = w.desktop("policy_effective", json!({"project_id": w.project})).unwrap();
    assert_eq!((cat(&e, "fork")["level"].as_str(), cat(&e, "fork")["source"].as_str(), cat(&e, "fork")["reason"].as_str()), (Some("deny"), Some("project"), Some("override_project")));
    assert_eq!(cat(&w.eff(), "fork")["level"], "allow", "sin Project en la consulta solo cuenta el global");
    w.unset("project", Some(&w.project), "fork", true).unwrap();
    assert!(paso_la_policy(&fork(true)));
    // El mismo cambio, ahora solo para ese Attempt.
    w.set("attempt", Some(&a1), "steer", "deny", false).unwrap();
    assert!(is(steer(&w, &a1, true), "policy_denied"));
    let e = w.desktop("policy_effective", json!({"attempt_id": a1})).unwrap();
    assert_eq!((cat(&e, "steer")["source"].as_str(), e["scope"]["project_id"].as_str()), (Some("attempt"), Some(w.project.as_str())));
    assert!(paso_la_policy(&steer(&w, "otro-a1", true)), "otro Attempt no lo hereda");
}

#[test]
fn las_reglas_de_escritura_tambien_valen_por_el_comando() {
    let w = world("claude", None);
    let a1 = w.create("claude", "r-a1");
    assert!(is(w.set("global", None, "integrate", "allow", true), "policy_below_floor"));
    w.set("global", None, "fork", "confirm", false).unwrap();
    assert!(is(w.set("project", Some(&w.project), "fork", "allow", true), "policy_cannot_loosen"));
    assert!(is(w.set("project", Some("p-inventado"), "fork", "deny", false), "policy_not_found"));
    assert!(is(w.set("attempt", Some("nope-a9"), "fork", "deny", false), "policy_not_found"));
    assert!(is(w.set("global", Some("x"), "fork", "deny", false), "policy_invalid_request"));
    assert!(is(w.set("global", None, "inventada", "deny", false), "policy_invalid_request"));
    assert!(is(w.set("global", None, "fork", "root", false), "policy_invalid_request"));
    assert!(is(w.set("team", Some("t"), "fork", "deny", false), "policy_invalid_request"));
    assert!(is(w.desktop("policy_reset", json!({"scope": {"kind": "global"}, "category": "fork", "level": "deny", "expected_revision": 1})), "policy_invalid_request"));
    // Nada de lo rechazado dejó rastro: una sola revisión (la del fork global) y un solo Event.
    assert_eq!(w.eff()["revision"], 1);
    assert_eq!(policy_events(&w).len(), 1);
    let _ = a1;
}

#[test]
fn una_revision_vieja_es_stale_y_no_pisa_lo_que_otro_cambio() {
    let w = world("claude", None);
    let leida = w.eff()["revision"].as_i64().unwrap();
    w.set("global", None, "stop", "confirm", false).unwrap();
    let r = w.desktop("policy_set", json!({"scope": {"kind": "global"}, "category": "steer", "level": "deny", "expected_revision": leida}));
    assert!(is(r, "policy_stale"));
    assert_eq!(cat(&w.eff(), "steer")["level"], "allow", "el cambio viejo no se aplicó");
}

#[test]
fn cada_cambio_deja_su_event_sin_secretos_y_repetir_o_borrar_no_reescribe_la_historia() {
    let w = world("claude", None);
    w.set("global", None, "steer", "confirm", false).unwrap();
    assert_eq!(w.set("global", None, "steer", "confirm", false).unwrap()["status"], "Unchanged");
    w.set("project", Some(&w.project), "steer", "deny", false).unwrap();
    w.unset("project", Some(&w.project), "steer", true).unwrap();
    let ev = policy_events(&w);
    assert_eq!(ev.len(), 3, "repetir lo mismo no deja otro hecho; borrar tampoco borra los anteriores");
    let (p0, kind, actor, channel) = &ev[0];
    assert_eq!((p0["scope"].as_str(), p0["category"].as_str(), p0["to"].as_str(), p0["direction"].as_str(), p0["revision"].as_i64()), (Some("global"), Some("steer"), Some("confirm"), Some("tighten"), Some(1)));
    assert!(p0.get("from").is_none() && p0.get("scope_id").is_none());
    assert_eq!((kind.as_str(), actor.is_some(), channel.as_deref()), ("person", true, Some("ui")));
    assert_eq!((ev[1].0["scope"].as_str(), ev[1].0["scope_id"].as_str(), ev[1].0["to"].as_str()), (Some("project"), Some(w.project.as_str()), Some("deny")));
    assert_eq!((ev[2].0["direction"].as_str(), ev[2].0["from"].as_str()), (Some("reset"), Some("deny")));
    assert!(ev[2].0.get("to").is_none());
    // Solo ámbito, categoría, niveles, dirección y revisión: ni credenciales ni rutas ni texto libre.
    let mut keys: Vec<&str> = ev[1].0.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["category", "direction", "revision", "scope", "scope_id", "to"]);
}

#[test]
fn solo_una_person_de_desktop_edita_y_un_cliente_no_amplia_su_alcance_afirmando_otra_superficie() {
    let w = world("claude", None);
    let cli = client(&w, ClientSurface::Cli, ClientPrincipal::Person("user".into()), "cli");
    let mobile = client(&w, ClientSurface::Mobile, ClientPrincipal::Person("user".into()), "mobile");
    let agent = client(&w, ClientSurface::Cli, ClientPrincipal::Agent("task-x".into()), "agent");
    let change = json!({"scope": {"kind": "global"}, "category": "steer", "level": "deny", "expected_revision": 0});
    for (who, c) in [("cli", &cli), ("mobile", &mobile), ("agent", &agent)] {
        assert!(as_client(&w, c, "policy_set", change.clone()).is_err(), "{who} no cambia la policy");
        assert!(as_client(&w, c, "policy_reset", change.clone()).is_err(), "{who} no cambia la policy");
    }
    // Afirmar otra superficie o principal en los claims no cambia quién es: el Core compara con la credencial autenticada.
    for claims in [
        ClientClaims { surface: Some(ClientSurface::Desktop), ..ClientClaims::default() },
        ClientClaims { principal: Some(ClientPrincipal::Person("user".into())), surface: Some(ClientSurface::Desktop), ..ClientClaims::default() },
    ] {
        let r = w.core.rpc_authenticated_via(&mobile, &claims, channel_of(&mobile), "", "policy_set", &change);
        assert!(r.is_err(), "un claim de Desktop no convierte a Mobile en Desktop");
        let r = w.core.rpc_authenticated_via(&cli, &claims, channel_of(&cli), "", "policy_set", &change);
        assert!(r.is_err());
    }
    assert_eq!(w.eff()["revision"], 0, "nada se escribió");
    assert!(policy_events(&w).is_empty());
}

#[test]
fn cada_actor_ve_su_propia_policy_y_mobile_no_eleva_lo_que_el_core_niega() {
    let w = world("claude", None);
    let mobile = client(&w, ClientSurface::Mobile, ClientPrincipal::Person("user".into()), "mobile2");
    let cli = client(&w, ClientSurface::Cli, ClientPrincipal::Person("user".into()), "cli2");
    // Mobile aún no tiene transporte en el Core (`Channel` solo conoce Ui, Lxo y Core): ningún canal lo autentica, ni siquiera para leer.
    for channel in [Channel::Ui, Channel::Lxo] {
        assert!(w.core.rpc_authenticated_via(&mobile, &ClientClaims::default(), channel, "", "policy_effective", &json!({})).is_err());
    }
    let c = as_client(&w, &cli, "policy_effective", json!({})).unwrap();
    assert_eq!((c["actor"]["class"].as_str(), cat(&c, "start")["level"].as_str(), cat(&c, "steer")["level"].as_str()), (Some("cli_person"), Some("confirm"), Some("deny")));
    // Desktop afloja todo lo que puede; Mobile y CLI siguen sin poder: ni la policy ni `confirm` les dan lo que su base niega.
    w.set("global", None, "steer", "elevated", false).unwrap();
    let args = json!({"attempt_id": "nope-a1", "request_id": "r-m", "body": "x", "confirm": true});
    for channel in [Channel::Ui, Channel::Lxo] {
        assert!(w.core.rpc_authenticated_via(&mobile, &ClientClaims::default(), channel, "", "attempt_steer", &args).is_err());
    }
    assert!(as_client(&w, &cli, "attempt_steer", args).is_err());
    assert!(is(steer(&w, "nope-a1", true), "policy_out_of_band_required"));
}

#[test]
fn el_cli_puede_pedir_un_attempt_y_sigue_pendiente_de_la_aprobacion_de_desktop() {
    let w = world("claude", None);
    let cli = client(&w, ClientSurface::Cli, ClientPrincipal::Person("user".into()), "cli3");
    let created = as_client(&w, &cli, "task_create", json!({"request_id": "r-cli", "project_id": w.project, "objective": "o", "title": "t", "spec": "s", "attempt": {"provider": "claude", "profile": "explorar"}})).unwrap();
    assert_eq!(created["status"], "Committed");
    // La policy de `start` en deny para todos lo corta, también para el CLI.
    w.set("global", None, "start", "deny", false).unwrap();
    let r = as_client(&w, &cli, "task_create", json!({"request_id": "r-cli2", "project_id": w.project, "objective": "o", "title": "t2", "spec": "s", "attempt": {"provider": "claude", "profile": "explorar"}}));
    assert!(is(r, "policy_denied"));
    // Una Task sin Attempt no ejecuta nada: la policy de `start` no la toca.
    let r = as_client(&w, &cli, "task_create", json!({"request_id": "r-cli3", "project_id": w.project, "objective": "o", "title": "t3", "spec": "s"}));
    assert!(paso_la_policy(&r), "{r:?}");
}

#[test]
fn con_el_core_en_solo_lectura_no_se_cambia_la_policy_pero_se_sigue_leyendo() {
    let w = world("claude", None);
    w.core.degrade_for_tests("disco lleno");
    let rev = w.eff()["revision"].as_i64().unwrap();
    assert!(is(w.desktop("policy_set", json!({"scope": {"kind": "global"}, "category": "steer", "level": "deny", "expected_revision": rev})), "policy_unavailable"));
    assert!(policy_events(&w).is_empty());
}

#[test]
fn los_commands_que_no_ejecutan_nada_o_deshacen_no_pasan_por_la_policy() {
    for (cmd, args) in [
        ("attempt_queue_cancel", json!({"queue_id": "t-a1-q1"})),
        ("pending_queue", json!({"attempt_id": "t-a1"})),
        ("attempt_approve", json!({"attempt_id": "t-a1"})),
        ("task_create", json!({"request_id": "r"})),
        ("policy_effective", json!({})),
        ("status", json!({})),
    ] {
        assert!(classify_for_tests(cmd, &args).is_none(), "{cmd} no se gobierna por categoría");
    }
    for (cmd, categoria) in [
        ("attempt_queue", "queue"),
        ("attempt_steer", "steer"),
        ("attempt_stop_and_send", "stop"),
        ("attempt_fork", "fork"),
        ("task_race", "fork"),
        ("task_race_cancel", "stop"),
        ("attempt_review", "review"),
        ("attempt_integrate", "integrate"),
        ("resource_clean", "cleanup"),
        ("resource_delete_worktree", "cleanup"),
        ("attempt_retry", "start"),
        ("attempt_resume", "start"),
    ] {
        assert_eq!(classify_for_tests(cmd, &json!({"attempt_id": "t-a1"})), Some(categoria), "{cmd}");
    }
    assert_eq!(classify_for_tests("task_create", &json!({"attempt": {"provider": "claude"}})), Some("start"));
    assert_eq!(classify_for_tests("task_create", &json!({"attempt": null})), None);
}

#[test]
fn un_cambio_de_policy_aparece_en_activity_con_sus_argumentos_y_sin_secretos() {
    let w = world("claude", None);
    w.set("global", None, "steer", "confirm", false).unwrap();
    let page = w.desktop("activity_list", json!({})).unwrap();
    let item = page["items"].as_array().unwrap().iter().find(|i| i["message_key"] == "activity.policy.changed").expect("el cambio está en Activity");
    assert_eq!(item["args"], json!({"scope": "global", "category": "steer", "to": "confirm", "direction": "tighten", "revision": 1}));
}
