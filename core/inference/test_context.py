from core.inference.context import estimate_tokens, fit_messages


def _msg(role, n):
    return {"role": role, "content": "x" * n}


def test_si_cabe_no_toca_nada():
    msgs = [_msg("system", 100), _msg("user", 300), _msg("assistant", 300), _msg("user", 50)]
    assert fit_messages(msgs, 4096) is msgs


def test_recorta_los_antiguos_y_conserva_system_y_el_ultimo():
    msgs = [_msg("system", 300)] + [_msg("user", 3000), _msg("assistant", 3000)] * 5 + [_msg("user", 100)]
    out = fit_messages(msgs, 4096)
    assert out[0]["role"] == "system"
    assert out[-1] is msgs[-1]
    assert len(out) < len(msgs)
    assert estimate_tokens(out) <= 4096 - 1638


def test_el_ultimo_mensaje_se_manda_aunque_no_quepa():
    msgs = [_msg("user", 100), _msg("assistant", 100), _msg("user", 50000)]
    out = fit_messages(msgs, 4096)
    assert out == [msgs[-1]]


def test_no_deja_un_tool_huerfano_al_principio():
    msgs = [
        _msg("user", 3000),
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "x" * 3000},
        _msg("user", 10),
    ]
    out = fit_messages(msgs, 3000)
    assert out[0]["role"] != "tool"


# ── num_ctx global ───────────────────────────────────────────────────────────
from core import config
from core.inference.roles import context_length_of, resolve_num_ctx

CATALOGO = [{"id": "qwen3.5:4b", "context_length": 262144}, {"id": "phi:latest"}]


def test_prioridad_peticion_rol_global(monkeypatch):
    monkeypatch.setattr(config, "MODEL_NUM_CTX", "16384")
    assert resolve_num_ctx(2048, 8192, CATALOGO, "qwen3.5:4b") == 2048
    assert resolve_num_ctx(None, 8192, CATALOGO, "qwen3.5:4b") == 8192
    assert resolve_num_ctx(None, None, CATALOGO, "qwen3.5:4b") == 16384


def test_global_se_recorta_a_la_maxima_del_modelo(monkeypatch):
    monkeypatch.setattr(config, "MODEL_NUM_CTX", "1000000")
    assert resolve_num_ctx(None, None, CATALOGO, "qwen3.5:4b") == 262144
    assert resolve_num_ctx(None, None, CATALOGO, "phi") == 1000000   # máxima desconocida


def test_global_max_y_vacio(monkeypatch):
    monkeypatch.setattr(config, "MODEL_NUM_CTX", "max")
    assert resolve_num_ctx(None, None, CATALOGO, "qwen3.5:4b") == 262144
    assert resolve_num_ctx(None, None, CATALOGO, "phi") is None
    monkeypatch.setattr(config, "MODEL_NUM_CTX", "")
    assert resolve_num_ctx(None, None, CATALOGO, "qwen3.5:4b") is None
    assert context_length_of(CATALOGO, "phi") is None
    assert context_length_of([{"id": "m:latest", "context_length": 8192}], "m") == 8192
