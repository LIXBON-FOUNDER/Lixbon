"""
"Regenerar" de la app: rewind_last_turn quita el último mensaje del usuario y
lo que lo sigue, para que el gateway lo vuelva a guardar sin duplicarlo.
SQLite temporal.
"""
import os
import pathlib
import shutil
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_rewind_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'rewind.db').as_posix()}"

import pytest  # noqa: E402

from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _esquema():
    Base.metadata.create_all(get_engine())
    yield
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


def _usuario(correo):
    return q.create_user(correo, "contraseña-larga", "Prueba", "Rewind")["id"]


def _roles(conv_id, user_id):
    return [(m["role"], m["content"]) for m in q.list_messages(conv_id, user_id)]


def test_quita_el_ultimo_turno_completo():
    uid = _usuario("rewind_a@test.local")
    assert q.ensure_conversation("conv-a", uid, None, None, source="mobile")
    for rol, texto in [("user", "uno"), ("assistant", "r1"), ("user", "dos"), ("assistant", "r2")]:
        q.save_message("conv-a", rol, texto, record_usage=False)

    assert q.rewind_last_turn("conv-a", uid) == 2
    assert _roles("conv-a", uid) == [("user", "uno"), ("assistant", "r1")]


def test_respuesta_cortada_sin_asistente():
    uid = _usuario("rewind_b@test.local")
    assert q.ensure_conversation("conv-b", uid, None, None, source="mobile")
    q.save_message("conv-b", "user", "hola", record_usage=False)

    assert q.rewind_last_turn("conv-b", uid) == 1
    assert _roles("conv-b", uid) == []
    assert q.rewind_last_turn("conv-b", uid) == 0


def test_conversacion_ajena():
    dueno = _usuario("rewind_c@test.local")
    otro = _usuario("rewind_d@test.local")
    assert q.ensure_conversation("conv-c", dueno, None, None, source="mobile")
    q.save_message("conv-c", "user", "privado", record_usage=False)

    assert q.rewind_last_turn("conv-c", otro) is None
    assert _roles("conv-c", dueno) == [("user", "privado")]
