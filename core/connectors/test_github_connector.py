"""Conector de GitHub: cifrado, política de modos, bucle del agente, renovación
de tokens y redirecciones. Sin red ni BD: GitHub, Ollama y la persistencia se
sustituyen por dobles."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from core.connectors import agente as ag
from core.connectors import github as gh
from core.connectors import github_tools as gt
from core.gateway.routers import connectors as rc
from core.security import cifrado

CLAVE = "k" * 40


def _ctx(modo="manual", puede=True):
    return gt.Contexto(repo="ada/motor", ref="main", rama_principal="main", puede_escribir=puede, modo=modo)


# ── cifrado ───────────────────────────────────────────────────────────────────

def test_cifrado_ida_y_vuelta(monkeypatch):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", CLAVE)
    secreto = cifrado.cifrar("ghu_token")
    assert "ghu_token" not in secreto
    assert cifrado.descifrar(secreto) == "ghu_token"
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", "x" * 40)
    assert cifrado.descifrar(secreto) is None  # otra clave: no se lee, no explota


def test_sin_clave_no_hay_conector(monkeypatch):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", "corta")
    assert not cifrado.disponible()
    monkeypatch.setattr(gh, "CLIENT_ID", "cid")
    monkeypatch.setattr(gh, "CLIENT_SECRET", "sec")
    monkeypatch.setattr(gh, "APP_SLUG", "lixbon")
    assert not gh.configurado()


# ── política de modos ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("modo", ["plan", "ask"])
def test_plan_y_ask_son_solo_lectura(modo):
    nombres = {t["function"]["name"] for t in gt.herramientas(modo, True)}
    assert nombres == gt.NOMBRES_LECTURA
    for nombre in gt.NOMBRES_ESCRITURA:
        assert gt.decidir(_ctx(modo), nombre, {"name": "x", "branch": "x"})[0] == "denegar"
    assert gt.decidir(_ctx(modo), "github_read_file", {"path": "a"})[0] == "permitir"


def test_manual_confirma_ediciones_y_riesgos_pero_no_lo_basico():
    c = _ctx("manual")
    assert gt.decidir(c, "github_write_files", {"branch": "lixbon/x"})[0] == "confirmar"
    assert gt.decidir(c, "github_delete_branch", {"name": "vieja"})[0] == "confirmar"
    for basica in ("github_create_branch", "github_create_pull_request", "github_merge_pull_request",
                   "github_create_issue", "github_comment", "github_update_issue"):
        assert gt.decidir(c, basica, {})[0] == "permitir"


def test_auto_lo_hace_todo_sin_preguntar():
    c = _ctx("auto")
    for nombre in gt.NOMBRES_ESCRITURA:
        assert gt.decidir(c, nombre, {"name": "otra", "branch": "main"})[0] == "permitir"


def test_bloqueos_en_cualquier_modo():
    for modo in gt.MODOS:
        assert gt.decidir(_ctx(modo), "github_delete_branch", {"name": "main"})[0] == "denegar"
        assert gt.decidir(_ctx(modo), "github_borrar_repo", {})[0] == "denegar"


def test_sin_permiso_push_no_escribe_ni_en_auto():
    assert {t["function"]["name"] for t in gt.herramientas("auto", False)} == gt.NOMBRES_LECTURA
    assert gt.decidir(_ctx("auto", puede=False), "github_comment", {})[0] == "denegar"


def test_la_tarjeta_destaca_escribir_en_la_principal():
    r = gt.resumen_confirmacion(_ctx(), "github_write_files", {
        "branch": "main", "message": "fix", "files": [{"path": "a.py", "content": "x\ny"}], "delete": ["b.py"]})
    assert r["riesgo"] == "rama_principal"
    assert r["files"] == [{"path": "a.py", "accion": "escribir", "lineas": 2}, {"path": "b.py", "accion": "borrar"}]


# ── bucle del agente ──────────────────────────────────────────────────────────

def _chunk(content="", tool_calls=None):
    delta = {"content": content}
    if tool_calls:
        delta["tool_calls"] = tool_calls
    return "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": None}]}) + "\n\n"


def _modelo(pasos):
    """Cada paso: (texto, [(nombre, args)]). Graba lo que recibe el modelo."""
    vistos = []

    def paso(messages, tools, collector):
        async def gen():
            vistos.append({"messages": list(messages), "tools": tools})
            texto, llamadas = pasos.pop(0)
            calls = [{"id": f"c{i}", "type": "function",
                      "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(llamadas)]
            collector["content"] = texto
            collector["prompt_tokens"] = 10
            collector["completion_tokens"] = 5
            if calls:
                collector["tool_calls"] = calls
            yield _chunk(texto)
        return gen()

    return paso, vistos


class _Store:
    def __init__(self):
        self.pendientes = {}

    def create_pending_action(self, user_id, provider, conv, ctx, transcript, calls):
        aid = f"acc{len(self.pendientes) + 1}xxxx"
        self.pendientes[aid] = {"id": aid, "conversation_id": conv, "context": ctx,
                                "transcript": json.loads(json.dumps(transcript)), "calls": calls}
        return aid

    def discard_pending_for_conversation(self, *a):
        pass


@pytest.fixture
def entorno(monkeypatch):
    store = _Store()
    monkeypatch.setattr(ag.store, "create_pending_action", store.create_pending_action)
    monkeypatch.setattr(ag.store, "discard_pending_for_conversation", store.discard_pending_for_conversation)
    monkeypatch.setattr(ag, "log_audit_event", lambda *a, **k: None)
    ejecutadas = []

    async def ejecutar(cli, ctx, nombre, args):
        ejecutadas.append(nombre)
        return {"ok": True, "url": "https://github.com/x"}

    monkeypatch.setattr(ag.gt, "ejecutar", ejecutar)
    return store, ejecutadas


def _correr(gen):
    async def todo():
        return [c async for c in gen]
    return asyncio.run(todo())


def _eventos(chunks, clave):
    out = []
    for c in chunks:
        if c.startswith("data: {"):
            d = json.loads(c[6:])
            if clave in d:
                out.append(d[clave])
    return out


def test_lee_y_responde(entorno):
    store, ejecutadas = entorno
    paso, vistos = _modelo([("", [("github_read_file", {"path": "README.md"})]), ("Es un motor.", [])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("ask"), model="m", paso=paso, cliente=object())
    chunks = _correr(a.iniciar([{"role": "user", "content": "¿qué es?"}]))
    assert ejecutadas == ["github_read_file"]
    herramientas = [e for e in _eventos(chunks, "lixbon_tool") if e["name"] != "thinking"]
    assert [e["status"] for e in herramientas] == ["running", "done"]
    # Cada vuelta al modelo abre «Pensando»; el texto la cierra.
    pensar = [e["status"] for e in _eventos(chunks, "lixbon_tool") if e["name"] == "thinking"]
    assert pensar == ["running", "running", "done"]
    assert a.turno.texto == "Es un motor."
    assert a.turno.prompt_tokens == 20
    # El modelo ve el resultado de la herramienta en el segundo paso.
    assert vistos[1]["messages"][-1]["role"] == "tool"


def test_ask_no_ejecuta_escrituras_aunque_el_modelo_las_pida(entorno):
    store, ejecutadas = entorno
    paso, vistos = _modelo([("", [("github_write_files", {"branch": "main", "message": "x",
                                                           "files": [{"path": "a", "content": "b"}]})]),
                            ("No puedo.", [])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("ask"), model="m", paso=paso, cliente=object())
    _correr(a.iniciar([{"role": "user", "content": "edita"}]))
    assert ejecutadas == []
    assert json.loads(vistos[1]["messages"][-1]["content"])["denied"] is True


def test_manual_pausa_y_retoma_al_aceptar(entorno):
    store, ejecutadas = entorno
    escribir = ("github_write_files", {"branch": "lixbon/fix", "message": "fix",
                                       "files": [{"path": "a.py", "content": "x"}]})
    paso, _ = _modelo([("Voy a corregirlo.", [("github_read_file", {"path": "a.py"}), escribir])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("manual"), model="m", paso=paso, cliente=object())
    chunks = _correr(a.iniciar([{"role": "user", "content": "arregla a.py"}]))
    confirm = _eventos(chunks, "lixbon_github_confirm")
    assert len(confirm) == 1 and confirm[0]["branch"] == "lixbon/fix"
    assert ejecutadas == ["github_read_file"]  # la lectura sí, la edición espera
    pendiente = store.pendientes[a.turno.pendiente]

    paso2, vistos = _modelo([("Listo, commit hecho.", [])])
    b = ag.Agente(user_id=1, conversation_id="c", ctx=gt.Contexto.from_dict(pendiente["context"]),
                  model="m", paso=paso2, cliente=object())
    _correr(b.retomar(pendiente, aprobada=True))
    assert ejecutadas == ["github_read_file", "github_write_files"]
    assert b.turno.texto == "Listo, commit hecho."


def test_manual_rechazar_no_ejecuta(entorno):
    store, ejecutadas = entorno
    paso, _ = _modelo([("", [("github_delete_branch", {"name": "vieja"})])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("manual"), model="m", paso=paso, cliente=object())
    _correr(a.iniciar([{"role": "user", "content": "borra vieja"}]))
    pendiente = store.pendientes[a.turno.pendiente]
    paso2, vistos = _modelo([("Vale, no la borro.", [])])
    b = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("manual"), model="m", paso=paso2, cliente=object())
    _correr(b.retomar(pendiente, aprobada=False))
    assert ejecutadas == []
    assert json.loads(vistos[0]["messages"][-1]["content"])["rejected"] is True


def test_auto_encadena_sin_pausas(entorno):
    store, ejecutadas = entorno
    paso, _ = _modelo([
        ("", [("github_write_files", {"branch": "lixbon/x", "message": "m", "files": [{"path": "a", "content": "b"}]})]),
        ("", [("github_create_pull_request", {"head": "lixbon/x", "title": "t"})]),
        ("**Hecho**\n- PR abierto", []),
    ])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("auto"), model="m", paso=paso, cliente=object())
    chunks = _correr(a.iniciar([{"role": "user", "content": "hazlo"}]))
    assert ejecutadas == ["github_write_files", "github_create_pull_request"]
    assert not _eventos(chunks, "lixbon_github_confirm")
    assert len(a.turno.acciones) == 2


def test_tope_de_pasos(entorno, monkeypatch):
    monkeypatch.setattr(ag, "MAX_PASOS", 2)
    paso, vistos = _modelo([("", [("github_list_branches", {})])] * 2 + [("Resumen.", [])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("ask"), model="m", paso=paso, cliente=object())
    _correr(a.iniciar([{"role": "user", "content": "x"}]))
    assert vistos[-1]["tools"] is None
    assert a.turno.texto == "Resumen."


# ── tokens ────────────────────────────────────────────────────────────────────

def test_renueva_el_token_que_caduca(monkeypatch):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", CLAVE)
    monkeypatch.setattr(gh, "CLIENT_ID", "cid")
    monkeypatch.setattr(gh, "CLIENT_SECRET", "sec")
    monkeypatch.setattr(gh, "APP_SLUG", "lixbon")
    pronto = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    fila = {"id": 7, "user_id": 1, "access_token_enc": cifrado.cifrar("viejo"),
            "refresh_token_enc": cifrado.cifrar("ghr_1"), "access_expires_at": pronto}
    guardado = {}
    monkeypatch.setattr(gh.store, "get_connector", lambda uid, p: fila)
    monkeypatch.setattr(gh.store, "update_tokens", lambda cid, **f: guardado.update(f))

    async def token_endpoint(data):
        assert data == {"grant_type": "refresh_token", "refresh_token": "ghr_1"}
        return {"access_token": "nuevo", "refresh_token": "ghr_2", "expires_in": 28800}

    monkeypatch.setattr(gh, "_token_endpoint", token_endpoint)
    assert asyncio.run(gh.token_de(1)) == "nuevo"
    assert cifrado.descifrar(guardado["refresh_token_enc"]) == "ghr_2"


def test_refresh_rechazado_desconecta(monkeypatch):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", CLAVE)
    monkeypatch.setattr(gh, "CLIENT_ID", "cid")
    monkeypatch.setattr(gh, "CLIENT_SECRET", "sec")
    monkeypatch.setattr(gh, "APP_SLUG", "lixbon")
    fila = {"id": 7, "user_id": 1, "access_token_enc": cifrado.cifrar("viejo"),
            "refresh_token_enc": cifrado.cifrar("ghr_1"), "access_expires_at": "2000-01-01T00:00:00+00:00"}
    borrados = []
    monkeypatch.setattr(gh.store, "get_connector", lambda uid, p: fila)
    monkeypatch.setattr(gh.store, "delete_connector", lambda uid, p: borrados.append(uid) or True)

    async def token_endpoint(data):
        raise gh.GitHubError("bad_refresh_token")

    monkeypatch.setattr(gh, "_token_endpoint", token_endpoint)
    with pytest.raises(gh.NoConectado):
        asyncio.run(gh.token_de(1))
    assert borrados == [1]


def test_cada_usuario_usa_su_token(monkeypatch):
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", CLAVE)
    monkeypatch.setattr(gh, "CLIENT_ID", "cid")
    monkeypatch.setattr(gh, "CLIENT_SECRET", "sec")
    monkeypatch.setattr(gh, "APP_SLUG", "lixbon")
    filas = {1: {"id": 1, "user_id": 1, "access_token_enc": cifrado.cifrar("de-ada")},
             2: {"id": 2, "user_id": 2, "access_token_enc": cifrado.cifrar("de-bob")}}
    monkeypatch.setattr(gh.store, "get_connector", lambda uid, p: filas.get(uid))
    assert asyncio.run(gh.token_de(1)) == "de-ada"
    assert asyncio.run(gh.token_de(2)) == "de-bob"
    with pytest.raises(gh.NoConectado):
        asyncio.run(gh.token_de(3))


# ── redirecciones ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("malo", ["https://evil.com", "//evil.com", "/\\evil.com", "integraciones", ""])
def test_destino_solo_rutas_propias(malo):
    assert rc._destino(malo) == rc.DESTINO_POR_DEFECTO


def test_destino_valido():
    assert rc._destino("/en/integraciones") == "/en/integraciones"


def test_callback_de_otra_sesion_no_conecta(monkeypatch):
    monkeypatch.setattr(rc.gh, "configurado", lambda: True)
    state = rc._sign_state({"p": "gh-conn", "u": 1, "r": "/integraciones", "ts": __import__("time").time()})
    monkeypatch.setattr(rc, "resolve_credential", lambda cookie, auth: {"id": 2})
    conectados = []

    async def conectar(*a):
        conectados.append(a)

    monkeypatch.setattr(rc.gh, "conectar", conectar)

    class Req:
        base_url = "https://lixbon.com/"
        client = None

    resp = asyncio.run(rc.callback(Req(), state=state, code="abc", error="", lixbon_session="s"))
    assert "github=session" in resp.headers["location"]
    assert conectados == []


def test_recordatorio_del_modo_antes_del_ultimo_mensaje(entorno):
    paso, vistos = _modelo([("Plan: 1.", [])])
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("plan"), model="m", paso=paso, cliente=object())
    _correr(a.iniciar([{"role": "user", "content": "a"}, {"role": "assistant", "content": "no puedo"},
                       {"role": "user", "content": "planifica"}]))
    msgs = vistos[0]["messages"]
    assert msgs[-2]["role"] == "system" and "PLAN" in msgs[-2]["content"]
    assert msgs[-1]["content"] == "planifica"


def test_el_razonamiento_no_viaja_al_cliente(entorno):
    def paso(messages, tools, collector):
        async def gen():
            yield "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": "pienso"}}]}) + "\n\n"
            yield _chunk("Hola")
        return gen()
    a = ag.Agente(user_id=1, conversation_id="c", ctx=_ctx("ask"), model="m", paso=paso, cliente=object())
    chunks = _correr(a.iniciar([{"role": "user", "content": "x"}]))
    assert not any("pienso" in c for c in chunks)
    assert a.turno.texto == "Hola"
