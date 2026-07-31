"""
Tests de la delegación (punto B: elegir el modelo por capacidad, no por una
lista de nombres literales). Todo puro: no toca Ollama ni el gateway.
"""
from core.delegation.embeddings import (
    pick_classifier_model,
    pick_route_model,
    rank_candidates,
    route_request,
)

CATALOGO = [
    {"id": "deepseek-r1:8b", "capabilities": ["completion", "tools", "thinking"], "size": 5_200_000_000},
    {"id": "qwen3:4b", "capabilities": ["completion", "tools", "thinking"], "size": 2_500_000_000},
    {"id": "moondream:latest", "capabilities": ["completion", "vision"], "size": 1_700_000_000},
    {"id": "nomic-embed-text:latest", "capabilities": ["embedding"], "size": 300_000_000},
]


# ── Candidatos ──────────────────────────────────────────────────────────────

def test_los_embeddings_no_son_candidatos():
    """Antes `pick()` podía devolver available_models[0] — el de embeddings."""
    assert "nomic-embed-text:latest" not in rank_candidates(CATALOGO)


def test_orden_tools_luego_completion_luego_desconocidos():
    catalogo = [
        {"id": "solo-completion", "capabilities": ["completion"]},
        {"id": "desconocido"},
        {"id": "con-tools", "capabilities": ["completion", "tools"]},
    ]
    assert rank_candidates(catalogo) == ["con-tools", "solo-completion", "desconocido"]


def test_los_pseudo_modelos_de_error_se_descartan():
    """fetch_models() devuelve [{'id': 'error: …'}] cuando Ollama no responde."""
    assert rank_candidates([{"id": "error: All connection attempts failed"}]) == []
    assert pick_route_model([{"id": "error: boom"}]) is None


def test_acepta_strings_sueltos():
    """Catálogo de un gateway viejo: solo ids, capabilities desconocidas."""
    assert rank_candidates(["llama3.1:8b", "phi3:mini"]) == ["llama3.1:8b", "phi3:mini"]
    assert pick_route_model(["llama3.1:8b", "phi3:mini"], "light") == "llama3.1:8b"


# ── Tiers ───────────────────────────────────────────────────────────────────

def test_heavy_es_el_mas_grande_del_mejor_tramo():
    assert pick_route_model(CATALOGO, "heavy") == "deepseek-r1:8b"


def test_light_es_el_mas_pequeno_del_mejor_tramo_no_del_catalogo():
    """`moondream` (1.7 GB, visión) es más pequeño que qwen3:4b pero no tiene
    `tools`: clasificar con él sería peor que el bug que esto arregla."""
    assert pick_route_model(CATALOGO, "light") == "qwen3:4b"
    assert pick_classifier_model(CATALOGO) == "qwen3:4b"


def test_la_capacidad_manda_sobre_el_tamano():
    catalogo = [
        {"id": "grande-sin-tools", "capabilities": ["completion"], "size": 9_000_000_000},
        {"id": "chico-con-tools", "capabilities": ["completion", "tools"], "size": 1_000_000_000},
    ]
    assert pick_route_model(catalogo, "heavy") == "chico-con-tools"
    assert pick_route_model(catalogo, "light") == "chico-con-tools"


def test_baja_de_tramo_si_el_mejor_esta_vacio():
    catalogo = [{"id": "a", "capabilities": ["completion"], "size": 2},
                {"id": "b", "capabilities": ["completion"], "size": 1}]
    assert pick_route_model(catalogo, "heavy") == "a"
    assert pick_route_model(catalogo, "light") == "b"


def test_sin_modelos_aptos_devuelve_none():
    """El llamador debe dar un 503 claro, no llamar a Ollama con model=None."""
    assert pick_route_model([], "light") is None
    assert pick_route_model(None, "heavy") is None
    assert pick_route_model([{"id": "n", "capabilities": ["embedding"]}], "heavy") is None
    assert pick_classifier_model([]) is None


def test_sin_tamanos_conserva_el_orden_del_catalogo():
    catalogo = [{"id": "a", "capabilities": ["tools"]}, {"id": "b", "capabilities": ["tools"]}]
    assert pick_route_model(catalogo, "heavy") == "a"
    assert pick_route_model(catalogo, "light") == "a"


# ── route_request ───────────────────────────────────────────────────────────

def test_riesgo_critico_sigue_delegando_sin_modelo():
    r = route_request({"riskLevel": "critical"}, CATALOGO)
    assert r["type"] == "DELEGUE"
    assert r["model"] is None
    assert r["message"]


def test_auto_usa_el_ligero_y_plan_debug_el_capaz():
    auto = route_request({"complexity": 0.1, "riskLevel": "low"}, CATALOGO)
    debug = route_request({"intent": "debug"}, CATALOGO)
    plan = route_request({}, CATALOGO)
    assert (auto["type"], auto["model"]) == ("AUTO", "qwen3:4b")
    assert (debug["type"], debug["model"]) == ("DEBUG", "deepseek-r1:8b")
    assert (plan["type"], plan["model"]) == ("PLAN", "deepseek-r1:8b")
    # Cada rama conserva su timeout y su system prompt.
    assert auto["timeout"] < debug["timeout"] < plan["timeout"]
    assert all(r["system_prompt"] for r in (auto, debug, plan))


def test_el_modelo_fijado_gana_en_todas_las_ramas():
    """Rol `route` asignado en BD/env: el admin manda."""
    for clasificacion in ({"complexity": 0.1, "riskLevel": "low"}, {"intent": "debug"}, {}):
        r = route_request(clasificacion, CATALOGO, pinned_model="forzado:1b")
        assert r["model"] == "forzado:1b", clasificacion


def test_sin_catalogo_el_modelo_es_none_en_vez_de_un_literal_inventado():
    """Antes caía a `"llama3.1:8b"` aunque no estuviera instalado."""
    for clasificacion in ({"complexity": 0.1, "riskLevel": "low"}, {"intent": "debug"}, {}):
        assert route_request(clasificacion, [])["model"] is None
