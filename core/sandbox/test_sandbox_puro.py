"""Piezas puras de Coding: proxy git, alcance del token y `docker run`."""
import gzip

import pytest

from core.sandbox.alcance import sesion_permitida
from core.sandbox.git_proxy import PushRechazado, ruta_github, validar_push
from core.sandbox import git_proxy, runner
from core.sandbox.runner import Arranque, argumentos_run, entorno_contenedor

SID = "0123456789ab"
CERO = "0" * 40
A = "a" * 40


def _pkt(linea: str) -> bytes:
    datos = linea.encode()
    return f"{len(datos) + 4:04x}".encode() + datos


def _push(*refs: str, viejo: str = CERO, nuevo: str = A) -> bytes:
    lineas = [_pkt(f"{viejo} {nuevo} {refs[0]}\0report-status side-band-64k\n")]
    lineas += [_pkt(f"{viejo} {nuevo} {r}\n") for r in refs[1:]]
    return b"".join(lineas) + b"0000PACK...."


# ---------------------------------------------------------------- proxy git

def test_push_a_rama_lixbon_pasa():
    assert validar_push(_push("refs/heads/lixbon/carrito-descuentos")) == ["refs/heads/lixbon/carrito-descuentos"]


@pytest.mark.parametrize("ref", ["refs/heads/main", "refs/heads/master", "refs/tags/v1", "refs/heads/lixbonx",
                                 "refs/heads/lixbon/", "refs/heads/lixbon/../main", "refs/heads/feature/x"])
def test_push_fuera_de_lixbon_se_rechaza(ref):
    with pytest.raises(PushRechazado):
        validar_push(_push(ref))


def test_un_push_con_varias_ramas_se_rechaza_si_una_no_es_lixbon():
    with pytest.raises(PushRechazado):
        validar_push(_push("refs/heads/lixbon/a", "refs/heads/main"))


def test_borrar_main_tambien_se_rechaza():
    with pytest.raises(PushRechazado):
        validar_push(_push("refs/heads/main", viejo=A, nuevo=CERO))


def test_push_comprimido_se_inspecciona():
    assert validar_push(gzip.compress(_push("refs/heads/lixbon/x")), gzip_encoded=True)
    with pytest.raises(PushRechazado):
        validar_push(gzip.compress(_push("refs/heads/main")), gzip_encoded=True)


def test_push_comprimido_supera_el_limite_o_esta_truncado(monkeypatch):
    cuerpo = _push("refs/heads/lixbon/x")
    with pytest.raises(PushRechazado, match="no válido"):
        validar_push(gzip.compress(cuerpo)[:-4], gzip_encoded=True)
    monkeypatch.setattr(git_proxy, "MAX_PUSH", len(cuerpo))
    with pytest.raises(PushRechazado, match="descomprimido"):
        validar_push(gzip.compress(cuerpo + b"x"), gzip_encoded=True)


@pytest.mark.parametrize("cuerpo", [b"", b"zzzz", b"0000", b"0009abc", b"ffff"])
def test_push_mal_formado_se_rechaza(cuerpo):
    with pytest.raises(PushRechazado):
        validar_push(cuerpo)


def test_ruta_github_solo_servicios_git_y_repos_validos():
    assert ruta_github("a/b", "info/refs") == "https://github.com/a/b.git/info/refs"
    for repo, resto in [("a/b", "../x"), ("a/b/../c", "info/refs"), ("evil.com/x?", "info/refs")]:
        with pytest.raises(ValueError):
            ruta_github(repo, resto)


# ---------------------------------------------------------------- alcance

@pytest.mark.parametrize("metodo,ruta,esperado", [
    ("POST", "/v1/chat/completions", "*"),
    ("GET", "/v1/models", "*"),
    ("GET", f"/api/remote/sessions/{SID}/commands", SID),
    ("POST", f"/api/remote/sessions/{SID}/events", SID),
    ("WS", f"/api/remote/sessions/{SID}/host", SID),
    ("PUT", f"/api/remote/sessions/{SID}/images/abc.png", SID),
    ("POST", f"/api/coding/sessions/{SID}/host", SID),
    ("GET", f"/api/coding/sessions/{SID}/git/info/refs", SID),
    ("POST", f"/api/coding/sessions/{SID}/git/git-receive-pack", SID),
    # Lado del mando: el agente no puede aprobarse a sí mismo ni leer otras cosas.
    ("POST", f"/api/remote/sessions/{SID}/commands", None),
    ("GET", f"/api/remote/sessions/{SID}/stream", None),
    ("WS", f"/api/remote/sessions/{SID}/ws", None),
    ("GET", f"/api/coding/sessions/{SID}/preview/5173/", None),
    ("POST", "/api/coding/sessions", None),
    ("GET", "/api/conversations", None),
    ("GET", "/api/remote/sessions", None),
    ("GET", "/api/connectors/github/repos", None),
    ("POST", "/v1/chat/completions/../../api/keys", None),
])
def test_alcance_por_ruta_y_metodo(metodo, ruta, esperado):
    assert sesion_permitida(ruta, metodo) == esperado


# ---------------------------------------------------------------- docker run

def _arranque(**kw):
    base = dict(session_id=SID, user_id=7, token="lixbon_ct_secreto", repo="a/b",
                default_branch="main", mode="manual", model=None)
    return Arranque(**{**base, **kw})


def test_docker_run_endurecido():
    args = argumentos_run(_arranque())
    plano = " ".join(args)
    for esperado in ("--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--user 1000:1000",
                     "--pids-limit", "--memory", f"--network lixbon-net-{SID}", f"lixbon-ws-{SID}:/workspace"):
        assert esperado in plano, esperado
    assert "docker.sock" not in plano
    assert "--privileged" not in plano
    assert "-p" not in args  # nada publicado: la vista previa entra por el proxy de entrada


def test_el_entorno_no_lleva_token_de_github():
    env = entorno_contenedor(_arranque())
    assert env["LIXBON_SESSION_TOKEN"] == "lixbon_ct_secreto"
    assert env["HTTPS_PROXY"].startswith("http://lixbon-egress")
    assert not any(v.startswith(("ghu_", "ghp_", "gho_")) for v in env.values())
    assert not any("GITHUB" in k for k in env)


def test_id_de_sesion_raro_no_llega_a_docker():
    with pytest.raises(ValueError):
        argumentos_run(_arranque(session_id="x; rm -rf /"))


def test_clave_del_ingress_estable_entre_arranques(monkeypatch):
    from core.sandbox import runner as r
    monkeypatch.delenv("CODING_INGRESS_SECRET", raising=False)
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", "clave-de-prueba")
    a, b = r.DockerRunner().ingress_secret, r.DockerRunner().ingress_secret
    assert a == b and "clave-de-prueba" not in a
    monkeypatch.setenv("CONNECTORS_SECRET_KEY", "otra")
    assert r.DockerRunner().ingress_secret != a


def test_recursos_etiquetados_con_el_origen(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///uno.db")
    uno = runner.origen()
    args = runner.argumentos_run(runner.Arranque("abcdef012345", 7, "t", "a/b", "main", "manual", None))
    assert f"lixbon.origen={uno}" in args
    monkeypatch.setenv("DATABASE_URL", "sqlite:///otro.db")
    assert runner.origen() != uno  # otro gateway con otra BD no toca estos recursos


def test_sid_de_los_nombres_de_docker():
    assert runner._sid_de("lixbon-sbx-abcdef012345\n") == "abcdef012345"
    assert runner._sid_de("lixbon-ws-abcdef012345") == "abcdef012345"
    assert runner._sid_de("lixbon-egress") is None
    assert runner._sid_de("otra-cosa-ABCDEF012345") is None
