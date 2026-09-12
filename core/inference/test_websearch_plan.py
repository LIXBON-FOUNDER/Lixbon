"""Planificación de consultas y unión de resultados del modo investigar. Sin red:
el buscador se sustituye por un doble."""
import asyncio

from core.inference import websearch


def run(coro):
    return asyncio.run(coro)


def test_parse_plan_extrae_json_y_deduplica():
    raw = 'Claro: {"queries": ["costo de vida Perú 2026", "Costo de vida Perú 2026", "", "salario mínimo Perú"]}'
    assert websearch.parse_plan(raw, "x") == ["costo de vida Perú 2026", "salario mínimo Perú"]


def test_parse_plan_cae_a_la_pregunta_si_no_hay_json():
    assert websearch.parse_plan("no sé", "¿y en Perú?") == ["¿y en Perú?"]
    assert websearch.parse_plan('{"queries": []}', "pregunta") == ["pregunta"]


def test_parse_plan_limita_el_numero(monkeypatch):
    monkeypatch.setattr(websearch, "MAX_QUERIES", 2)
    raw = '{"queries": ["a", "b", "c"]}'
    assert websearch.parse_plan(raw, "x") == ["a", "b"]


def test_plan_queries_pasa_historial_recortado_y_usa_fallback_si_falla():
    visto = {}

    async def ask(msgs):
        visto["msgs"] = msgs
        return '{"queries": ["vivir en Colombia vs Ecuador 2026"]}'

    messages = [
        {"role": "system", "content": "eres útil"},
        {"role": "user", "content": "x" * 5000},
        {"role": "assistant", "content": "..."},
        {"role": "user", "content": "es mejor vivir en colombia que en ecuador?"},
    ]
    assert run(websearch.plan_queries(messages, ask)) == ["vivir en Colombia vs Ecuador 2026"]
    assert visto["msgs"][0]["role"] == "system"
    assert [m["role"] for m in visto["msgs"][1:]] == ["user", "assistant", "user"]
    assert len(visto["msgs"][1]["content"]) == websearch._PLAN_CHARS

    async def rompe(_msgs):
        raise RuntimeError("modelo caído")

    assert run(websearch.plan_queries(messages, rompe)) == ["es mejor vivir en colombia que en ecuador?"]


def test_research_une_sin_repetir_e_intercala(monkeypatch):
    def falso(query, limit):
        if query == "a":
            return [{"url": "u1", "title": "A1"}, {"url": "u2", "title": "A2"}]
        return [{"url": "u2", "title": "B1"}, {"url": "u3", "title": "B2"}]

    monkeypatch.setattr(websearch, "_search_sync", falso)
    monkeypatch.setattr(websearch, "FETCH_PAGES", 0)
    res = run(websearch.research(["a", "b", ""]))
    assert [r["url"] for r in res] == ["u1", "u2", "u3"]


def test_build_context_menciona_lo_buscado():
    ctx = websearch.build_context("pregunta", [{"title": "T", "url": "u", "snippet": "s"}], ["q1", "q2"])
    assert "Se buscó en internet: q1; q2" in ctx
    assert "[1] T" in ctx
    vacio = websearch.build_context("pregunta", [], ["q1"])
    assert '"q1"' in vacio


def test_cadena_de_proveedores_salta_al_siguiente(monkeypatch):
    llamadas = []

    def falla(q, n):
        llamadas.append("falla")
        raise RuntimeError("429")

    def vacio(q, n):
        llamadas.append("vacio")
        return []

    def bueno(q, n):
        llamadas.append("bueno")
        return [{"url": "u", "title": "t", "snippet": ""}]

    monkeypatch.setattr(websearch, "PROVIDERS", ["brave", "searxng", "duckduckgo"])
    monkeypatch.setattr(websearch, "_PROVIDER_FN", {
        "brave": (falla, lambda: True),
        "searxng": (vacio, lambda: True),
        "duckduckgo": (bueno, lambda: True),
    })
    assert websearch._search_sync("q", 5)[0]["url"] == "u"
    assert llamadas == ["falla", "vacio", "bueno"]


def test_proveedores_sin_clave_se_omiten(monkeypatch):
    monkeypatch.setattr(websearch, "PROVIDERS", ["brave", "tavily", "duckduckgo"])
    monkeypatch.setattr(websearch, "BRAVE_API_KEY", "")
    monkeypatch.setattr(websearch, "TAVILY_API_KEY", "k")
    assert websearch.providers_configured() == ["tavily", "duckduckgo"]
