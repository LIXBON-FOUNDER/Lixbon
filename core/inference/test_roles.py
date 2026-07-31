"""
Tests del resolvedor rol→modelo. Todo contra `resolve_from`, que es puro: no
toca BD, ni red, ni config. Se corren con `python -m pytest core -q`.

El catálogo de referencia es el medido en el Ollama de desarrollo (0.31.1), que
es el escenario del que salió el bug: cuatro modelos y NINGUNO con `insert`.
"""
from core.inference.roles import (
    PREFERRED_CAPABILITY,
    REQUIRED_CAPABILITY,
    ROLES,
    capabilities_of,
    has_capability,
    normalize,
    pick_by_capability,
    resolve_from,
)

# Catálogo real (tal como lo devuelve fetch_models()).
CATALOGO = [
    {"id": "deepseek-r1:8b", "capabilities": ["completion", "tools", "thinking"], "size": 5_200_000_000},
    {"id": "qwen3:4b", "capabilities": ["completion", "tools", "thinking"], "size": 2_500_000_000},
    {"id": "moondream:latest", "capabilities": ["completion", "vision"], "size": 1_700_000_000},
    {"id": "nomic-embed-text:latest", "capabilities": ["embedding"], "size": 300_000_000},
]

# El mismo cluster visto por un gateway con node_agents viejos: sin capabilities.
CATALOGO_LEGACY = [{"id": e["id"]} for e in CATALOGO]

ENV_VACIO: dict[str, str] = {}


def _resolve(role, **kwargs):
    kwargs.setdefault("catalog", CATALOGO)
    kwargs.setdefault("env_models", ENV_VACIO)
    return resolve_from(role, **kwargs)


# ── Normalización ───────────────────────────────────────────────────────────

def test_normalize_ignora_latest():
    assert normalize("nomic-embed-text:latest") == "nomic-embed-text"
    assert normalize("nomic-embed-text") == "nomic-embed-text"
    assert normalize("  qwen3:4b  ") == "qwen3:4b"
    assert normalize(None) == ""
    # `:latest` solo se recorta al final, no en medio de un tag.
    assert normalize("modelo:latest-rc") == "modelo:latest-rc"


def test_capabilities_normaliza_al_buscar():
    # env/BD escriben `moondream`; /api/tags devuelve `moondream:latest`.
    assert capabilities_of(CATALOGO, "moondream") == ["completion", "vision"]
    assert capabilities_of(CATALOGO, "no-existe") is None


def test_has_capability_desconocido_no_descarta():
    assert has_capability(CATALOGO, "moondream", "vision") is True
    assert has_capability(CATALOGO, "moondream", "insert") is False
    # Sin capabilities declaradas o fuera del catálogo: "no se sabe" ⇒ no se veta.
    assert has_capability(CATALOGO_LEGACY, "deepseek-r1:8b", "insert") is True
    assert has_capability(CATALOGO, "modelo-que-no-esta", "insert") is True


# ── Precedencia ─────────────────────────────────────────────────────────────

def test_bd_gana_a_env_y_a_autodeteccion():
    res = _resolve(
        "chat",
        db_rows=[{"role": "chat", "model": "qwen3:4b", "is_active": 1}],
        env_models={"chat": "deepseek-r1:8b"},
    )
    assert (res.model, res.source) == ("qwen3:4b", "db")


def test_env_gana_a_autodeteccion():
    res = _resolve("chat", env_models={"chat": "qwen3:4b"})
    # Autodetectando saldría deepseek-r1:8b (el más grande con tools).
    assert (res.model, res.source) == ("qwen3:4b", "env")


def test_fila_inactiva_se_ignora():
    res = _resolve(
        "chat",
        db_rows=[{"role": "chat", "model": "qwen3:4b", "is_active": 0}],
        env_models={"chat": "deepseek-r1:8b"},
    )
    assert (res.model, res.source) == ("deepseek-r1:8b", "env")


def test_fila_sin_modelo_no_bloquea_pero_aporta_keep_alive():
    """Es el estado sembrado: las 5 filas existen con model=NULL."""
    res = _resolve(
        "chat",
        db_rows=[{"role": "chat", "model": None, "keep_alive": "45m", "is_active": 1}],
        env_models={"chat": "qwen3:4b"},
    )
    assert (res.model, res.source) == ("qwen3:4b", "env")
    assert res.keep_alive == "45m"


def test_keep_alive_de_bd_gana_a_env():
    res = _resolve(
        "embed",
        db_rows=[{"role": "embed", "model": None, "keep_alive": "-1", "is_active": 1}],
        env_keepalive={"embed": "5m"},
    )
    assert res.keep_alive == "-1"


def test_keep_alive_cae_a_env_y_num_ctx_viene_de_bd():
    res = _resolve(
        "chat",
        db_rows=[{"role": "chat", "model": None, "num_ctx": 16384, "is_active": 1}],
        env_keepalive={"chat": "30m"},
    )
    assert (res.keep_alive, res.num_ctx) == ("30m", 16384)


# ── Autodetección por capability ─────────────────────────────────────────────

def test_autodeteccion_con_el_catalogo_real():
    """Cada rol cae en el modelo correcto sin ninguna config."""
    assert _resolve("chat").model == "deepseek-r1:8b"       # el mayor con tools
    assert _resolve("vision").model == "moondream:latest"
    assert _resolve("embed").model == "nomic-embed-text:latest"
    assert _resolve("route").model == "qwen3:4b"            # el menor con tools
    assert all(_resolve(r).source == "capability" for r in ("chat", "vision", "embed", "route"))


def test_fim_sin_insert_devuelve_none():
    """Regresión del bug A.

    Ningún modelo instalado declara `insert`, así que el rol `fim` NO se puede
    servir. Antes el IDE caía al modelo de chat y disparaba un modelo de
    razonamiento de 5 GB en cada pulsación de tecla.
    """
    res = _resolve("fim")
    assert res.model is None
    assert res.source == "none"
    assert res.supported is False
    assert res.warning and "insert" in res.warning
    # Y en particular: nunca el modelo de chat.
    assert res.model != "deepseek-r1:8b"


def test_fim_nunca_usa_el_heuristico_por_nombre():
    """Ni con capabilities desconocidas ni con un modelo que se llame `coder`."""
    legacy_con_coder = CATALOGO_LEGACY + [{"id": "qwen2.5-coder:7b"}]
    assert _resolve("fim", catalog=legacy_con_coder).model is None
    assert _resolve("fim", catalog=CATALOGO_LEGACY).model is None


def test_fim_se_sirve_cuando_hay_un_modelo_con_insert():
    catalogo = CATALOGO + [
        {"id": "qwen2.5-coder:1.5b",
         "capabilities": ["completion", "insert", "tools"], "size": 1_000_000_000},
    ]
    res = _resolve("fim", catalog=catalogo)
    assert (res.model, res.source, res.supported) == ("qwen2.5-coder:1.5b", "capability", True)
    # El rol de chat NO se mueve: es la prueba de que los roles están separados.
    assert _resolve("chat", catalog=catalogo).model == "deepseek-r1:8b"


def test_normaliza_al_id_exacto_del_catalogo():
    """`nomic-embed-text` (env) debe convertirse en el id con `:latest`, o el
    routing estricto por nodo no encontraría el modelo."""
    res = _resolve("embed", env_models={"embed": "nomic-embed-text"})
    assert res.model == "nomic-embed-text:latest"
    assert res.source == "env"


def test_modelo_configurado_sin_la_capacidad_avisa_pero_se_respeta():
    res = _resolve("vision", env_models={"vision": "qwen3:4b"})
    assert res.model == "qwen3:4b"      # lo pidió el operador: se respeta
    assert res.supported is False
    assert res.warning and "vision" in res.warning


def test_modelo_configurado_ausente_del_catalogo_no_se_veta():
    """Pre-asignar un modelo antes del `ollama pull` es legítimo."""
    res = _resolve("chat", env_models={"chat": "aun-no-descargado:70b"})
    assert (res.model, res.source) == ("aun-no-descargado:70b", "env")
    assert res.capabilities is None
    assert res.supported is True        # desconocido ≠ no soportado


# ── Camino legacy (node_agents sin capabilities) ─────────────────────────────

def test_legacy_usa_el_nombre_solo_si_nadie_declara_capabilities():
    assert _resolve("chat", catalog=CATALOGO_LEGACY).source == "capability-legacy"
    assert _resolve("vision", catalog=CATALOGO_LEGACY).model == "moondream:latest"
    assert _resolve("embed", catalog=CATALOGO_LEGACY).model == "nomic-embed-text:latest"


def test_un_solo_modelo_con_capabilities_desactiva_el_legacy():
    """Si alguien declara capabilities, el catálogo es fiable: no adivinar."""
    mixto = [{"id": "viejo:7b"}, {"id": "nomic-embed-text:latest", "capabilities": ["embedding"]}]
    assert _resolve("embed", catalog=mixto).source == "capability"
    # `vision` no se puede servir: nadie la declara y el legacy ya no aplica.
    assert _resolve("vision", catalog=mixto).model is None


def test_catalogo_vacio_o_con_errores():
    for catalogo in ([], None, [{"id": "error: All connection attempts failed"}]):
        for role in ROLES:
            res = _resolve(role, catalog=catalogo)
            assert res.model is None, (role, catalogo)
            assert res.warning


# ── pick_by_capability ──────────────────────────────────────────────────────

def test_pick_prefiere_la_capacidad_preferida_sobre_el_tamano():
    catalogo = [
        {"id": "grande-sin-tools", "capabilities": ["completion"], "size": 9_000_000_000},
        {"id": "chico-con-tools", "capabilities": ["completion", "tools"], "size": 1_000_000_000},
    ]
    assert pick_by_capability(catalogo, "completion", prefer="tools") == "chico-con-tools"
    assert pick_by_capability(catalogo, "completion") == "grande-sin-tools"


def test_pick_smallest_elige_el_menor():
    assert pick_by_capability(CATALOGO, "completion", prefer="tools", smallest=True) == "qwen3:4b"


def test_pick_sin_tamanos_conserva_el_orden_del_catalogo():
    catalogo = [{"id": "a", "capabilities": ["completion"]}, {"id": "b", "capabilities": ["completion"]}]
    assert pick_by_capability(catalogo, "completion") == "a"
    assert pick_by_capability(catalogo, "completion", smallest=True) == "a"


# ── Contrato de la tabla de roles ───────────────────────────────────────────

def test_todos_los_roles_declaran_capacidad_requerida():
    assert set(REQUIRED_CAPABILITY) == set(ROLES)
    assert set(PREFERRED_CAPABILITY) <= set(ROLES)


def test_rol_desconocido_es_error_de_programacion():
    try:
        resolve_from("traduccion", catalog=CATALOGO)
    except ValueError as exc:
        assert "traduccion" in str(exc)
    else:
        raise AssertionError("resolve_from aceptó un rol inexistente")
