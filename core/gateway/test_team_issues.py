"""Prueba de las issues propias de Lixbon Team.

Defiende lo que hace que un gestor de issues sea de fiar: números que no se
repiten, autorización por equipo, referencias que no cruzan equipos, eventos en
vivo a todo el equipo, automatismos de rama y PR, y ciclos que se llevan lo
pendiente. Mismo montaje que `test_team_contract.py`: SQLite temporal fijado
antes de importar la configuración.
"""
import os
import pathlib
import shutil
import tempfile
from datetime import date, timedelta

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_issues_"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_DB_DIR / 'issues.db').as_posix()}")
os.environ.setdefault("TEAM_URL_SECRET", "secreto-de-prueba")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan, TeamCiclo, TeamIssue  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        if not s.get(Plan, "free"):
            s.add(Plan(id="free", name="Gratuito", description="", price_monthly_cents=0,
                       currency="USD", messages_per_day=30, tokens_per_month=150000,
                       max_api_keys=1, rate_limit_per_min=1000, allowed_models=None,
                       priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    yield
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def cliente(_esquema):
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        yield c


def _alta(correo: str) -> dict:
    u = q.create_user(correo, "contraseña-larga", correo.split("@")[0].title(), "Prueba")
    q.set_user_plan(u["id"], "free")
    llave, _ = q.create_api_key("lixbon Desktop", u["id"])
    return {"id": u["id"], "h": {"Authorization": f"Bearer {llave}"}, "llave": llave}


@pytest.fixture(scope="module")
def gente(_esquema):
    return {n: _alta(f"{n}.issues@lixbon.test") for n in ("lia", "mateo", "nora")}


@pytest.fixture(scope="module")
def equipo(cliente, gente):
    """Lía crea «Lixbon Desktop» con el paso Issues del asistente y mete a Mateo.
    Nora no es del equipo."""
    r = cliente.post("/api/team/projects", headers=gente["lia"]["h"], json={
        "nombre": "Lixbon Desktop",
        "issues": {"prefijo": "lxb", "etiquetas": ["Bug", "Desktop"],
                   "config": {"ciclos": {"activos": True, "semanas": 2, "dia_inicio": 2},
                              "estimacion": "fib"}},
    })
    assert r.status_code == 201, r.text
    p = r.json()
    r = cliente.post(f"/api/team/projects/{p['id']}/members",
                     json={"identificador": "mateo.issues@lixbon.test"}, headers=gente["lia"]["h"])
    assert r.status_code == 201
    t = p["tablero"]
    return {
        "id": p["id"], "tablero": t,
        "estado": {e["tipo"]: e["id"] for e in t["estados"]},
        "etiqueta": {e["nombre"]: e["id"] for e in t["etiquetas"]},
    }


def test_el_equipo_nace_con_su_tablero(equipo):
    t = equipo["tablero"]
    assert t["prefijo"] == "LXB"
    assert [e["tipo"] for e in t["estados"]] == [
        "backlog", "pendiente", "en_curso", "revision", "hecho", "cancelado"]
    assert set(equipo["etiqueta"]) == {"Bug", "Desktop"}
    assert t["config"]["ciclos"] == {"activos": True, "semanas": 2, "dia_inicio": 2}
    # Con ciclos activos existen el de hoy y el siguiente.
    hoy = date.today().isoformat()
    assert any(c["empieza"] <= hoy <= c["termina"] for c in t["ciclos"])
    assert len(t["ciclos"]) >= 2
    assert date.fromisoformat(t["ciclos"][0]["empieza"]).weekday() == 2


def test_un_prefijo_invalido_no_crea_el_equipo(cliente, gente):
    r = cliente.post("/api/team/projects", headers=gente["nora"]["h"],
                     json={"nombre": "Roto", "issues": {"prefijo": "1-malo"}})
    assert r.status_code == 422
    boot = cliente.get("/api/team/bootstrap", headers=gente["nora"]["h"]).json()
    assert not any(p["nombre"] == "Roto" for p in boot["proyectos"])


def test_numeros_consecutivos_y_estado_inicial(cliente, gente, equipo):
    r1 = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=gente["lia"]["h"],
                      json={"titulo": "Compilar la versión de macOS", "prioridad": 4,
                            "etiquetas": [equipo["etiqueta"]["Desktop"]]})
    r2 = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=gente["mateo"]["h"],
                      json={"titulo": "Llavero de macOS"})
    assert r1.status_code == r2.status_code == 201
    a, b = r1.json(), r2.json()
    assert (a["clave"], b["clave"]) == ("LXB-1", "LXB-2")
    # Nace en el primer estado «pendiente», no en el backlog.
    assert a["estado_id"] == equipo["estado"]["pendiente"]
    assert a["etiquetas"] == [equipo["etiqueta"]["Desktop"]]


def test_quien_no_es_del_equipo_no_ve_ni_toca(cliente, gente, equipo):
    assert cliente.get(f"/api/team/projects/{equipo['id']}/issues",
                       headers=gente["nora"]["h"]).status_code == 404
    iid = cliente.get(f"/api/team/projects/{equipo['id']}/issues", headers=gente["lia"]["h"]).json()[0]["id"]
    assert cliente.get(f"/api/team/issues/{iid}", headers=gente["nora"]["h"]).status_code == 404
    assert cliente.patch(f"/api/team/issues/{iid}", json={"titulo": "mío"},
                         headers=gente["nora"]["h"]).status_code == 404


def test_las_referencias_no_cruzan_equipos(cliente, gente, equipo):
    otro = cliente.post("/api/team/projects", json={"nombre": "Otro"}, headers=gente["lia"]["h"]).json()
    ajena = otro["tablero"]["etiquetas"][0]["id"]
    iid = cliente.get(f"/api/team/projects/{equipo['id']}/issues", headers=gente["lia"]["h"]).json()[0]["id"]
    r = cliente.patch(f"/api/team/issues/{iid}", json={"etiquetas": [ajena]}, headers=gente["lia"]["h"])
    assert r.status_code == 422
    r = cliente.patch(f"/api/team/issues/{iid}", json={"asignado_id": gente["nora"]["id"]},
                      headers=gente["lia"]["h"])
    assert r.status_code == 422
    r = cliente.patch(f"/api/team/issues/{iid}", json={"estado_id": otro["tablero"]["estados"][0]["id"]},
                      headers=gente["lia"]["h"])
    assert r.status_code == 422


def test_cambios_con_actividad_y_evento_en_vivo(cliente, gente, equipo):
    iid = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=gente["lia"]["h"],
                       json={"titulo": "Barra de título nativa"}).json()["id"]
    with cliente.websocket_connect(f"/ws/team?token={gente['mateo']['llave']}") as ws:
        r = cliente.patch(f"/api/team/issues/{iid}", headers=gente["lia"]["h"], json={
            "estado_id": equipo["estado"]["hecho"], "asignado_id": gente["mateo"]["id"], "prioridad": 3})
        assert r.status_code == 200
        assert r.json()["cerrado_en"]
        for _ in range(10):
            ev = ws.receive_json()
            if ev.get("tipo") == "issue":
                break
        assert ev["accion"] == "guardada" and ev["issue"]["id"] == iid
        assert ev["issue"]["asignado_id"] == gente["mateo"]["id"]
    d = cliente.get(f"/api/team/issues/{iid}", headers=gente["mateo"]["h"]).json()
    campos = [a["campo"] for a in d["actividad"]]
    assert "creada" in campos and "estado_id" in campos and "asignado_id" in campos
    # Reabrir quita la marca de cerrada.
    r = cliente.patch(f"/api/team/issues/{iid}", headers=gente["lia"]["h"],
                      json={"estado_id": equipo["estado"]["en_curso"]})
    assert r.json()["cerrado_en"] is None


def test_subtareas_y_comentarios_cuentan(cliente, gente, equipo):
    h = gente["lia"]["h"]
    padre = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h,
                         json={"titulo": "Build de macOS"}).json()
    for n, cerrada in ((1, True), (2, False)):
        hija = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h,
                            json={"titulo": f"Paso {n}", "padre_id": padre["id"]}).json()
        if cerrada:
            cliente.patch(f"/api/team/issues/{hija['id']}", headers=h,
                          json={"estado_id": equipo["estado"]["hecho"]})
    c = cliente.post(f"/api/team/issues/{padre['id']}/comments", headers=gente["mateo"]["h"],
                     json={"texto": "¿Universal o dos builds?"})
    assert c.status_code == 201
    inf = cliente.post(f"/api/team/issues/{padre['id']}/comments", headers=h,
                       json={"texto": "Informe del agente", "de_agente": "implementador"})
    assert inf.json()["de_agente"] == "implementador"
    d = cliente.get(f"/api/team/issues/{padre['id']}", headers=h).json()
    assert d["subtareas"] == {"total": 2, "hechas": 1}
    assert d["comentarios"] == 2 and len(d["subtareas_lista"]) == 2
    # Solo quien escribió borra su comentario.
    assert cliente.delete(f"/api/team/issue-comments/{c.json()['id']}", headers=h).status_code == 403
    assert cliente.delete(f"/api/team/issue-comments/{c.json()['id']}",
                          headers=gente["mateo"]["h"]).status_code == 204


def test_rama_y_pr_mueven_la_issue_solo_hacia_delante(cliente, gente, equipo):
    h = gente["lia"]["h"]
    iid = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h,
                       json={"titulo": "Notarizar"}).json()["id"]
    r = cliente.post(f"/api/team/issues/{iid}/links", headers=h, json={"tipo": "rama", "ref": "lx/lxb-9"})
    assert r.json()["estado_id"] == equipo["estado"]["en_curso"] and r.json()["rama"] == "lx/lxb-9"
    r = cliente.post(f"/api/team/issues/{iid}/links", headers=h,
                     json={"tipo": "pr", "ref": "#4", "estado": "abierto",
                           "url": "https://github.com/x/y/pull/4"})
    assert r.json()["estado_id"] == equipo["estado"]["revision"]
    # Otra rama después no la devuelve a «en curso».
    r = cliente.post(f"/api/team/issues/{iid}/links", headers=h, json={"tipo": "rama", "ref": "lx/otra"})
    assert r.json()["estado_id"] == equipo["estado"]["revision"]
    r = cliente.post(f"/api/team/issues/{iid}/links", headers=h,
                     json={"tipo": "pr", "ref": "#4", "estado": "fusionado"})
    assert r.json()["estado_id"] == equipo["estado"]["hecho"] and r.json()["cerrado_en"]
    assert r.json()["pr"]["estado"] == "fusionado" and r.json()["vinculos"] == 3


def test_buscar_por_clave(cliente, gente, equipo):
    r = cliente.get("/api/team/issues/buscar?clave=lxb-1", headers=gente["mateo"]["h"])
    assert r.status_code == 200 and r.json()["clave"] == "LXB-1"
    assert cliente.get("/api/team/issues/buscar?clave=LXB-1",
                       headers=gente["nora"]["h"]).status_code == 404


def test_borrar_deja_lapida_y_no_reusa_el_numero(cliente, gente, equipo):
    h = gente["lia"]["h"]
    i = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h, json={"titulo": "Tirar"}).json()
    assert cliente.delete(f"/api/team/issues/{i['id']}", headers=h).status_code == 204
    lista = cliente.get(f"/api/team/projects/{equipo['id']}/issues", headers=h).json()
    assert i["id"] not in {x["id"] for x in lista}
    otra = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h, json={"titulo": "Nueva"}).json()
    assert otra["numero"] == i["numero"] + 1


def test_ajustes_y_estados_solo_el_lider(cliente, gente, equipo):
    pid = equipo["id"]
    assert cliente.patch(f"/api/team/projects/{pid}/issue-settings", json={"prefijo": "DSK"},
                         headers=gente["mateo"]["h"]).status_code == 403
    r = cliente.patch(f"/api/team/projects/{pid}/issue-settings", headers=gente["lia"]["h"],
                      json={"automatismos": {"rama": False}, "estimacion": "tallas"})
    assert r.status_code == 200
    assert r.json()["config"]["automatismos"]["rama"] is False
    assert r.json()["config"]["estimacion"] == "tallas"
    # Un estado con issues no se borra sin decir adónde van.
    revision = equipo["estado"]["revision"]
    cliente.post(f"/api/team/projects/{pid}/issues", headers=gente["lia"]["h"],
                 json={"titulo": "En revisión", "estado_id": revision})
    assert cliente.delete(f"/api/team/states/{revision}", headers=gente["lia"]["h"]).status_code == 409
    r = cliente.delete(f"/api/team/states/{revision}?mover_a={equipo['estado']['en_curso']}",
                       headers=gente["lia"]["h"])
    assert r.status_code == 204
    # Cualquiera crea etiquetas; solo el líder las borra.
    e = cliente.post(f"/api/team/projects/{pid}/labels", json={"nombre": "Gateway", "color": "#8EC5FF"},
                     headers=gente["mateo"]["h"])
    assert e.status_code == 201
    assert cliente.delete(f"/api/team/labels/{e.json()['id']}", headers=gente["mateo"]["h"]).status_code == 403


def test_iniciativas(cliente, gente, equipo):
    h = gente["mateo"]["h"]
    x = cliente.post(f"/api/team/projects/{equipo['id']}/initiatives", headers=h,
                     json={"nombre": "Build de macOS", "responsable_id": gente["lia"]["id"],
                           "objetivo": "2026-10-20", "estado": "en_riesgo"})
    assert x.status_code == 201
    i = cliente.post(f"/api/team/projects/{equipo['id']}/issues", headers=h,
                     json={"titulo": "Runner", "iniciativa_id": x.json()["id"]}).json()
    assert i["iniciativa_id"] == x.json()["id"]
    assert cliente.post(f"/api/team/projects/{equipo['id']}/initiatives", headers=h,
                        json={"nombre": "Mala", "responsable_id": gente["nora"]["id"]}).status_code == 422


def test_lo_pendiente_de_un_ciclo_cerrado_pasa_al_de_hoy(cliente, gente, equipo):
    h = gente["lia"]["h"]
    pid = equipo["id"]
    i = cliente.post(f"/api/team/projects/{pid}/issues", headers=h, json={"titulo": "Arrastrada"}).json()
    viejo = "ci_viejo_prueba"
    with get_session() as s:
        s.add(TeamCiclo(id=viejo, proyecto_id=pid, numero=0,
                        empieza=(date.today() - timedelta(days=40)).isoformat(),
                        termina=(date.today() - timedelta(days=27)).isoformat()))
        s.flush()
        s.get(TeamIssue, i["id"]).ciclo_id = viejo
    lista = cliente.get(f"/api/team/projects/{pid}/issues", headers=h).json()
    movida = next(x for x in lista if x["id"] == i["id"])
    hoy = date.today().isoformat()
    tablero = cliente.get("/api/team/bootstrap", headers=h).json()
    ciclos = next(p for p in tablero["proyectos"] if p["id"] == pid)["tablero"]["ciclos"]
    actual = next(c for c in ciclos if c["empieza"] <= hoy <= c["termina"])
    assert movida["ciclo_id"] == actual["id"]


def _firmado(secreto: str, datos: dict) -> tuple[bytes, dict]:
    import hashlib
    import hmac
    import json
    cuerpo = json.dumps(datos).encode()
    firma = "sha256=" + hmac.new(secreto.encode(), cuerpo, hashlib.sha256).hexdigest()
    return cuerpo, {"X-Hub-Signature-256": firma, "Content-Type": "application/json"}


def test_webhook_de_github_liga_y_mueve(cliente, gente, equipo):
    pid = equipo["id"]
    assert cliente.get(f"/api/team/projects/{pid}/github-webhook", headers=gente["mateo"]["h"]).status_code == 403
    w = cliente.get(f"/api/team/projects/{pid}/github-webhook", headers=gente["lia"]["h"]).json()
    assert w["url"].endswith(f"/api/team/github/webhook/{pid}") and len(w["secreto"]) >= 32
    cliente.patch(f"/api/team/projects/{pid}/issue-settings", headers=gente["lia"]["h"],
                  json={"automatismos": {"rama": True, "pr": True}})
    # Una prueba anterior borró «En revisión»: el flujo del PR la necesita.
    cliente.post(f"/api/team/projects/{pid}/states", headers=gente["lia"]["h"],
                 json={"nombre": "En revisión", "tipo": "revision"})
    i = cliente.post(f"/api/team/projects/{pid}/issues", headers=gente["lia"]["h"], json={"titulo": "Webhook"}).json()
    rama = f"lx/lxb-{i['numero']}-webhook"

    # Sin firma buena, nada.
    cuerpo, cab = _firmado("otro", {"ref": rama, "ref_type": "branch"})
    assert cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo,
                        headers={**cab, "X-GitHub-Event": "create"}).status_code == 401

    cuerpo, cab = _firmado(w["secreto"], {"ref": rama, "ref_type": "branch"})
    r = cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo, headers={**cab, "X-GitHub-Event": "create"})
    assert r.status_code == 200 and r.json()["issues"] == 1
    d = cliente.get(f"/api/team/issues/{i['id']}", headers=gente["lia"]["h"]).json()
    assert d["rama"] == rama and d["estado"]["tipo"] == "en_curso"
    assert {e["tipo"] for e in d["estados"]} >= {"en_curso", "hecho"}

    pr = {"action": "opened", "pull_request": {"number": 7, "title": f"Webhook ({i['clave']})", "body": "",
                                                "html_url": "https://github.com/x/y/pull/7", "merged": False,
                                                "head": {"ref": rama}}}
    cuerpo, cab = _firmado(w["secreto"], pr)
    cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo, headers={**cab, "X-GitHub-Event": "pull_request"})
    assert cliente.get(f"/api/team/issues/{i['id']}", headers=gente["lia"]["h"]).json()["estado"]["tipo"] == "revision"

    pr["action"] = "closed"
    pr["pull_request"]["merged"] = True
    cuerpo, cab = _firmado(w["secreto"], pr)
    cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo, headers={**cab, "X-GitHub-Event": "pull_request"})
    d = cliente.get(f"/api/team/issues/{i['id']}", headers=gente["lia"]["h"]).json()
    assert d["estado"]["tipo"] == "hecho" and d["pr"] == {"ref": "#7", "estado": "fusionado", "url": "https://github.com/x/y/pull/7"}

    push = {"commits": [{"id": "abcdef1234567", "message": f"fix: algo ({i['clave']})", "url": "https://github.com/x/y/commit/abcdef1"}]}
    cuerpo, cab = _firmado(w["secreto"], push)
    r = cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo, headers={**cab, "X-GitHub-Event": "push"})
    assert r.json()["issues"] == 1
    tipos = {v["tipo"] for v in cliente.get(f"/api/team/issues/{i['id']}", headers=gente["lia"]["h"]).json()["vinculos_lista"]}
    assert tipos == {"rama", "pr", "commit"}

    # Rotar invalida el secreto anterior.
    nuevo = cliente.post(f"/api/team/projects/{pid}/github-webhook/rotar", headers=gente["lia"]["h"]).json()["secreto"]
    assert nuevo != w["secreto"]
    cuerpo, cab = _firmado(w["secreto"], {"zen": "hola"})
    assert cliente.post(f"/api/team/github/webhook/{pid}", content=cuerpo,
                        headers={**cab, "X-GitHub-Event": "ping"}).status_code == 401
