"""
roles.py — Mapa rol→modelo del gateway.

La aplicación tiene cinco roles de inferencia con requisitos incompatibles entre
sí (ver docs/CUELLO_DE_BOTELLA_MODELOS.md): el agente quiere el modelo más grande,
el autocompletado el más rápido, la visión uno multimodal, los embeddings un vector
estable y el router algo diminuto. Un solo modelo no puede servirlos a la vez.

Cada rol se resuelve con esta precedencia:

    1. tabla `model_roles` (override del admin)     → source="db"
    2. variable de entorno MODEL_ROLE_<ROL>         → source="env"
    3. autodetección por capability real de Ollama  → source="capability"
    4. heurístico por nombre (solo si NINGÚN modelo → source="capability-legacy"
       del catálogo declara capabilities, es decir
       cluster de node_agents viejos)
    5. nada                                         → source="none", model=None

La autodetección usa el array `capabilities` que devuelve `POST /api/show` de
Ollama (completion / tools / thinking / vision / embedding / insert), propagado
por el node_agent en `/metrics`. Es lo que sustituye a los regex sobre el nombre
del modelo, que era la causa de que el ghost text acabara disparando el modelo de
chat (punto A del doc).

`capabilities: None` significa DESCONOCIDO (node_agent viejo), nunca "no soportado":
esos modelos no se descartan, solo se ordenan al final de los candidatos.

`resolve_from()` es puro (recibe filas, env y catálogo como argumentos) para poder
testearse sin BD ni red; el resto son envoltorios que leen la BD y la config.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

logger = logging.getLogger("lixbon.roles")

ROLES: tuple[str, ...] = ("chat", "fim", "vision", "embed", "route")

# Capability que el modelo DEBE declarar para servir el rol.
REQUIRED_CAPABILITY: dict[str, str] = {
    "chat": "completion",
    "fim": "insert",        # tokens FIM (<|fim_prefix|>…): Ollama la llama 'insert'
    "vision": "vision",
    "embed": "embedding",
    "route": "completion",
}

# Capability deseable pero no obligatoria: ordena los candidatos.
PREFERRED_CAPABILITY: dict[str, str] = {
    "chat": "tools",   # el agente necesita tool calling fiable
    "route": "tools",
}

# Roles que quieren el modelo más PEQUEÑO de los aptos (latencia > calidad).
SMALLEST_FIRST: frozenset[str] = frozenset({"route", "fim"})

# Heurístico por nombre. Solo se usa cuando el catálogo entero viene sin
# capabilities (node_agents viejos). 'fim' NO está a propósito: adivinar el
# modelo de autocompletado por el nombre es exactamente el bug que se corrige.
_LEGACY_PATTERNS: dict[str, tuple[str, ...]] = {
    "chat": ("coder", "code", "instruct"),
    "vision": (
        "llava", "bakllava", "moondream", "minicpm-v", "llama3.2-vision",
        "llama-3.2-vision", "qwen2-vl", "qwen2.5-vl", "qwen2.5vl", "qwenvl",
        "vision", "gemma3", "granite3.2-vision",
    ),
    "embed": ("embed",),
    "route": (),
}

_ROLE_HINT: dict[str, str] = {
    "chat": "Instala o asigna un modelo de chat (p. ej. `ollama pull deepseek-r1:8b`).",
    "fim": "Ningún modelo declara la capacidad `insert` (FIM). "
           "Instala uno de código con fill-in-the-middle, p. ej. `ollama pull qwen2.5-coder:1.5b`.",
    "vision": "Ningún modelo multimodal disponible (p. ej. `ollama pull moondream`).",
    "embed": "Ningún modelo de embeddings disponible (p. ej. `ollama pull nomic-embed-text`).",
    "route": "Ningún modelo apto para clasificar peticiones.",
}


@dataclass(frozen=True)
class RoleResolution:
    """Resultado de resolver un rol. `model=None` ⇒ el rol no se puede servir."""
    role: str
    model: str | None
    source: str                       # db | env | capability | capability-legacy | none
    keep_alive: str | None = None
    num_ctx: int | None = None
    capabilities: list[str] | None = None   # None = desconocidas
    supported: bool = True             # False solo si SE SABE que no declara la requerida
    warning: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "model": self.model,
            "source": self.source,
            "keep_alive": self.keep_alive,
            "num_ctx": self.num_ctx,
            "capabilities": self.capabilities,
            "supported": self.supported,
            "warning": self.warning,
        }


# ── Catálogo ────────────────────────────────────────────────────────────────
# El catálogo es lo que devuelve core.gateway.utils.fetch_models(): lista de
# dicts {"id", "capabilities"?, "size"?}. Se aceptan strings sueltos por
# tolerancia (⇒ capabilities desconocidas).

def normalize(model: str | None) -> str:
    """Nombre comparable: sin espacios y sin el `:latest` implícito.

    Imprescindible porque env/BD suelen escribir `nomic-embed-text` mientras
    `/api/tags` devuelve `nomic-embed-text:latest`.
    """
    name = (model or "").strip()
    if name.endswith(":latest"):
        name = name[: -len(":latest")]
    return name


def _entries(catalog: Iterable[Any] | None) -> list[dict[str, Any]]:
    """Normaliza el catálogo a dicts, descartando los pseudo-modelos de error."""
    out: list[dict[str, Any]] = []
    for item in catalog or []:
        if isinstance(item, str):
            out.append({"id": item})
        elif isinstance(item, dict) and item.get("id"):
            out.append(item)
    return [e for e in out if not str(e["id"]).startswith("error:")]


def capabilities_of(catalog: Iterable[Any] | None, model: str | None) -> list[str] | None:
    """Capabilities declaradas del modelo, o None si no se conocen."""
    target = normalize(model)
    if not target:
        return None
    for entry in _entries(catalog):
        if normalize(entry["id"]) == target:
            caps = entry.get("capabilities")
            return list(caps) if caps else None
    return None


def resolve_catalog_id(catalog: Iterable[Any] | None, model: str | None) -> str | None:
    """El id EXACTO del catálogo que corresponde al modelo pedido (`:latest` incluido)."""
    target = normalize(model)
    if not target:
        return None
    for entry in _entries(catalog):
        if normalize(entry["id"]) == target:
            return str(entry["id"])
    return None


def has_capability(catalog: Iterable[Any] | None, model: str | None, capability: str) -> bool:
    """True si declara la capability o si no se sabe (desconocido ≠ no soportado)."""
    caps = capabilities_of(catalog, model)
    return capability in caps if caps is not None else True


def pick_by_capability(
    catalog: Iterable[Any] | None,
    capability: str,
    prefer: str | None = None,
    smallest: bool = False,
) -> str | None:
    """Mejor modelo que declara `capability`.

    Ordena por: tiene `prefer` primero, luego por tamaño (el mayor, o el menor si
    `smallest`), y deja el orden del catálogo como desempate estable. Los modelos
    con capabilities desconocidas NO son candidatos aquí (para eso está el
    heurístico legacy).
    """
    candidatos = [e for e in _entries(catalog) if capability in (e.get("capabilities") or [])]
    if not candidatos:
        return None

    def clave(item: tuple[int, dict[str, Any]]) -> tuple[int, int, int]:
        idx, entry = item
        caps = entry.get("capabilities") or []
        sin_preferida = 0 if (prefer and prefer in caps) else 1
        size = int(entry.get("size") or 0)
        return (sin_preferida, size if smallest else -size, idx)

    mejor = min(enumerate(candidatos), key=clave)[1]
    return str(mejor["id"])


def _pick_legacy(catalog: Iterable[Any] | None, role: str) -> str | None:
    """Heurístico por nombre para clusters sin capabilities. Sin patrones ⇒ el primero."""
    entries = _entries(catalog)
    if not entries:
        return None
    patrones = _LEGACY_PATTERNS.get(role, ())
    for patron in patrones:
        for entry in entries:
            if patron in str(entry["id"]).lower():
                return str(entry["id"])
    return str(entries[0]["id"]) if role in ("chat", "route") else None


def _any_capabilities_known(catalog: Iterable[Any] | None) -> bool:
    return any(e.get("capabilities") for e in _entries(catalog))


# ── Resolución ──────────────────────────────────────────────────────────────

def resolve_from(
    role: str,
    db_rows: Sequence[dict[str, Any]] | None = None,
    env_models: dict[str, str] | None = None,
    env_keepalive: dict[str, str] | None = None,
    catalog: Iterable[Any] | None = None,
) -> RoleResolution:
    """Resuelve un rol a partir de datos ya cargados. Función PURA."""
    if role not in ROLES:
        raise ValueError(f"Rol desconocido: {role!r}")

    required = REQUIRED_CAPABILITY[role]
    row = _find_row(db_rows, role)

    keep_alive = None
    num_ctx = None
    if row:
        keep_alive = (row.get("keep_alive") or "").strip() or None
        num_ctx = row.get("num_ctx")
    if keep_alive is None:
        keep_alive = ((env_keepalive or {}).get(role) or "").strip() or None

    model: str | None = None
    source = "none"

    if row and (row.get("model") or "").strip():
        model, source = row["model"].strip(), "db"
    elif ((env_models or {}).get(role) or "").strip():
        model, source = env_models[role].strip(), "env"
    else:
        model = pick_by_capability(
            catalog, required,
            prefer=PREFERRED_CAPABILITY.get(role),
            smallest=role in SMALLEST_FIRST,
        )
        if model:
            source = "capability"
        elif role != "fim" and not _any_capabilities_known(catalog):
            # Cluster de node_agents viejos: sin capabilities no se puede
            # autodetectar. Para 'fim' se prefiere no servir el rol antes que
            # adivinar por el nombre (bug A).
            model = _pick_legacy(catalog, role)
            source = "capability-legacy" if model else "none"

    if not model:
        return RoleResolution(
            role=role, model=None, source="none",
            keep_alive=keep_alive, num_ctx=num_ctx,
            capabilities=None, supported=False,
            warning=_ROLE_HINT.get(role),
        )

    # Preferir el id exacto del catálogo: evita que `nomic-embed-text` (env) no
    # case con `nomic-embed-text:latest` en el routing por nodo.
    model = resolve_catalog_id(catalog, model) or model
    caps = capabilities_of(catalog, model)
    supported = required in caps if caps is not None else True
    warning = None
    if not supported:
        warning = (
            f"`{model}` no declara la capacidad `{required}` que necesita el rol "
            f"`{role}`. " + (_ROLE_HINT.get(role) or "")
        ).strip()

    return RoleResolution(
        role=role, model=model, source=source,
        keep_alive=keep_alive, num_ctx=num_ctx,
        capabilities=caps, supported=supported, warning=warning,
    )


def _find_row(db_rows: Sequence[dict[str, Any]] | None, role: str) -> dict[str, Any] | None:
    for row in db_rows or []:
        if row.get("role") == role and int(row.get("is_active", 1) or 0):
            return row
    return None


# ── Envoltorios con BD y config ─────────────────────────────────────────────

_ROLES_TTL_S = 60
_roles_cache: dict[str, Any] = {"at": 0.0, "rows": []}


def _role_rows() -> list[dict[str, Any]]:
    """Filas de `model_roles` con caché corta (mismo patrón que credits._pricing_rows)."""
    from core.config import MODEL_ROLES_TTL_S

    now = time.monotonic()
    if now - _roles_cache["at"] > (MODEL_ROLES_TTL_S or _ROLES_TTL_S):
        try:
            from core.persistence.queries import list_model_roles
            _roles_cache["rows"] = list_model_roles(active_only=True)
            _roles_cache["at"] = now
        except Exception as exc:
            logger.warning(f"No se pudieron cargar los roles de modelo ({exc})")
            _roles_cache["at"] = now  # no reintentar en cada request
    return _roles_cache["rows"]


def invalidate_roles_cache() -> None:
    """El panel admin la llama al editar roles para que apliquen al instante."""
    _roles_cache["at"] = 0.0
    _roles_cache["rows"] = []


def _env_models() -> dict[str, str]:
    from core import config
    return {
        "chat": config.MODEL_ROLE_CHAT,
        "fim": config.MODEL_ROLE_FIM,
        "vision": config.MODEL_ROLE_VISION,
        "embed": config.MODEL_ROLE_EMBED,
        "route": config.MODEL_ROLE_ROUTE,
    }


def _env_keepalive() -> dict[str, str]:
    from core import config
    return {
        "chat": config.MODEL_KEEPALIVE_CHAT,
        "fim": config.MODEL_KEEPALIVE_FIM,
        "vision": config.MODEL_KEEPALIVE_VISION,
        "embed": config.MODEL_KEEPALIVE_EMBED,
        "route": config.MODEL_KEEPALIVE_ROUTE,
    }


def resolve_role(role: str, catalog: Iterable[Any] | None = None) -> RoleResolution:
    """Resuelve un rol leyendo BD (cacheada) y config."""
    return resolve_from(role, _role_rows(), _env_models(), _env_keepalive(), catalog)


def resolve_all(catalog: Iterable[Any] | None = None) -> dict[str, RoleResolution]:
    rows, envm, envk = _role_rows(), _env_models(), _env_keepalive()
    return {r: resolve_from(r, rows, envm, envk, catalog) for r in ROLES}


def model_for_role(role: str, catalog: Iterable[Any] | None = None) -> str | None:
    return resolve_role(role, catalog).model
