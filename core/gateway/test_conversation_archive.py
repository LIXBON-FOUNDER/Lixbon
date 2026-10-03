"""
Historial del IDE: las conversaciones sin archivar caducan a los 14 días sin
actividad; las archivadas y las de otras superficies no. SQLite temporal.
"""
import os
import pathlib
import shutil
import tempfile
from datetime import datetime, timedelta, timezone

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_archive_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'archive.db').as_posix()}"

import pytest  # noqa: E402
from sqlalchemy import update  # noqa: E402

from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Conversation  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    Base.metadata.create_all(get_engine())
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def _usuario(correo):
    return q.create_user(correo, "contraseña-larga", "Prueba", "Archivo")["id"]


def _conv(conv_id, uid, source, dias):
    assert q.ensure_conversation(conv_id, uid, None, None, source=source)
    q.save_message(conv_id, "user", "hola", record_usage=False)
    ts = (datetime.now(timezone.utc) - timedelta(days=dias)).isoformat()
    with get_session() as s:
        s.execute(update(Conversation).where(Conversation.id == conv_id).values(updated_at=ts))


def _ids(uid, **kw):
    return {c["id"] for c in q.list_conversations(uid, **kw)}


def test_purga_solo_ide_inactivas_sin_archivar():
    uid = _usuario("archive_a@test.local")
    _conv("ide-vieja", uid, "ide", 20)
    _conv("ide-archivada", uid, "ide", 20)
    _conv("ide-reciente", uid, "ide", 3)
    _conv("web-vieja", uid, "web", 20)
    assert q.set_conversation_archived("ide-archivada", uid, True)

    assert q.purge_inactive_conversations(uid, "ide", 14) == 1
    assert _ids(uid, source="ide") == {"ide-archivada", "ide-reciente"}
    assert _ids(uid, source="web") == {"web-vieja"}
    assert q.list_messages("ide-vieja", uid) is None


def test_filtro_archivadas_y_desarchivar():
    uid = _usuario("archive_b@test.local")
    _conv("b-1", uid, "ide", 0)
    _conv("b-2", uid, "ide", 0)
    assert q.set_conversation_archived("b-2", uid, True)

    assert _ids(uid, source="ide", archived=True) == {"b-2"}
    assert _ids(uid, source="ide", archived=False) == {"b-1"}
    assert q.set_conversation_archived("b-2", uid, False)
    assert _ids(uid, source="ide", archived=True) == set()


def test_desarchivar_vieja_no_la_purga():
    uid = _usuario("archive_e@test.local")
    _conv("e-1", uid, "ide", 30)
    assert q.set_conversation_archived("e-1", uid, True)
    assert q.set_conversation_archived("e-1", uid, False)
    assert q.purge_inactive_conversations(uid, "ide", 14) == 0
    assert _ids(uid, source="ide") == {"e-1"}


def test_no_archiva_ajenas():
    dueno = _usuario("archive_c@test.local")
    otro = _usuario("archive_d@test.local")
    _conv("c-1", dueno, "ide", 0)
    assert not q.set_conversation_archived("c-1", otro, True)
    assert q.get_conversation("c-1", dueno)["archived"] is False
