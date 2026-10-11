"""La ventana de sesión (4 h) arranca con el primer mensaje, no al consultar la cuota."""
from datetime import datetime, timedelta, timezone

import pytest

from core.billing import quota

POLICY = {"session_window_hours": 4.0, "session_base_credits": 100, "week_base_credits": 1000}
PLAN = {"name": "Pro", "session_credit_multiplier": 1.0, "week_credit_multiplier": 1.0}


@pytest.fixture
def ventanas(monkeypatch):
    rows: list[dict] = []
    reloj = {"now": datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)}

    def latest(user_id, bucket):
        mine = [r for r in rows if r["bucket"] == bucket]
        return dict(mine[-1]) if mine else None

    def get_or_create(user_id, bucket, period_key, started_at, expires_at):
        for r in rows:
            if r["bucket"] == bucket and r["period_key"] == period_key:
                return dict(r)
        row = {"bucket": bucket, "period_key": period_key, "started_at": started_at,
               "expires_at": expires_at, "credits_used": 0, "messages": 0}
        rows.append(row)
        return dict(row)

    def bump(user_id, bucket, period_key, started_at, expires_at, credits_inc=0, messages_inc=0):
        row = next(r for r in rows if r["bucket"] == bucket and r["period_key"] == period_key)
        row["credits_used"] += credits_inc
        row["messages"] += messages_inc
        return dict(row)

    monkeypatch.setattr(quota, "_now", lambda: reloj["now"])
    monkeypatch.setattr(quota, "get_latest_credit_window", latest)
    monkeypatch.setattr(quota, "get_or_create_credit_window", get_or_create)
    monkeypatch.setattr(quota, "bump_credit_window", bump)
    monkeypatch.setattr(quota, "get_usage_policy", lambda: POLICY)
    monkeypatch.setattr(quota, "get_week_anchor_slot", lambda user_id: 0)
    monkeypatch.setattr(quota, "resolve_model_weight", lambda model: {
        "input_credits_per_mtok": 1_000_000, "output_credits_per_mtok": 1_000_000})
    return rows, reloj


def _sesiones(rows):
    return [r for r in rows if r["bucket"] == "session"]


def test_consultar_la_cuota_no_pone_el_reloj_en_marcha(ventanas):
    rows, _ = ventanas
    snap = quota.credit_buckets_snapshot(1, PLAN)
    assert snap["session"]["percent"] == 0
    assert snap["session"]["reset_at"] is None
    assert _sesiones(rows) == []


def test_el_reloj_empieza_con_el_primer_mensaje(ventanas):
    rows, reloj = ventanas
    quota.credit_buckets_snapshot(1, PLAN)
    reloj["now"] += timedelta(hours=2)
    quota.ensure_session_week_credits(1, PLAN)
    quota.record_session_week_tokens(1, "qwen", 10, 10)
    (sesion,) = _sesiones(rows)
    assert sesion["started_at"] == reloj["now"].isoformat()
    assert sesion["expires_at"] == (reloj["now"] + timedelta(hours=4)).isoformat()
    assert quota.credit_buckets_snapshot(1, PLAN)["session"]["reset_at"] == sesion["expires_at"]


def test_los_mensajes_siguientes_no_mueven_el_reinicio(ventanas):
    rows, reloj = ventanas
    quota.ensure_session_week_credits(1, PLAN)
    quota.record_session_week_tokens(1, "qwen", 10, 10)
    primero = _sesiones(rows)[0]["expires_at"]
    reloj["now"] += timedelta(hours=1)
    quota.ensure_session_week_credits(1, PLAN)
    quota.record_session_week_tokens(1, "qwen", 10, 10)
    assert len(_sesiones(rows)) == 1
    assert _sesiones(rows)[0]["expires_at"] == primero


def test_una_ventana_abierta_sin_consumo_se_reabre_con_el_siguiente_mensaje(ventanas):
    rows, reloj = ventanas
    quota.ensure_session_week_credits(1, PLAN)
    reloj["now"] += timedelta(minutes=30)
    quota.ensure_session_week_credits(1, PLAN)
    assert _sesiones(rows)[-1]["started_at"] == reloj["now"].isoformat()


def test_al_caducar_la_sesion_vuelve_a_cero_sin_reinicio(ventanas):
    rows, reloj = ventanas
    quota.ensure_session_week_credits(1, PLAN)
    quota.record_session_week_tokens(1, "qwen", 10, 10)
    reloj["now"] += timedelta(hours=5)
    snap = quota.credit_buckets_snapshot(1, PLAN)["session"]
    assert snap["percent"] == 0 and snap["reset_at"] is None
