"""
Tests de la caché de capabilities del node_agent (`merge_caps`, pura).

Lo que se protege aquí es el riesgo R6: el poll ocurre cada ~15 s y no puede
disparar un `/api/show` por modelo cada vez, o el nodo se pasaría del timeout de
8 s del orquestador. La caché se invalida por digest, no por tiempo.
"""
from core.node_agent.agent import merge_caps


def _tag(name, digest="d1", size=1000):
    return {"name": name, "digest": digest, "size": size}


def test_sin_cache_todo_esta_pendiente_y_las_caps_son_desconocidas():
    info, pendientes = merge_caps([_tag("a"), _tag("b")], {}, budget=8)
    assert pendientes == ["a", "b"]
    # None = desconocido. El gateway NUNCA debe leerlo como "no soportado".
    assert [m["capabilities"] for m in info] == [None, None]
    assert [m["name"] for m in info] == ["a", "b"]


def test_digest_sin_cambios_no_vuelve_a_consultar():
    cache = {"a": ("d1", ["completion", "tools"])}
    info, pendientes = merge_caps([_tag("a", "d1")], cache, budget=8)
    assert pendientes == []
    assert info[0]["capabilities"] == ["completion", "tools"]


def test_digest_distinto_invalida_la_entrada():
    """`ollama pull` sobre el mismo tag cambia el digest: hay que releer."""
    cache = {"a": ("d1", ["completion"])}
    info, pendientes = merge_caps([_tag("a", "d2")], cache, budget=8)
    assert pendientes == ["a"]
    assert info[0]["capabilities"] is None


def test_se_respeta_el_tope_por_poll():
    tags = [_tag(f"m{i}") for i in range(20)]
    info, pendientes = merge_caps(tags, {}, budget=8)
    assert len(pendientes) == 8
    # Los que no entraron en el presupuesto siguen apareciendo en model_info
    # (con capabilities desconocidas): no desaparecen del catálogo.
    assert len(info) == 20
    assert pendientes == [f"m{i}" for i in range(8)]


def test_budget_cero_no_consulta_nada():
    """Es la segunda pasada de _ollama_model_info: solo lee la caché recién llena."""
    cache = {"a": ("d1", ["completion"])}
    info, pendientes = merge_caps([_tag("a"), _tag("b")], cache, budget=0)
    assert pendientes == []
    assert [m["capabilities"] for m in info] == [["completion"], None]


def test_los_cacheados_no_gastan_presupuesto():
    cache = {f"m{i}": ("d1", ["completion"]) for i in range(10)}
    tags = [_tag(f"m{i}") for i in range(10)] + [_tag("nuevo")]
    _, pendientes = merge_caps(tags, cache, budget=1)
    assert pendientes == ["nuevo"]


def test_tags_sin_nombre_se_descartan():
    info, pendientes = merge_caps([{"digest": "d1"}, _tag("a")], {}, budget=8)
    assert [m["name"] for m in info] == ["a"]
    assert pendientes == ["a"]


def test_model_info_conserva_digest_y_tamano():
    info, _ = merge_caps([_tag("a", "abc123", size=5_200_000_000)], {}, budget=0)
    assert info[0]["digest"] == "abc123"
    assert info[0]["size"] == 5_200_000_000


def test_tag_sin_size_no_rompe():
    info, _ = merge_caps([{"name": "a", "digest": "d1"}], {}, budget=0)
    assert info[0]["size"] == 0
