"""Prueba de contrato de Lixbon Team.

No prueba «que el código no reviente»: prueba las **once reglas del transporte**
y las **cuatro del canje** de `docs/team-protocolo.md`, que son las que separan
un chat que funciona en una demo de uno que sobrevive a una red de verdad. Cada
prueba lleva el número de la regla que defiende, y si alguna se cae es que el
gateway acaba de dejar de cumplir el documento.

Usa un SQLite temporal: DATABASE_URL se fija ANTES de importar core.config, que
la lee en el import. El engine es global y perezoso, así que este módulo no debe
convivir con pruebas que necesiten la BD real.
"""
import base64
import hashlib
import os
import pathlib
import shutil
import tempfile
import uuid

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_team_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'team.db').as_posix()}"
os.environ.setdefault("TEAM_URL_SECRET", "secreto-de-prueba")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.gateway.team_hub import hub  # noqa: E402
from core.persistence import models, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan  # noqa: E402


def _cid() -> str:
    """Un client_id nuevo. El cliente lo genera antes de enviar y lo reutiliza
    en cada reintento; aquí uno por mensaje distinto."""
    return uuid.uuid4().hex


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    # create_all y no init_db: sus migraciones son sintaxis Postgres.
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        if not s.get(Plan, "free"):
            s.add(Plan(id="free", name="Gratuito", description="", price_monthly_cents=0,
                       currency="USD", messages_per_day=30, tokens_per_month=150000,
                       max_api_keys=1, rate_limit_per_min=1000, allowed_models=None,
                       priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def cliente(_esquema):
    # El lifespan real llama a init_db() (SQL de Postgres) y arranca el
    # orquestador de nodos: nada de eso tiene que ver con el contrato.
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    # Con `with`: un solo bucle de eventos para las peticiones y el WebSocket.
    # Sin él, cada llamada abriría el suyo y la cola de una conexión abierta en
    # otro bucle no despertaría nunca.
    with TestClient(app_mod.app) as c:
        yield c


def _alta(correo: str) -> tuple[int, str]:
    """Un usuario y su llave. Devuelve (id, api_key)."""
    u = q.create_user(correo, "contraseña-larga", correo.split("@")[0].title(), "Prueba")
    q.set_user_plan(u["id"], "free")
    llave, _ = q.create_api_key("lixbon Desktop", u["id"])
    return u["id"], llave


@pytest.fixture(scope="module")
def gente(_esquema):
    ana_id, ana_k = _alta("ana@lixbon.test")
    beto_id, beto_k = _alta("beto@lixbon.test")
    caro_id, caro_k = _alta("caro@lixbon.test")   # no está en el proyecto
    return {
        "ana": {"id": ana_id, "h": {"Authorization": f"Bearer {ana_k}"}, "llave": ana_k},
        "beto": {"id": beto_id, "h": {"Authorization": f"Bearer {beto_k}"}, "llave": beto_k},
        "caro": {"id": caro_id, "h": {"Authorization": f"Bearer {caro_k}"}, "llave": caro_k},
    }


@pytest.fixture(scope="module")
def proyecto(cliente, gente):
    """Ana crea el proyecto y mete a Beto. Es el escenario de todo lo demás."""
    r = cliente.post("/api/team/projects", json={"nombre": "Lixbon IDE"}, headers=gente["ana"]["h"])
    assert r.status_code == 201
    p = r.json()
    r = cliente.post(f"/api/team/projects/{p['id']}/members",
                     json={"identificador": "beto@lixbon.test"}, headers=gente["ana"]["h"])
    assert r.status_code == 201
    return {"id": p["id"], "general": p["canales"][0]["id"]}


# ── Arranque y modelo ──────────────────────────────────────────────────────

def test_proyecto_nace_con_general_y_su_creador_de_lider(cliente, gente, proyecto):
    r = cliente.get("/api/team/bootstrap", headers=gente["ana"]["h"])
    assert r.status_code == 200
    datos = r.json()
    p = next(x for x in datos["proyectos"] if x["id"] == proyecto["id"])
    assert p["rol"] == "lider"
    assert [c["nombre"] for c in p["canales"]] == ["general"]
    assert {m["usuario"]["id"] for m in p["miembros"]} == {gente["ana"]["id"], gente["beto"]["id"]}


def test_el_bootstrap_no_reparte_correos(cliente, gente, proyecto):
    """Un chat no es motivo para repartir la agenda de correos de la empresa."""
    p = next(x for x in cliente.get("/api/team/bootstrap", headers=gente["beto"]["h"]).json()
             ["proyectos"] if x["id"] == proyecto["id"])
    for m in p["miembros"]:
        assert set(m["usuario"]) == {"id", "username", "first_name", "last_name", "avatar_url"}


def test_solo_el_lider_toca_el_proyecto(cliente, gente, proyecto):
    r = cliente.patch(f"/api/team/projects/{proyecto['id']}",
                      json={"linear_team_id": "TEAM-1"}, headers=gente["beto"]["h"])
    assert r.status_code == 403
    r = cliente.patch(f"/api/team/projects/{proyecto['id']}",
                      json={"linear_team_id": "TEAM-1", "github_repo": "lixbon/ide"},
                      headers=gente["ana"]["h"])
    assert r.status_code == 200
    # Punteros, nunca credenciales (sección 8): el identificador viaja en el
    # bootstrap como un campo más porque por sí solo no da acceso a nada.
    assert r.json()["linear_team_id"] == "TEAM-1"
    assert r.json()["github_repo"] == "lixbon/ide"


def test_invitar_dos_veces_no_duplica(cliente, gente, proyecto):
    r = cliente.post(f"/api/team/projects/{proyecto['id']}/members",
                     json={"identificador": "beto@lixbon.test"}, headers=gente["ana"]["h"])
    assert r.status_code == 409


def test_un_extrano_no_ve_el_canal(cliente, gente, proyecto):
    """Y se le contesta 404, no 403: confirmar que existe ya es contar algo."""
    r = cliente.get(f"/api/team/channels/{proyecto['general']}/messages",
                    headers=gente["caro"]["h"])
    assert r.status_code == 404


# ── Regla 3: la autorización vive en el emisor ─────────────────────────────

def test_un_canal_privado_no_se_esconde_no_se_emite(cliente, gente, proyecto):
    r = cliente.post(f"/api/team/projects/{proyecto['id']}/channels",
                     json={"nombre": "dirección", "tipo": "privado"}, headers=gente["ana"]["h"])
    assert r.status_code == 201
    privado = r.json()["id"]

    # Beto es del proyecto, pero no de este canal: para él no existe.
    assert cliente.get(f"/api/team/channels/{privado}/messages",
                       headers=gente["beto"]["h"]).status_code == 404
    p = next(x for x in cliente.get("/api/team/bootstrap", headers=gente["beto"]["h"]).json()
             ["proyectos"] if x["id"] == proyecto["id"])
    assert privado not in [c["id"] for c in p["canales"]]

    # Y un integrante no puede crear canales privados por su cuenta.
    assert cliente.post(f"/api/team/projects/{proyecto['id']}/channels",
                        json={"nombre": "otro", "tipo": "privado"},
                        headers=gente["beto"]["h"]).status_code == 403


# ── Regla 1: idempotencia por client_id ────────────────────────────────────

def test_reenviar_el_mismo_client_id_no_duplica(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    cid = _cid()
    uno = cliente.post(ruta, json={"client_id": cid, "texto": "hola"}, headers=gente["ana"]["h"])
    dos = cliente.post(ruta, json={"client_id": cid, "texto": "hola"}, headers=gente["ana"]["h"])
    assert uno.status_code == 201 and dos.status_code == 200
    assert uno.json()["id"] == dos.json()["id"]
    assert uno.json()["seq"] == dos.json()["seq"]


# ── Regla 2: seq monotónico por canal ──────────────────────────────────────

def test_el_seq_sube_de_uno_en_uno_por_canal(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    seqs = [cliente.post(ruta, json={"client_id": _cid(), "texto": f"m{i}"},
                         headers=gente["beto"]["h"]).json()["seq"] for i in range(3)]
    assert seqs == sorted(seqs)
    assert seqs[1] == seqs[0] + 1 and seqs[2] == seqs[1] + 1


def test_paginacion_hacia_atras(cliente, gente, proyecto):
    """Un chat se lee del final hacia el principio."""
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    todos = cliente.get(f"{ruta}?limite=200", headers=gente["ana"]["h"]).json()["mensajes"]
    assert len(todos) >= 4
    ultimos = cliente.get(f"{ruta}?limite=2", headers=gente["ana"]["h"]).json()
    assert [m["id"] for m in ultimos["mensajes"]] == [m["id"] for m in todos[-2:]]
    assert ultimos["hay_mas"] is True
    previos = cliente.get(f"{ruta}?limite=2&antes_de={todos[-2]['seq']}",
                          headers=gente["ana"]["h"]).json()
    assert [m["id"] for m in previos["mensajes"]] == [m["id"] for m in todos[-4:-2]]


# ── Sección 6: hilos ───────────────────────────────────────────────────────

def test_un_hilo_tiene_un_solo_nivel(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    raiz = cliente.post(ruta, json={"client_id": _cid(), "texto": "¿lo movemos?"},
                        headers=gente["ana"]["h"]).json()
    r1 = cliente.post(ruta, json={"client_id": _cid(), "texto": "sí", "responde_a": raiz["id"]},
                      headers=gente["beto"]["h"]).json()
    # Responder a una RESPUESTA responde al mismo hilo: el servidor normaliza a
    # la raíz. Un cliente manipulado no puede montar un árbol de profundidad
    # libre, que es justo el problema que el hilo venía a resolver.
    r2 = cliente.post(ruta, json={"client_id": _cid(), "texto": "y esto", "responde_a": r1["id"]},
                      headers=gente["ana"]["h"]).json()
    assert r1["responde_a"] == raiz["id"]
    assert r2["responde_a"] == raiz["id"]

    # Las respuestas NO salen en el canal: es lo que impide que una conversación
    # de cuarenta réplicas lo entierre.
    canal = cliente.get(f"{ruta}?limite=200", headers=gente["ana"]["h"]).json()["mensajes"]
    ids = [m["id"] for m in canal]
    assert raiz["id"] in ids and r1["id"] not in ids and r2["id"] not in ids

    # Y el hilo trae solo sus respuestas: la raíz ya la tiene quien pregunta.
    hilo = cliente.get(f"{ruta}?hilo_de={raiz['id']}", headers=gente["ana"]["h"]).json()["mensajes"]
    assert [m["id"] for m in hilo] == [r1["id"], r2["id"]]

    # El resumen viaja DENTRO de la raíz: pintar el canal no puede costar una
    # petición por hilo.
    pintada = next(m for m in canal if m["id"] == raiz["id"])
    assert pintada["respuestas"] == 2
    assert pintada["respondientes"] == [gente["beto"]["id"], gente["ana"]["id"]]
    assert pintada["ultima_respuesta_en"] == r2["creado_en"]


def test_no_se_responde_a_un_mensaje_de_otro_canal(cliente, gente, proyecto):
    otro = cliente.post(f"/api/team/projects/{proyecto['id']}/channels",
                        json={"nombre": "diseño"}, headers=gente["ana"]["h"]).json()["id"]
    ajeno = cliente.post(f"/api/team/channels/{otro}/messages",
                         json={"client_id": _cid(), "texto": "aquí"},
                         headers=gente["ana"]["h"]).json()
    r = cliente.post(f"/api/team/channels/{proyecto['general']}/messages",
                     json={"client_id": _cid(), "texto": "no", "responde_a": ajeno["id"]},
                     headers=gente["ana"]["h"])
    assert r.status_code == 400


# ── Reglas 8, 9 y 10: editar y borrar ──────────────────────────────────────

def test_editar_y_borrar_son_del_autor(cliente, gente, proyecto):
    m = cliente.post(f"/api/team/channels/{proyecto['general']}/messages",
                     json={"client_id": _cid(), "texto": "mío"},
                     headers=gente["ana"]["h"]).json()
    # Ni el líder del proyecto ni quien esté en el canal: solo el autor.
    assert cliente.patch(f"/api/team/messages/{m['id']}", json={"texto": "tuyo"},
                         headers=gente["beto"]["h"]).status_code == 403
    assert cliente.delete(f"/api/team/messages/{m['id']}",
                          headers=gente["beto"]["h"]).status_code == 403


def test_editar_no_mueve_el_mensaje(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    m = cliente.post(ruta, json={"client_id": _cid(), "texto": "con falta"},
                     headers=gente["ana"]["h"]).json()
    cliente.post(ruta, json={"client_id": _cid(), "texto": "después"}, headers=gente["beto"]["h"])
    editado = cliente.patch(f"/api/team/messages/{m['id']}", json={"texto": "sin falta"},
                            headers=gente["ana"]["h"]).json()
    # Un mensaje que salta al final por corregir una tilde rompe la
    # conversación de todos los demás.
    assert editado["seq"] == m["seq"]
    assert editado["creado_en"] == m["creado_en"]
    assert editado["editado_en"] is not None
    assert editado["texto"] == "sin falta"


def test_borrar_una_raiz_con_respuestas_deja_lapida(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    raiz = cliente.post(ruta, json={"client_id": _cid(), "texto": "pregunta"},
                        headers=gente["ana"]["h"]).json()
    cliente.post(ruta, json={"client_id": _cid(), "texto": "respuesta", "responde_a": raiz["id"]},
                 headers=gente["beto"]["h"])
    r = cliente.delete(f"/api/team/messages/{raiz['id']}", headers=gente["ana"]["h"])
    # Borrarla de verdad dejaría la respuesta colgando de una pregunta que ya no
    # existe, o —peor— obligaría a borrar lo que escribió otro.
    assert r.status_code == 200
    assert r.json()["borrado_en"] is not None and r.json()["texto"] == ""
    assert r.json()["respuestas"] == 1


def test_borrar_un_mensaje_sin_respuestas_lo_borra_entero(cliente, gente, proyecto):
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    m = cliente.post(ruta, json={"client_id": _cid(), "texto": "suelto"},
                     headers=gente["ana"]["h"]).json()
    assert cliente.delete(f"/api/team/messages/{m['id']}",
                          headers=gente["ana"]["h"]).status_code == 204
    canal = cliente.get(f"{ruta}?limite=200", headers=gente["ana"]["h"]).json()["mensajes"]
    assert m["id"] not in [x["id"] for x in canal]


def test_un_mensaje_no_puede_quedarse_vacio_editando(cliente, gente, proyecto):
    m = cliente.post(f"/api/team/channels/{proyecto['general']}/messages",
                     json={"client_id": _cid(), "texto": "algo"},
                     headers=gente["ana"]["h"]).json()
    r = cliente.patch(f"/api/team/messages/{m['id']}", json={"texto": "   "},
                      headers=gente["ana"]["h"])
    assert r.status_code == 400


# ── Directos y presencia ───────────────────────────────────────────────────

def test_un_directo_es_idempotente_y_solo_con_relacionados(cliente, gente, proyecto):
    uno = cliente.post("/api/team/dms", json={"usuario_id": gente["beto"]["id"]},
                       headers=gente["ana"]["h"])
    dos = cliente.post("/api/team/dms", json={"usuario_id": gente["beto"]["id"]},
                       headers=gente["ana"]["h"])
    assert uno.json()["id"] == dos.json()["id"]
    assert uno.json()["con"]["id"] == gente["beto"]["id"]
    # Caro no comparte proyecto ni amistad: la barrera está en el servidor, no
    # en que la interfaz no enseñe el botón.
    assert cliente.post("/api/team/dms", json={"usuario_id": gente["caro"]["id"]},
                        headers=gente["ana"]["h"]).status_code == 403


def test_invisible_no_sale_nunca_del_servidor(cliente, gente, proyecto):
    """Regla 4 del transporte. Si la traducción viviera en el cliente, un
    cliente manipulado vería quién está escondido."""
    assert cliente.put("/api/team/presence", json={"estado": "invisible"},
                       headers=gente["ana"]["h"]).status_code == 200
    # A un tercero: desconectado.
    p = next(x for x in cliente.get("/api/team/bootstrap", headers=gente["beto"]["h"]).json()
             ["proyectos"] if x["id"] == proyecto["id"])
    ana = next(m for m in p["miembros"] if m["usuario"]["id"] == gente["ana"]["id"])
    assert ana["estado"] == "desconectado"
    # A su dueño, el real: es el único que puede saber que está invisible.
    assert cliente.get("/api/team/bootstrap", headers=gente["ana"]["h"]).json()["presencia"] \
        == "invisible"
    cliente.put("/api/team/presence", json={"estado": "en_linea"}, headers=gente["ana"]["h"])


def test_estado_desconocido_se_rechaza(cliente, gente):
    assert cliente.put("/api/team/presence", json={"estado": "de_fiesta"},
                       headers=gente["ana"]["h"]).status_code == 400


# ── WebSocket: replay y reparto ────────────────────────────────────────────

def test_el_replay_solo_manda_lo_que_falta(cliente, gente, proyecto):
    """Regla 2. Nunca el historial entero: solo lo que se perdió."""
    ruta = f"/api/team/channels/{proyecto['general']}/messages"
    corte = cliente.get(f"{ruta}?limite=1", headers=gente["ana"]["h"]).json()["mensajes"][0]["seq"]
    nuevo = cliente.post(ruta, json={"client_id": _cid(), "texto": "mientras no estaba"},
                         headers=gente["beto"]["h"]).json()

    with cliente.websocket_connect(f"/ws/team?token={gente['ana']['llave']}") as ws:
        ws.send_json({"tipo": "hola", "cursores": {proyecto["general"]: corte}})
        vistos = []
        while True:
            ev = ws.receive_json()
            if ev["tipo"] == "listo":
                break
            vistos.append(ev)
        assert ev["yo"]["id"] == gente["ana"]["id"]
        # Entre el replay puede colarse la presencia de quien acaba de
        # conectar: lo que importa es qué mensajes llegan.
        mensajes = [v for v in vistos if v["tipo"] == "mensaje"]
        assert nuevo["id"] in [v["mensaje"]["id"] for v in mensajes]
        assert all(v["mensaje"]["seq"] > corte for v in mensajes
                   if v["canal_id"] == proyecto["general"])


def test_el_mensaje_llega_a_los_demas_y_el_ack_al_autor(cliente, gente, proyecto):
    with cliente.websocket_connect(f"/ws/team?token={gente['beto']['llave']}") as ws_beto:
        ws_beto.send_json({"tipo": "hola", "cursores": {}})
        while ws_beto.receive_json()["tipo"] != "listo":
            pass
        with cliente.websocket_connect(f"/ws/team?token={gente['ana']['llave']}") as ws_ana:
            ws_ana.send_json({"tipo": "hola", "cursores": {}})
            while ws_ana.receive_json()["tipo"] != "listo":
                pass
            cid = _cid()
            cliente.post(f"/api/team/channels/{proyecto['general']}/messages",
                         json={"client_id": cid, "texto": "en vivo"}, headers=gente["ana"]["h"])

            ev = ws_beto.receive_json()
            while ev["tipo"] != "mensaje":
                ev = ws_beto.receive_json()
            assert ev["mensaje"]["texto"] == "en vivo"

            ack = ws_ana.receive_json()
            while ack["tipo"] != "mensaje_ack":
                ack = ws_ana.receive_json()
            # El ack lleva el client_id: es lo que deja al cliente casar el
            # mensaje optimista que ya pintó con el que confirmó el servidor.
            assert ack["client_id"] == cid


def test_el_ping_contesta_pong(cliente, gente):
    with cliente.websocket_connect(f"/ws/team?token={gente['ana']['llave']}") as ws:
        ws.send_json({"tipo": "ping"})
        ev = ws.receive_json()
        while ev["tipo"] != "pong":
            ev = ws.receive_json()
        assert ev["tipo"] == "pong"


def test_sin_llave_no_hay_socket(cliente):
    with pytest.raises(Exception):
        with cliente.websocket_connect("/ws/team?token=lixbon_sk_inventada") as ws:
            ws.receive_json()


def test_la_presencia_se_apaga_con_la_ultima_conexion(cliente, gente):
    uid = gente["caro"]["id"]
    with cliente.websocket_connect(f"/ws/team?token={gente['caro']['llave']}") as a:
        a.send_json({"tipo": "ping"})
        a.receive_json()
        with cliente.websocket_connect(f"/ws/team?token={gente['caro']['llave']}") as b:
            b.send_json({"tipo": "ping"})
            b.receive_json()
            assert hub.cuantas(uid) == 2
        # Cerrar una de dos no apaga a nadie: el IDE y la ventana de Team están
        # abiertos a la vez todos los días.
        assert hub.estado_real(uid) == "en_linea"
    assert hub.estado_real(uid) == "desconectado"


# ── El canje del IDE: las cuatro reglas ────────────────────────────────────

def _reto(verificador: str) -> str:
    d = hashlib.sha256(verificador.encode()).digest()
    return base64.urlsafe_b64encode(d).decode().rstrip("=")


def _conectar(cliente, **params):
    base = {"redirect_uri": "http://127.0.0.1:53127/callback", "state": "xyz",
            "challenge": _reto("verificador-secreto"), "method": "S256"}
    base.update(params)
    return cliente.get("/ide/connect", params=base)


def test_regla1_la_vuelta_solo_puede_ser_al_bucle_local(cliente):
    """Sin esto, cualquiera se lleva el token de un usuario a un servidor ajeno
    sin más que pasar su propia dirección."""
    for malo in ("https://malvado.example/callback", "http://malvado.example/callback",
                 "http://127.0.0.1:1/otra-cosa", "http://192.168.1.9/callback"):
        r = _conectar(cliente, redirect_uri=malo)
        assert r.status_code == 400, malo
        assert "vuelta" in r.text


def test_regla2_sin_challenge_no_se_emite_nada(cliente):
    assert _conectar(cliente, challenge="").status_code == 400
    assert _conectar(cliente, method="plain").status_code == 400


def test_sin_sesion_pide_entrar_y_con_sesion_pide_permiso(cliente, gente):
    assert "Inicia sesión" in _conectar(cliente).text
    r = cliente.post("/ide/connect/login",
                     params={"redirect_uri": "http://127.0.0.1:53127/callback", "state": "xyz",
                             "challenge": _reto("v"), "method": "S256"},
                     data={"email": "ana@lixbon.test", "password": "contraseña-larga"},
                     follow_redirects=False)
    assert r.status_code == 303
    assert "Conectar Lixbon IDE" in _conectar(cliente).text
    cliente.cookies.clear()


def _token_emitido(cliente, verificador: str) -> str:
    params = {"redirect_uri": "http://127.0.0.1:53127/callback", "state": "xyz",
              "challenge": _reto(verificador), "method": "S256"}
    cliente.post("/ide/connect/login", params=params,
                 data={"email": "ana@lixbon.test", "password": "contraseña-larga"},
                 follow_redirects=False)
    r = cliente.post("/ide/connect/authorize", params=params, follow_redirects=False)
    assert r.status_code == 303
    destino = r.headers["location"]
    assert destino.startswith("http://127.0.0.1:53127/callback?")
    assert "state=xyz" in destino
    cliente.cookies.clear()
    return destino.split("token=")[1].split("&")[0]


def test_regla3_el_token_es_de_un_solo_uso(cliente, gente):
    token = _token_emitido(cliente, "verificador-secreto")
    uno = cliente.post("/api/auth/ide/exchange",
                       json={"token": token, "verifier": "verificador-secreto"})
    assert uno.status_code == 200
    assert uno.json()["api_key"].startswith("lixbon_sk_")
    assert uno.json()["user"]["id"] == gente["ana"]["id"]
    # El segundo canje no vale aunque el verificador sea correcto.
    dos = cliente.post("/api/auth/ide/exchange",
                       json={"token": token, "verifier": "verificador-secreto"})
    assert dos.status_code == 400


def test_regla4_un_token_robado_no_sirve_sin_el_verificador(cliente):
    """Lo que hace inútil un token robado de la barra de direcciones: quien lo
    canjee tiene que conocer un secreto que nunca pasó por el navegador."""
    token = _token_emitido(cliente, "verificador-secreto")
    r = cliente.post("/api/auth/ide/exchange",
                     json={"token": token, "verifier": "me-lo-invento"})
    assert r.status_code == 400
    # Y el token se gastó igualmente: el intento fallido no deja nada servible.
    assert cliente.post("/api/auth/ide/exchange",
                        json={"token": token, "verifier": "verificador-secreto"}
                        ).status_code == 400


def test_la_llave_del_canje_revalida_en_api_auth_me(cliente):
    """`/api/auth/me` tiene que aceptar Bearer, o el IDE no puede revalidar la
    sesión al arrancar (sección 1 del contrato)."""
    token = _token_emitido(cliente, "otro-verificador")
    llave = cliente.post("/api/auth/ide/exchange",
                         json={"token": token, "verifier": "otro-verificador"}).json()["api_key"]
    r = cliente.get("/api/auth/me", headers={"Authorization": f"Bearer {llave}"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "ana@lixbon.test"
    # Y esa misma llave entra en Team sin más trámite: Team no tiene sesión
    # propia, usa la del IDE.
    assert cliente.get("/api/team/bootstrap",
                       headers={"Authorization": f"Bearer {llave}"}).status_code == 200
