"""Si el modelo del rol vision no está en ningún nodo, vale otro que vea."""
import core.gateway.routers.chat as chat
from core.gateway import deps
from core.orchestration.orchestrator import ModelUnavailable


class _Orq:
    def __init__(self, servidos):
        self.servidos = servidos

    def ollama_target(self, model, strict=False):
        if model in self.servidos:
            return ("node://x", {}, "gpu-1")
        raise ModelUnavailable(model, ["gpu-1"])


CATALOGO = [
    {"id": "moondream", "capabilities": ["vision"]},
    {"id": "qwen3.5:27b", "capabilities": ["tools", "vision", "completion"]},
    {"id": "qwen3:8b", "capabilities": ["tools"]},
]


def test_prefiere_el_del_rol_si_esta_servido(monkeypatch):
    monkeypatch.setattr(deps, "orquestador", _Orq({"moondream", "qwen3.5:27b"}))
    assert chat.available_vision_model("moondream", CATALOGO) == "moondream"


def test_cae_a_otro_modelo_con_vision(monkeypatch):
    monkeypatch.setattr(deps, "orquestador", _Orq({"qwen3.5:27b", "qwen3:8b"}))
    assert chat.available_vision_model("moondream", CATALOGO) == "qwen3.5:27b"


def test_sin_ninguno_devuelve_none(monkeypatch):
    monkeypatch.setattr(deps, "orquestador", _Orq(set()))
    assert chat.available_vision_model("moondream", CATALOGO) is None
