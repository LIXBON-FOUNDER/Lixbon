"""La entrada que sale de la caché KV se cobra a CACHED_INPUT_FACTOR."""
from core.billing import credits, quota

PESO = {"input_credits_per_mtok": 1_000_000, "output_credits_per_mtok": 4_000_000}
TARIFA = {"input_microusd_per_mtok": 1_000_000, "output_microusd_per_mtok": 4_000_000}


def test_creditos_descuentan_la_cache(monkeypatch):
    monkeypatch.setattr(quota, "CACHED_INPUT_FACTOR", 0.1)
    assert quota.compute_credit_cost(PESO, 10_000, 1_000) == 14_000
    # 9.000 de los 10.000 de entrada ya estaban en caché: 1.000 + 900 + 4.000.
    assert quota.compute_credit_cost(PESO, 10_000, 1_000, 9_000) == 5_900
    # Un cached mayor que la entrada no da coste negativo.
    assert quota.compute_credit_cost(PESO, 100, 0, 5_000) == 10


def test_saldo_api_descuenta_la_cache(monkeypatch):
    monkeypatch.setattr(credits, "CACHED_INPUT_FACTOR", 0.1)
    assert credits.compute_cost_microusd(TARIFA, 10_000, 1_000) == 14_000
    assert credits.compute_cost_microusd(TARIFA, 10_000, 1_000, 9_000) == 5_900
