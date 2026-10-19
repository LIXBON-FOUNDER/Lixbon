"""A qué servicio se apunta el uso del panal (cli, ide, mobile, web u other)
y cómo se lee por día."""
import os
import pathlib
import tempfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_panal_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'panal.db').as_posix()}"

import pytest  # noqa: E402

from core.gateway.routers import chat as chat_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import TokenUsageDaily, TokenUsageServiceDaily, User  # noqa: E402
from core.security.acceso import servicio_de  # noqa: E402


@pytest.mark.parametrize("client,servicio", [
    ("web", "web"), ("cli", "cli"), ("desktop", "ide"), ("mobile", "mobile"), ("raro", "other"),
])
def test_una_sesion_cuenta_para_su_cliente(client, servicio):
    assert servicio_de({"auth_via": "session", "client": client}) == servicio


@pytest.mark.parametrize("key_name,servicio", [
    ("lixbon CLI", "cli"), ("Lixbon Desktop", "ide"), ("lixbon IDE", "ide"),
    ("lixbon mobile", "mobile"), ("mi script", "other"), (None, "other"),
])
def test_una_api_key_cuenta_por_su_nombre(key_name, servicio):
    assert servicio_de({"auth_via": "api_key", "key_name": key_name}) == servicio


def test_sin_credencial_es_other():
    assert servicio_de(None) == "other"


def test_cada_respuesta_suma_al_servicio(monkeypatch):
    apuntado = []
    monkeypatch.setattr(chat_mod, "record_service_usage", lambda uid, servicio, tokens: apuntado.append((uid, servicio, tokens)))
    monkeypatch.setattr(chat_mod, "record_model_usage", lambda *a, **kw: None)
    monkeypatch.setattr(chat_mod, "record_tokens", lambda *a, **kw: None)
    monkeypatch.setattr(chat_mod, "record_session_week_tokens", lambda *a, **kw: None)
    chat_mod._persist_assistant("c", "m", "hola", 120, 30, 5, user_id=7, save_history=False, service="cli")
    assert apuntado == [(7, "cli", 150)]


def test_el_panal_lee_por_dia_y_lo_de_antes_es_other():
    from datetime import datetime, timezone
    Base.metadata.create_all(get_engine())
    hoy = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with get_session() as s:
        s.add(User(id=1, username="panal", password_hash="x", created_at=q.now_iso()))
    with get_session() as s:
        # Antes de contar por servicio: solo el total del día.
        s.add(TokenUsageDaily(user_id=1, usage_date="2000-01-01", model="m", prompt_tokens=0, completion_tokens=0,
                              total_tokens=999, latency_sum_ms=0, request_count=1, created_at=q.now_iso()))
        s.add(TokenUsageDaily(user_id=1, usage_date=hoy, model="m", prompt_tokens=0, completion_tokens=0,
                              total_tokens=500, latency_sum_ms=0, request_count=2, created_at=q.now_iso()))
        s.add(TokenUsageServiceDaily(user_id=1, usage_date=hoy, service="cli", total_tokens=300, request_count=1, created_at=q.now_iso()))
        s.add(TokenUsageServiceDaily(user_id=1, usage_date=hoy, service="mobile", total_tokens=150, request_count=1, created_at=q.now_iso()))
    filas = q.get_service_usage(1, days=30)
    assert filas == [
        {"date": hoy, "service": "cli", "tokens": 300},
        {"date": hoy, "service": "mobile", "tokens": 150},
        {"date": hoy, "service": "other", "tokens": 50},
    ]
