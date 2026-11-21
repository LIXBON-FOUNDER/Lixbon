"""API de Coding (/api/coding/*) con un runner falso: sin Docker ni GitHub.

SQLite temporal: DATABASE_URL se fija ANTES de importar core.config.
"""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_coding_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'coding.db').as_posix()}"
os.environ["CODING_BARRIDO"] = "0"
os.environ["AGENTES_PROGRAMADOS"] = "0"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.connectors import github as gh  # noqa: E402
from core.gateway import app as app_mod  # noqa: E402
from core.persistence import coding as store, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402
from core.sandbox import runner as runner_mod  # noqa: E402

REPO = "gabriel/tienda-web"


def _plan(pid):
    return Plan(id=pid, name=pid, description="", price_monthly_cents=0, currency="USD", messages_per_day=-1,
                tokens_per_month=-1, max_api_keys=5, rate_limit_per_min=1000, allowed_models=None, priority=0,
                sort_order=0, is_active=1, created_at=q.now_iso(), updated_at=q.now_iso())


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for pid in ("free", "pro"):
            if not s.get(Plan, pid):
                s.add(_plan(pid))
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def fake():
    f = runner_mod.FakeRunner()
    runner_mod.usar(f)
    yield f
    runner_mod.usar(None)


@pytest.fixture(scope="module", autouse=True)
def _github():
    """GitHub falso: cualquier repo de `gabriel/` existe; el resto, 404."""
    viejo_cliente, viejo_token, viejo_conf = gh.Cliente, gh.token_de, gh.configurado

    class Cliente:
        def __init__(self, uid):
            self.uid = uid

        async def __call__(self, metodo, ruta, **kw):
            if metodo == "GET" and ruta.endswith("/pulls/42"):
                return {"number": 42, "html_url": f"https://github.com/{REPO}/pull/42", "title": "Carrito",
                        "state": "open", "merged": False, "head": {"sha": "abc", "ref": "lixbon/x"},
                        "base": {"ref": "main"}, "additions": 5, "deletions": 1, "changed_files": 2}
            if metodo == "GET" and "/check-runs" in ruta:
                return {"check_runs": [{"status": "completed", "conclusion": "success"},
                                       {"status": "in_progress"}]}
            if metodo == "GET" and ruta.startswith("/repos/gabriel/") and "/branches" in ruta:
                if ruta.endswith("/branches"):
                    return [{"name": "dev"}, {"name": "main"}, {"name": "Alpha"}]
                if ruta.endswith("/branches/dev"):
                    return {"name": "dev"}
                raise gh.GitHubError("GitHub 404: Not Found", status=404)
            if metodo == "GET" and ruta.startswith("/repos/gabriel/"):
                return {"full_name": ruta.removeprefix("/repos/"), "default_branch": "main"}
            if metodo == "POST" and ruta.endswith("/pulls"):
                return {"html_url": f"https://github.com/{REPO}/pull/42", "number": 42}
            raise gh.GitHubError("GitHub 404: Not Found", status=404)

    async def token_de(uid):
        return "ghu_falso"

    gh.Cliente, gh.token_de, gh.configurado = Cliente, token_de, lambda: True
    yield
    gh.Cliente, gh.token_de, gh.configurado = viejo_cliente, viejo_token, viejo_conf


@pytest.fixture(scope="module", autouse=True)
def _sin_catalogo():
    """Sin nodos ni Ollama local: el catálogo de modelos es «no se sabe»
    (los tests que lo necesitan ponen el suyo)."""
    from core.gateway.routers import coding as router_coding
    viejo = router_coding._modelos_validos

    async def vacio(user):
        return set()

    router_coding._modelos_validos = vacio
    yield
    router_coding._modelos_validos = viejo


@pytest.fixture(scope="module")
def cliente(_esquema, fake):
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        yield c


def _usuario(email, plan):
    u = q.create_user(email, "contrasena-larga-de-prueba", "Prueba", "Coding")
    q.set_user_plan(u["id"], plan)
    return u, {"lixbon_session": q.create_web_session(u["id"])}


@pytest.fixture(scope="module")
def pro(_esquema):
    return _usuario("pro@lixbon.test", "pro")


@pytest.fixture
def nuevo(_esquema):
    import uuid
    return _usuario(f"{uuid.uuid4().hex[:8]}@lixbon.test", "pro")


@pytest.fixture(scope="module")
def otro(_esquema):
    return _usuario("otro@lixbon.test", "pro")


def _crear(cliente, cookies, repo=REPO):
    cliente.cookies.clear()
    r = cliente.post("/api/coding/sessions", json={"repo": repo, "mode": "manual"}, cookies=cookies)
    assert r.status_code == 201, r.text
    return r.json()["session"]["id"]


def test_plan_gratuito_no_puede_crear(cliente):
    _, cookies = _usuario("free@lixbon.test", "free")
    r = cliente.post("/api/coding/sessions", json={"repo": REPO, "mode": "manual"}, cookies=cookies)
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "coding_requires_plan"


def test_repo_sin_acceso(cliente, pro):
    r = cliente.post("/api/coding/sessions", json={"repo": "ajeno/repo", "mode": "manual"}, cookies=pro[1])
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "repo_not_accessible"


def test_crear_no_arranca_hasta_el_primer_mensaje(cliente, pro, fake):
    sid = _crear(cliente, pro[1])
    assert store.obtener(sid)["estado"] == "creada"
    assert not any(c[0] == "arrancar" and c[1].session_id == sid for c in fake.llamadas)
    r = cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "Añade descuentos al carrito"}, cookies=pro[1])
    assert r.status_code == 200, r.text
    sb = store.obtener(sid)
    assert sb["estado"] == "preparando"
    assert sb["pending_prompt"][0]["text"] == "Añade descuentos al carrito"
    arranque = next(c[1] for c in fake.llamadas if c[0] == "arrancar" and c[1].session_id == sid)
    assert arranque.token.startswith("lixbon_ct_") and arranque.repo == REPO
    # La sesión aparece en la lista de Remoto/Coding con su entorno.
    lista = cliente.get("/api/remote/sessions", cookies=pro[1]).json()["sessions"]
    fila = next(s for s in lista if s["id"] == sid)
    assert fila["source"] == "cloud" and fila["sandbox"]["estado"] == "preparando"
    assert "container_id" not in fila["sandbox"]


def test_otro_usuario_no_ve_la_sesion(cliente, pro, otro):
    sid = _crear(cliente, pro[1])
    for metodo, ruta in [("post", "pause"), ("post", "resume"), ("post", "pr")]:
        r = getattr(cliente, metodo)(f"/api/coding/sessions/{sid}/{ruta}", json={}, cookies=otro[1])
        assert r.status_code == 404, ruta
    assert cliente.delete(f"/api/coding/sessions/{sid}", cookies=otro[1]).status_code == 404
    r = cliente.get(f"/api/coding/sessions/{sid}/preview/5173/", cookies=otro[1])
    assert r.status_code == 404


def test_limite_de_sesiones_activas(cliente, fake):
    _, cookies = _usuario("limite@lixbon.test", "pro")
    ids = [_crear(cliente, cookies) for _ in range(3)]
    for sid in ids[:2]:
        assert cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=cookies).status_code == 200
    r = cliente.post(f"/api/coding/sessions/{ids[2]}/prompt", json={"text": "hola"}, cookies=cookies)
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "max_active_sessions"
    # Pausar una libera el hueco.
    assert cliente.post(f"/api/coding/sessions/{ids[0]}/pause", cookies=cookies).status_code == 200
    assert store.obtener(ids[0])["estado"] == "pausada"
    assert cliente.post(f"/api/coding/sessions/{ids[2]}/prompt", json={"text": "hola"}, cookies=cookies).status_code == 200


def _token(sid):
    raw = store.emitir_token(sid)
    return {"Authorization": f"Bearer {raw}"}


def test_token_del_contenedor_solo_vale_en_su_sesion(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    otra = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    cliente.cookies.clear()
    h = _token(sid)
    # Fuera de su alcance: el token no existe.
    for metodo, ruta in [("get", "/api/conversations"), ("get", "/api/remote/sessions"),
                         ("get", "/api/connectors/github/repos"), ("get", "/api/coding/estado"),
                         ("post", f"/api/remote/sessions/{sid}/commands"),
                         ("get", f"/api/remote/sessions/{sid}/stream"),
                         ("post", f"/api/coding/sessions/{otra}/host")]:
        r = getattr(cliente, metodo)(ruta, headers=h, **({"json": {"type": "approve"}} if metodo == "post" else {}))
        assert r.status_code in (401, 403, 404), (ruta, r.status_code)
    # Dentro: su /host funciona y entrega el mensaje pendiente al pasar a activa.
    r = cliente.post(f"/api/coding/sessions/{sid}/host", json={"estado": "clonando"}, headers=h)
    assert r.status_code == 200, r.text
    r = cliente.post(f"/api/coding/sessions/{sid}/host",
                     json={"estado": "activa", "branch": "lixbon/carrito"}, headers=h)
    assert r.status_code == 200
    assert r.json()["pending"][0]["text"] == "hola"
    sb = store.obtener(sid)
    assert sb["estado"] == "activa" and sb["branch"] == "lixbon/carrito" and sb["pending_prompt"] is None


def test_rama_que_no_es_lixbon_se_rechaza(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    cliente.cookies.clear()
    r = cliente.post(f"/api/coding/sessions/{sid}/host", json={"branch": "main"}, headers=_token(sid))
    assert r.status_code == 422


def test_push_a_main_se_rechaza_sin_llegar_a_github(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    cliente.cookies.clear()
    datos = f"{'0' * 40} {'a' * 40} refs/heads/main\0report-status\n".encode()
    cuerpo = f"{len(datos) + 4:04x}".encode() + datos + b"0000PACK"
    r = cliente.post(f"/api/coding/sessions/{sid}/git/git-receive-pack", content=cuerpo,
                     headers={**_token(sid), "Content-Type": "application/x-git-receive-pack-request"})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "push_rejected"


def test_token_revocado_al_pausar(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    h = _token(sid)
    cliente.post(f"/api/coding/sessions/{sid}/pause", cookies=pro[1])
    cliente.cookies.clear()
    r = cliente.post(f"/api/coding/sessions/{sid}/host", json={"estado": "activa"}, headers=h)
    assert r.status_code == 401


def test_pr_desde_el_host(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    cliente.cookies.clear()
    h = _token(sid)
    cliente.post(f"/api/coding/sessions/{sid}/host", json={"estado": "activa", "branch": "lixbon/x"}, headers=h)
    r = cliente.post(f"/api/coding/sessions/{sid}/host", json={"pr": {"title": "Descuentos"}}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["pr"]["number"] == 42
    assert store.obtener(sid)["pr_url"].endswith("/pull/42")


def test_eliminar_borra_el_entorno_y_la_sesion(cliente, pro, fake):
    sid = _crear(cliente, pro[1])
    r = cliente.delete(f"/api/coding/sessions/{sid}", cookies=pro[1])
    assert r.status_code == 204
    assert store.obtener(sid) is None
    assert q.get_remote_session(sid) is None
    assert ("borrar", sid) in fake.llamadas


def test_gestion_desde_la_barra(cliente, pro):
    """Renombrar, fijar y archivar valen para cualquier sesión (aquí, una de la nube)."""
    sid = _crear(cliente, pro[1])
    r = cliente.patch(f"/api/remote/sessions/{sid}", json={"title": "  Arreglar   el carrito "}, cookies=pro[1])
    assert r.status_code == 200, r.text
    assert q.get_remote_session(sid)["title"] == "Arreglar el carrito"
    r = cliente.patch(f"/api/remote/sessions/{sid}", json={"pinned": True}, cookies=pro[1])
    assert r.json()["session"]["pinned"] is True
    r = cliente.patch(f"/api/remote/sessions/{sid}", json={"archived": True}, cookies=pro[1])
    assert r.json()["session"]["archived"] is True and r.json()["session"]["pinned"] is False
    fila = next(s for s in cliente.get("/api/remote/sessions", cookies=pro[1]).json()["sessions"] if s["id"] == sid)
    assert fila["archived"] is True and fila["pinned"] is False and fila["needs_you"] is False
    r = cliente.patch(f"/api/remote/sessions/{sid}", json={"archived": False}, cookies=pro[1])
    assert r.json()["session"]["archived"] is False
    # Una de la nube no se «olvida»: se elimina con su entorno.
    assert cliente.post(f"/api/remote/sessions/{sid}/forget", cookies=pro[1]).status_code == 409


def test_gestion_valida_los_cambios(cliente, pro, otro):
    sid = _crear(cliente, pro[1])
    assert cliente.patch(f"/api/remote/sessions/{sid}", json={"pinned": "sí"}, cookies=pro[1]).status_code == 422
    assert cliente.patch(f"/api/remote/sessions/{sid}", json={"title": "   "}, cookies=pro[1]).status_code == 422
    assert cliente.patch(f"/api/coding/sessions/{sid}", json={"title": "   "}, cookies=pro[1]).status_code == 422
    cliente.cookies.clear()
    assert cliente.patch(f"/api/remote/sessions/{sid}", json={"pinned": True}, cookies=otro[1]).status_code == 404


def test_olvidar_sesion_del_cli(cliente, nuevo):
    pro = nuevo
    _, sesion = q.create_remote_session(pro[0]["id"], "cli", "proyecto", "pc", "lixbon", "proyecto")
    sid = sesion["id"]
    assert cliente.post(f"/api/remote/sessions/{sid}/forget", cookies=pro[1]).status_code == 204
    assert q.get_remote_session(sid) is None


def test_chats_fijar_y_mover(cliente, nuevo):
    from core.persistence import espacios as es
    pro = nuevo
    import uuid
    cid = uuid.uuid4().hex
    assert q.ensure_conversation(cid, pro[0]["id"], "Plan", None, "web")
    assert cliente.post(f"/api/conversations/{cid}/pin", cookies=pro[1]).status_code == 200
    ids = [c["id"] for c in cliente.get("/api/conversations?pinned=true", cookies=pro[1]).json()["conversations"]]
    assert cid in ids
    esp = es.crear(pro[0]["id"], {"nombre": "Lanzamiento"})
    eid = esp["id"]
    r = cliente.put(f"/api/conversations/{cid}/espacio", json={"espacio_id": eid}, cookies=pro[1])
    assert r.status_code == 200, r.text
    r = cliente.put(f"/api/conversations/{cid}/espacio", json={"espacio_id": "noexiste"}, cookies=pro[1])
    assert r.status_code == 404


def test_entorno_no_disponible(cliente, pro, fake):
    fake.ok = False
    try:
        r = cliente.post("/api/coding/sessions", json={"repo": REPO, "mode": "manual"}, cookies=pro[1])
        assert r.status_code == 503
    finally:
        fake.ok = True


def test_hello_del_host_no_pisa_el_titulo(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "Arregla el carrito"}, cookies=pro[1])
    cliente.cookies.clear()
    r = cliente.post(f"/api/remote/sessions/{sid}/events", headers=_token(sid),
                     json={"events": [{"type": "hello", "title": "Couples", "agent": "lixbon"}]})
    assert r.status_code == 200, r.text
    fila = next(s for s in cliente.get("/api/remote/sessions", cookies=pro[1]).json()["sessions"] if s["id"] == sid)
    assert fila["title"] == "Arregla el carrito"
    # Los mensajes que esperan al entorno se ven en la web (solo texto).
    assert fila["sandbox"]["pendientes"] == ["Arregla el carrito"]


def test_sesion_huerfana_se_puede_borrar(cliente, nuevo):
    from core.persistence.queries import create_remote_session
    pro = nuevo
    _, sesion = create_remote_session(pro[0]["id"], "cloud", "Huérfana", "Nube", "lixbon", "o/r")
    sid = sesion["id"]
    assert cliente.patch(f"/api/coding/sessions/{sid}", json={"pinned": True}, cookies=pro[1]).status_code == 404
    assert cliente.delete(f"/api/coding/sessions/{sid}", cookies=pro[1]).status_code == 204
    ids = [s["id"] for s in cliente.get("/api/remote/sessions", cookies=pro[1]).json()["sessions"]]
    assert sid not in ids


def test_mensaje_tras_reinicio_del_gateway_llega_al_host(cliente, nuevo):
    """Tras un reinicio el canal está vacío y el host aún no ha vuelto: el
    mensaje y el cambio de modo se encolan, y el «suelo» que recibe el host al
    engancharse no los descarta aunque su último comando visto sea mayor."""
    from core.gateway.remote_hub import hub
    from core.gateway.routers.remote import _suelo_comandos
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    store.actualizar(sid, estado="activa")
    hub.drop(sid)  # reinicio: sin canal en memoria
    assert cliente.patch(f"/api/coding/sessions/{sid}", json={"mode": "auto"}, cookies=pro[1]).status_code == 200
    r = cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "sigue"}, cookies=pro[1])
    assert r.status_code == 200 and r.json()["queued"] is True
    ch = hub.get(sid)
    _, cola = hub.attach_host(ch, last_cmd=50)  # el host venía del gateway anterior
    suelo = _suelo_comandos(ch, cola)
    ultimo = min(50, suelo)  # lo que hace el host (link.go) con el frame "channel"
    entregados = [c for c in list(cola._queue) if c and c["cmd_seq"] > ultimo]
    assert [c["type"] for c in entregados] == ["config", "prompt"]
    assert entregados[1]["text"] == "sigue"


def test_modelo_y_modo_se_guardan(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    r = cliente.patch(f"/api/coding/sessions/{sid}", json={"model": "qwen3:8b", "mode": "auto"}, cookies=pro[1])
    assert r.status_code == 200, r.text
    sb = store.obtener(sid)
    assert sb["model"] == "qwen3:8b" and sb["mode"] == "auto"
    assert cliente.patch(f"/api/coding/sessions/{sid}", json={"model": ""}, cookies=pro[1]).status_code == 422


def test_rama_base_elegida(cliente, nuevo):
    pro = nuevo
    cliente.cookies.clear()
    r = cliente.get(f"/api/coding/branches?repo={REPO}", cookies=pro[1])
    assert r.status_code == 200, r.text
    assert r.json()["branches"] == ["main", "Alpha", "dev"]
    r = cliente.post("/api/coding/sessions", json={"repo": REPO, "mode": "manual", "base": "dev"}, cookies=pro[1])
    assert r.status_code == 201, r.text
    assert r.json()["sandbox"]["default_branch"] == "dev"
    r = cliente.post("/api/coding/sessions", json={"repo": REPO, "mode": "manual", "base": "noexiste"}, cookies=pro[1])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "base_not_found"
    r = cliente.post("/api/coding/sessions", json={"repo": REPO, "mode": "manual", "base": "../main"}, cookies=pro[1])
    assert r.status_code == 422


def test_prs_de_la_sesion(cliente, nuevo):
    pro = nuevo
    sid = _crear(cliente, pro[1])
    assert cliente.get(f"/api/coding/sessions/{sid}/prs", cookies=pro[1]).json() == {"prs": []}
    store.actualizar(sid, pr_url=f"https://github.com/{REPO}/pull/42")
    pr = cliente.get(f"/api/coding/sessions/{sid}/prs", cookies=pro[1]).json()["prs"][0]
    assert pr["state"] == "open" and pr["checks"] == {"total": 2, "ok": 1, "failed": 0, "pending": 1}


def test_seq_sigue_tras_reiniciar_el_gateway(cliente, nuevo):
    from core.gateway.remote_hub import hub
    pro = nuevo
    sid = _crear(cliente, pro[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=pro[1])
    cliente.cookies.clear()
    h = _token(sid)
    r = cliente.post(f"/api/remote/sessions/{sid}/events", headers=h,
                     json={"events": [{"type": "user_msg", "text": "uno"}, {"type": "assistant_done", "text": "dos"}]})
    assert r.status_code == 200
    antes = q.max_remote_event_seq(sid)
    assert antes >= 2
    hub.drop(sid)  # reinicio
    cliente.post(f"/api/remote/sessions/{sid}/events", headers=h, json={"events": [{"type": "user_msg", "text": "tres"}]})
    eventos = q.list_remote_events(sid)
    textos = [e.get("text") for e in eventos if e.get("type") in ("user_msg", "assistant_done")]
    assert textos == ["uno", "dos", "tres"]
    assert q.max_remote_event_seq(sid) == antes + 1


# ------------------------------------------------------------------ Fase 0: estabilizar

def _correr(coro):
    import asyncio
    return asyncio.run(coro)


def test_modelo_fuera_del_catalogo_se_rechaza(cliente, nuevo, monkeypatch):
    from core.gateway.routers import coding as router_coding

    async def catalogo(user):
        return {"lixbon-pro", "lixbon-rapido"}

    monkeypatch.setattr(router_coding, "_modelos_validos", catalogo)
    sid = _crear(cliente, nuevo[1])
    r = cliente.patch(f"/api/coding/sessions/{sid}", json={"model": "inventado", "mode": "auto"}, cookies=nuevo[1])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "model_unknown"
    # Nada a medias: el modo de la misma petición tampoco se aplicó.
    assert store.obtener(sid)["mode"] == "manual"
    r = cliente.patch(f"/api/coding/sessions/{sid}", json={"model": " lixbon-rapido "}, cookies=nuevo[1])
    assert r.status_code == 200 and store.obtener(sid)["model"] == "lixbon-rapido"
    cliente.cookies.clear()
    r = cliente.post("/api/coding/sessions", json={"repo": REPO, "model": "inventado"}, cookies=nuevo[1])
    assert r.status_code == 422


def test_reanudar_arranca_con_el_modelo_guardado(cliente, nuevo, fake, monkeypatch):
    from core.gateway.routers import coding as router_coding

    async def catalogo(user):
        return set()  # sin catálogo no se bloquea

    monkeypatch.setattr(router_coding, "_modelos_validos", catalogo)
    sid = _crear(cliente, nuevo[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=nuevo[1])
    cliente.patch(f"/api/coding/sessions/{sid}", json={"model": "qwen3:8b"}, cookies=nuevo[1])
    cliente.post(f"/api/coding/sessions/{sid}/pause", cookies=nuevo[1])
    r = cliente.post(f"/api/coding/sessions/{sid}/resume", cookies=nuevo[1])
    assert r.status_code == 202, r.text
    arranques = [a for nombre, a in fake.llamadas if nombre == "arrancar" and a.session_id == sid]
    assert arranques[-1].model == "qwen3:8b"
    cliente.post(f"/api/coding/sessions/{sid}/pause", cookies=nuevo[1])


def test_entorno_perdido_pasa_a_pausada(cliente, nuevo, fake):
    from core.sandbox import ciclo
    sid = _crear(cliente, nuevo[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=nuevo[1])
    cliente.cookies.clear()
    h = _token(sid)
    assert store.obtener(sid)["estado"] == "preparando"
    try:
        # Docker no contesta: no se concluye nada.
        fake.en_marcha = None
        _correr(ciclo.reconciliar())
        assert store.obtener(sid)["estado"] == "preparando"
        # Recién arrancada y todavía sin contenedor: está dentro del margen.
        fake.en_marcha = set()
        _correr(ciclo.reconciliar())
        assert store.obtener(sid)["estado"] == "preparando"
        # Activa con su contenedor: se queda como está.
        store.actualizar(sid, estado="activa")
        fake.en_marcha = {sid}
        _correr(ciclo.reconciliar())
        assert store.obtener(sid)["estado"] == "activa"
        # El contenedor desaparece (Docker reiniciado, borrado a mano).
        fake.en_marcha = set()
        assert _correr(ciclo.reconciliar()) >= 1
        sb = store.obtener(sid)
        assert sb["estado"] == "pausada" and sb["container_id"] is None and sb["paused_at"]
        assert ("detener", sid) in fake.llamadas
        # El token del contenedor perdido ya no vale y la web puede reanudar.
        assert cliente.post(f"/api/coding/sessions/{sid}/host", json={"estado": "activa"}, headers=h).status_code == 401
        cliente.cookies.clear()
        r = cliente.post(f"/api/coding/sessions/{sid}/resume", cookies=nuevo[1])
        assert r.status_code == 202 and r.json()["sandbox"]["estado"] == "preparando"
        cliente.post(f"/api/coding/sessions/{sid}/pause", cookies=nuevo[1])
    finally:
        fake.en_marcha = None


def test_preparando_atascada_se_da_por_perdida(cliente, nuevo, fake, monkeypatch):
    from core.sandbox import ciclo
    sid = _crear(cliente, nuevo[1])
    cliente.post(f"/api/coding/sessions/{sid}/prompt", json={"text": "hola"}, cookies=nuevo[1])
    monkeypatch.setattr(ciclo, "GRACIA_ARRANQUE_S", -5.0)  # el margen ya pasó
    try:
        fake.en_marcha = set()
        _correr(ciclo.reconciliar())
        assert store.obtener(sid)["estado"] == "pausada"
    finally:
        fake.en_marcha = None


def test_recolector_solo_borra_restos_sin_sesion(cliente, nuevo, fake):
    from core.sandbox import ciclo
    viva = _crear(cliente, nuevo[1])
    borrada = _crear(cliente, nuevo[1])
    assert cliente.delete(f"/api/coding/sessions/{borrada}", cookies=nuevo[1]).status_code == 204
    fantasma = "0123456789ab"
    fake.llamadas.clear()
    fake.sobras = {viva, borrada, fantasma}
    try:
        assert _correr(ciclo.recolectar()) == 2
        assert sorted(s for n, s in fake.llamadas if n == "borrar") == sorted([borrada, fantasma])
    finally:
        fake.sobras = set()


def test_fijada_aguanta_30_dias(cliente, nuevo):
    from core.persistence.models import CodingSandbox
    normal = _crear(cliente, nuevo[1])
    fijada = _crear(cliente, nuevo[1])
    reciente = _crear(cliente, nuevo[1])
    r = cliente.patch(f"/api/remote/sessions/{fijada}", json={"pinned": True}, cookies=nuevo[1])
    assert r.status_code == 200, r.text

    def envejecer(dias, *sids):
        with get_session() as s:
            for sid in sids:
                s.get(CodingSandbox, sid).last_activity_at = store._hace(days=dias)

    envejecer(8, normal, fijada)
    ids = {sb["session_id"] for sb in store.para_borrar(7, 30)}
    assert normal in ids and fijada not in ids and reciente not in ids
    envejecer(31, fijada)
    assert fijada in {sb["session_id"] for sb in store.para_borrar(7, 30)}
