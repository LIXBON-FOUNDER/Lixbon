"""Sesiones por dispositivo: access corto, refresh rotatorio y token legacy.

SQLite temporal: DATABASE_URL se fija ANTES de importar core.config, que la lee
en el import. El engine es global, así que este módulo no debe convivir en el
mismo proceso con pruebas que necesiten la BD real.
"""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_sesiones_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'sesiones.db').as_posix()}"

import pytest  # noqa: E402
from sqlalchemy import update  # noqa: E402

from core.persistence import models, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _schema():
    # create_all y no init_db: sus migraciones son sintaxis Postgres.
    Base.metadata.create_all(get_engine())
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def _nuevo_usuario() -> int:
    with get_session() as s:
        u = models.User(username=f"u{os.urandom(4).hex()}@t", password_hash="x", created_at=q.now_iso())
        s.add(u)
        s.flush()
        return u.id


@pytest.fixture()
def uid():
    return _nuevo_usuario()


def _hace(**delta):
    return q._iso_in(**{k: -v for k, v in delta.items()})


def _fijar(session_id, **valores):
    with get_session() as s:
        s.execute(update(models.Session).where(models.Session.id == session_id).values(**valores))


def test_sesion_nueva_entrega_access_y_refresh(uid):
    t = q.create_device_session(uid, "desktop", device_name="PC de casa")
    assert t["access_token"].startswith("lixbon_at_")
    assert t["refresh_token"].startswith("lixbon_rt_")
    u = q.validate_access_token(t["access_token"])
    assert u["id"] == uid
    assert u["auth_via"] == "session" and u["client"] == "desktop"
    assert u["session_id"] == t["session_id"] and u["legacy"] is False


def test_cliente_desconocido_se_rechaza(uid):
    with pytest.raises(ValueError):
        q.create_device_session(uid, "web")


def test_access_caducado_no_vale(uid):
    t = q.create_device_session(uid, "cli")
    _fijar(t["session_id"], expires_at=_hace(seconds=1))
    assert q.validate_access_token(t["access_token"]) is None


def test_rotar_invalida_el_par_anterior(uid):
    t1 = q.create_device_session(uid, "mobile")
    t2 = q.rotate_refresh(t1["refresh_token"])
    assert t2["session_id"] == t1["session_id"] and t2["user"]["id"] == uid
    assert t2["refresh_token"] != t1["refresh_token"]
    assert q.validate_access_token(t1["access_token"]) is None
    assert q.validate_access_token(t2["access_token"])["id"] == uid


def test_refresh_anterior_dentro_de_la_gracia_no_revoca(uid):
    t1 = q.create_device_session(uid, "desktop")
    t2 = q.rotate_refresh(t1["refresh_token"])
    with pytest.raises(q.RefreshRace):
        q.rotate_refresh(t1["refresh_token"])
    assert q.validate_access_token(t2["access_token"]) is not None


def test_refresh_anterior_fuera_de_la_gracia_revoca_la_sesion(uid):
    t1 = q.create_device_session(uid, "desktop")
    t2 = q.rotate_refresh(t1["refresh_token"])
    _fijar(t2["session_id"], rotated_at=_hace(seconds=q.REFRESH_REUSE_GRACE_SECONDS + 1))
    assert q.rotate_refresh(t1["refresh_token"]) is None
    assert q.validate_access_token(t2["access_token"]) is None
    assert q.rotate_refresh(t2["refresh_token"]) is None


def test_refresh_caducado_no_rota(uid):
    t = q.create_device_session(uid, "cli")
    _fijar(t["session_id"], refresh_expires_at=_hace(seconds=1))
    assert q.rotate_refresh(t["refresh_token"]) is None


def test_refresh_desconocido(uid):
    assert q.rotate_refresh("lixbon_rt_inventado") is None
    assert q.rotate_refresh("") is None


def test_cada_dispositivo_tiene_su_sesion(uid):
    a = q.create_device_session(uid, "desktop", device_name="casa")
    b = q.create_device_session(uid, "desktop", device_name="oficina")
    assert q.validate_access_token(a["access_token"]) is not None
    assert q.validate_access_token(b["access_token"]) is not None


def test_legacy_sin_refresh_y_uno_por_app(uid):
    normal = q.create_device_session(uid, "desktop")
    a = q.create_device_session(uid, "desktop", legacy=True)
    movil = q.create_device_session(uid, "mobile", legacy=True)
    assert a["refresh_token"] is None
    assert q.validate_access_token(a["access_token"])["legacy"] is True

    b = q.create_device_session(uid, "desktop", legacy=True)
    assert q.validate_access_token(a["access_token"]) is None
    assert q.validate_access_token(b["access_token"]) is not None
    assert q.validate_access_token(movil["access_token"]) is not None
    assert q.validate_access_token(normal["access_token"]) is not None


def test_cookie_web_y_access_no_se_cruzan(uid):
    web = q.create_web_session(uid)
    t = q.create_device_session(uid, "desktop")
    assert q.validate_web_session(web)["client"] == "web"
    assert q.validate_access_token(web) is None
    assert q.validate_web_session(t["access_token"]) is None


def test_purga_conserva_sesiones_con_refresh_vigente(uid):
    viva = q.create_device_session(uid, "desktop")
    _fijar(viva["session_id"], expires_at=_hace(minutes=1))
    muerta = q.create_device_session(uid, "cli")
    _fijar(muerta["session_id"], refresh_expires_at=_hace(seconds=1))
    legacy = q.create_device_session(uid, "mobile", legacy=True)
    _fijar(legacy["session_id"], expires_at=_hace(seconds=1))

    q.purge_expired_sessions()
    with get_session() as s:
        assert s.get(models.Session, muerta["session_id"]) is None
        assert s.get(models.Session, legacy["session_id"]) is None
    assert q.rotate_refresh(viva["refresh_token"]) is not None


def test_logout_con_refresh_o_con_access(uid):
    a = q.create_device_session(uid, "cli")
    assert q.revoke_session_token(a["refresh_token"])["id"] == a["session_id"]
    assert q.validate_access_token(a["access_token"]) is None

    b = q.create_device_session(uid, "cli")
    assert q.revoke_session_token(b["access_token"])["client"] == "cli"
    assert q.rotate_refresh(b["refresh_token"]) is None
    assert q.revoke_session_token("lixbon_at_inventado") is None


def test_revocar_las_demas_conserva_la_actual(uid):
    actual = q.create_device_session(uid, "desktop")
    otra = q.create_device_session(uid, "mobile")
    web = q.create_web_session(uid)
    assert q.revoke_other_sessions(uid, keep_session_id=actual["session_id"]) == 2
    assert q.validate_access_token(actual["access_token"]) is not None
    assert q.validate_access_token(otra["access_token"]) is None
    assert q.validate_web_session(web) is None


def test_no_se_revoca_la_sesion_de_otro(uid):
    ajena = q.create_device_session(_nuevo_usuario(), "desktop")
    assert q.revoke_session(ajena["session_id"], uid) is False
    assert q.validate_access_token(ajena["access_token"]) is not None


def test_lista_de_sesiones(uid):
    t = q.create_device_session(uid, "cli", device_name="portátil")
    caducada = q.create_device_session(uid, "cli")
    _fijar(caducada["session_id"], refresh_expires_at=_hace(seconds=1))
    sesiones = {x["id"]: x for x in q.list_user_sessions(uid)}
    assert sesiones[t["session_id"]]["device_name"] == "portátil"
    assert caducada["session_id"] not in sesiones


def test_usuario_bloqueado_no_valida_ni_rota(uid):
    t = q.create_device_session(uid, "desktop")
    with get_session() as s:
        s.execute(update(models.User).where(models.User.id == uid).values(is_active=0))
    assert q.validate_access_token(t["access_token"]) is None
    assert q.rotate_refresh(t["refresh_token"]) is None


def test_cupo_de_keys_cuenta_solo_las_manuales(uid):
    q.create_api_key("lixbon Desktop", uid, origin="login")
    q.create_api_key("Default Key - x", uid, origin="login_compat")
    assert q.count_active_keys(uid) == 0
    q.create_api_key("Mi script", uid)
    assert q.count_active_keys(uid) == 1
    assert {k["origin"] for k in q.list_api_keys(uid)} == {"login", "login_compat", "manual"}
