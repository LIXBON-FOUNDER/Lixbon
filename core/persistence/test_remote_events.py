"""Tests del transcript persistido de las sesiones /remote.

Usan un SQLite temporal: DATABASE_URL se fija ANTES de importar core.config,
que la lee en el import. El engine es global y perezoso, así que este módulo
no debe convivir con tests que necesiten la BD real.
"""
import os
import pathlib
import shutil
import tempfile

# Carpeta propia y no un nombre derivado del PID: Windows los recicla, y una
# ejecución anterior que no llegara a borrar su fichero dejaba filas dentro
# (los tests que cuentan eventos fallaban de forma intermitente).
_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_remote_"))
_DB_PATH = _DB_DIR / "remote.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH.as_posix()}"

import pytest  # noqa: E402

from core.persistence import models, queries as q  # noqa: E402
from core.persistence.database import Base, get_engine  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _schema():
    # create_all y no init_db: sus migraciones son sintaxis Postgres.
    Base.metadata.create_all(get_engine())
    yield
    # En Windows el fichero sigue bloqueado mientras el pool tenga conexiones.
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture()
def user_id():
    with q.get_session() as s:
        user = models.User(
            username=f"u{os.urandom(4).hex()}@t", password_hash="x", created_at=q.now_iso()
        )
        s.add(user)
        s.flush()
        return user.id


@pytest.fixture()
def session_id(user_id):
    _, sess = q.create_remote_session(user_id, "cli", "workspace", "host")
    return sess["id"]


def test_solo_persiste_los_eventos_del_transcript(session_id):
    """Los deltas y el estado son efímeros: se relayan pero no se guardan."""
    q.save_remote_events(session_id, [
        {"type": "hello", "seq": 1, "source": "cli"},
        {"type": "user_msg", "seq": 2, "text": "hola"},
        {"type": "assistant_delta", "seq": 3, "text": "ho"},
        {"type": "status", "seq": 4, "state": "thinking"},
        {"type": "assistant_done", "seq": 5, "text": "hola, ¿qué tal?"},
    ])
    tipos = [ev["type"] for ev in q.list_remote_events(session_id)]
    assert tipos == ["hello", "user_msg", "assistant_done"]


def test_el_transcript_sobrevive_al_fin_de_la_sesion(session_id, user_id):
    q.save_remote_events(session_id, [{"type": "user_msg", "seq": 1, "text": "hola"}])
    q.end_remote_session(session_id)

    assert [s["status"] for s in q.list_remote_sessions(user_id)] == ["ended"]
    assert [ev["text"] for ev in q.list_remote_events(session_id)] == ["hola"]
    assert q.count_remote_events(user_id) == {session_id: 1}


def test_replay_incremental_desde_un_seq(session_id):
    q.save_remote_events(session_id, [
        {"type": "user_msg", "seq": n, "text": f"m{n}"} for n in range(1, 6)
    ])
    assert [ev["seq"] for ev in q.list_remote_events(session_id, from_seq=3)] == [4, 5]


def test_los_textos_enormes_se_recortan_sin_romper_el_json(session_id):
    q.save_remote_events(session_id, [
        {"type": "tool_result", "seq": 1, "tool": "read_file", "result": "z" * 50000},
        {"type": "snapshot", "seq": 2, "messages": [{"role": "user", "content": "y" * 30000}]},
    ])
    guardados = q.list_remote_events(session_id)
    assert len(guardados) == 2
    assert len(guardados[0]["result"]) <= q.REMOTE_MAX_FIELD_CHARS + 1
    assert len(guardados[1]["messages"][0]["content"]) <= q.REMOTE_MAX_FIELD_CHARS + 1


def test_el_tope_por_sesion_conserva_los_ultimos(session_id, monkeypatch):
    """En una sesión larga lo que se quiere releer es el final."""
    monkeypatch.setattr(q, "REMOTE_MAX_EVENTS", 10)
    for n in range(1, 26):
        q.save_remote_events(session_id, [{"type": "user_msg", "seq": n, "text": f"m{n}"}])
    assert [ev["seq"] for ev in q.list_remote_events(session_id)] == list(range(16, 26))
