"""Resolución de tarifas: sin comodín activo, un modelo sin precio no se cobra."""
import pytest
from fastapi import HTTPException

from core.billing import credits


def _tarifas(monkeypatch, rows):
    monkeypatch.setattr(credits, "_pricing_rows", lambda: rows)


def test_prefijo_mas_largo_gana(monkeypatch):
    _tarifas(monkeypatch, [
        {"model_prefix": "qwen3:", "input_microusd_per_mtok": 1, "output_microusd_per_mtok": 2},
        {"model_prefix": "qwen3:4b", "input_microusd_per_mtok": 3, "output_microusd_per_mtok": 4},
    ])
    assert credits.resolve_pricing("qwen3:4b")["input_microusd_per_mtok"] == 3
    assert credits.resolve_pricing("qwen3:8b")["input_microusd_per_mtok"] == 1


def test_sin_tarifa_publicada_no_se_cobra(monkeypatch):
    _tarifas(monkeypatch, [{"model_prefix": "qwen3.5:27b", "input_microusd_per_mtok": 1, "output_microusd_per_mtok": 2}])
    with pytest.raises(HTTPException) as exc:
        credits.resolve_pricing("gpt-oss:120b")
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "model_not_priced"


def test_comodin_activo_cubre_el_resto(monkeypatch):
    _tarifas(monkeypatch, [{"model_prefix": "*", "input_microusd_per_mtok": 5, "output_microusd_per_mtok": 6}])
    assert credits.resolve_pricing("lo-que-sea")["output_microusd_per_mtok"] == 6
