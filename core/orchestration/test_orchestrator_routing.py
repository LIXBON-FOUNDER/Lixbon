"""
Tests del routing por modelo (punto D: fallo explícito en vez de enrutar a
ciegas). Se inyecta `_estado` a mano: nunca se arranca el hilo de polling ni se
habla con un nodo, así que no hay red ni BD.
"""
from core.config import OLLAMA_BASE_URL
from core.orchestration.orchestrator import (
    ModelUnavailable,
    NodeOrchestrator,
    _normalizar_modelo,
)


def _estado_nodo(nid, modelos, score=50.0, online=True, capabilities=None, agent_version="3.1.0"):
    return {
        "online": online,
        "fallos": 0,
        "next_retry": 0.0,
        "metricas": {},
        "modelos": list(modelos),
        "capabilities": capabilities or {},
        "tamanos": {},
        "agent_version": agent_version,
        "score": score,
        "ultimo_poll": None,
        "config": {"id": nid, "agent_url": f"http://{nid}:8100", "auth_token": "t0ken"},
    }


def _orq(**nodos):
    orq = NodeOrchestrator()
    orq._estado = dict(nodos)
    return orq


# ── Normalización ───────────────────────────────────────────────────────────

def test_normalizar_modelo():
    assert _normalizar_modelo("nomic-embed-text:latest") == "nomic-embed-text"
    assert _normalizar_modelo(" qwen3:4b ") == "qwen3:4b"
    assert _normalizar_modelo(None) == ""


# ── best_node_for_model ─────────────────────────────────────────────────────

def test_strict_sin_nodo_con_el_modelo_devuelve_none():
    orq = _orq(a=_estado_nodo("a", ["qwen3:4b"]))
    try:
        assert orq.best_node_for_model("deepseek-r1:8b") is None
    finally:
        orq.detener()


def test_no_strict_cae_al_mejor_nodo():
    """Conducta previa a esta tanda: se conserva para llamadores no migrados."""
    orq = _orq(
        a=_estado_nodo("a", ["qwen3:4b"], score=10.0),
        b=_estado_nodo("b", ["qwen3:4b"], score=90.0),
    )
    try:
        assert orq.best_node_for_model("no-existe:1b", strict=False)["id"] == "b"
    finally:
        orq.detener()


def test_elige_el_de_mayor_score_entre_los_que_lo_tienen():
    orq = _orq(
        a=_estado_nodo("a", ["deepseek-r1:8b"], score=90.0),
        b=_estado_nodo("b", ["deepseek-r1:8b", "qwen3:4b"], score=30.0),
    )
    try:
        assert orq.best_node_for_model("deepseek-r1:8b")["id"] == "a"
        # El nodo con más score NO tiene qwen3:4b: gana el que sí lo tiene.
        assert orq.best_node_for_model("qwen3:4b")["id"] == "b"
    finally:
        orq.detener()


def test_los_nodos_offline_no_cuentan():
    orq = _orq(
        a=_estado_nodo("a", ["deepseek-r1:8b"], online=False),
        b=_estado_nodo("b", ["qwen3:4b"]),
    )
    try:
        assert orq.best_node_for_model("deepseek-r1:8b") is None
        assert orq.nodos_online() == ["b"]
    finally:
        orq.detener()


def test_el_match_normaliza_latest_en_ambos_sentidos():
    """R4: sin esto, `nomic-embed-text` (env) no casaría con lo que lista el nodo
    (`nomic-embed-text:latest`) y los embeddings romperían el día 1."""
    orq = _orq(a=_estado_nodo("a", ["nomic-embed-text:latest"]))
    try:
        assert orq.best_node_for_model("nomic-embed-text")["id"] == "a"
    finally:
        orq.detener()
    orq2 = _orq(a=_estado_nodo("a", ["nomic-embed-text"]))
    try:
        assert orq2.best_node_for_model("nomic-embed-text:latest")["id"] == "a"
    finally:
        orq2.detener()


# ── ollama_target ───────────────────────────────────────────────────────────

def test_target_strict_levanta_model_unavailable():
    orq = _orq(a=_estado_nodo("a", ["qwen3:4b"]))
    try:
        try:
            orq.ollama_target("deepseek-r1:8b", strict=True)
        except ModelUnavailable as exc:
            assert exc.model == "deepseek-r1:8b"
            assert exc.nodes_online == ["a"]
        else:
            raise AssertionError("se enrutó a un nodo que no tiene el modelo")
    finally:
        orq.detener()


def test_target_con_nodo_apunta_al_proxy_del_agente():
    orq = _orq(a=_estado_nodo("a", ["qwen3:4b"]))
    try:
        base, headers, origen = orq.ollama_target("qwen3:4b", strict=True)
        assert base == "http://a:8100/ollama"
        assert origen == "a"
        assert headers  # token del nodo
    finally:
        orq.detener()


def test_sin_nodos_online_cae_al_ollama_local():
    """El camino de desarrollo NO es un error, ni siquiera en modo estricto."""
    orq = _orq()
    try:
        base, headers, origen = orq.ollama_target("cualquier-cosa:1b", strict=True)
        assert (base, headers, origen) == (OLLAMA_BASE_URL, {}, "local")
    finally:
        orq.detener()
    orq2 = _orq(a=_estado_nodo("a", ["qwen3:4b"], online=False))
    try:
        assert orq2.ollama_target("qwen3:4b", strict=True)[2] == "local"
    finally:
        orq2.detener()


def test_target_sin_modelo_usa_el_mejor_nodo():
    orq = _orq(
        a=_estado_nodo("a", [], score=10.0),
        b=_estado_nodo("b", [], score=80.0),
    )
    try:
        assert orq.ollama_target()[2] == "b"
    finally:
        orq.detener()


# ── Agregación del catálogo ─────────────────────────────────────────────────

def test_todos_los_modelos_une_capabilities_y_omite_las_desconocidas():
    orq = _orq(
        a=_estado_nodo("a", ["qwen3:4b"], capabilities={"qwen3:4b": ["completion", "tools"]}),
        b=_estado_nodo("b", ["qwen3:4b", "viejo:7b"], capabilities={"qwen3:4b": ["thinking"]}),
    )
    try:
        catalogo = {m["id"]: m for m in orq.todos_los_modelos()}
        assert set(catalogo) == {"qwen3:4b", "viejo:7b"}
        assert set(catalogo["qwen3:4b"]["capabilities"]) == {"completion", "tools", "thinking"}
        # Nadie declara las de `viejo:7b` ⇒ la clave se omite (≠ lista vacía).
        assert "capabilities" not in catalogo["viejo:7b"]
    finally:
        orq.detener()


def test_estado_nodos_expone_agent_version():
    """Para ver en el panel qué nodos van con un agente viejo (riesgo R1)."""
    orq = _orq(
        a=_estado_nodo("a", ["qwen3:4b"], agent_version="3.1.0"),
        b=_estado_nodo("b", ["qwen3:4b"], agent_version=None),
    )
    try:
        versiones = {n["id"]: n.get("agent_version") for n in orq.estado_nodos()}
        assert versiones == {"a": "3.1.0", "b": None}
    finally:
        orq.detener()
