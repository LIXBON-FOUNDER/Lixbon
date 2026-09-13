"""Alias públicos de modelo: `lixbon-1` → `qwen3.5:27b`.

El catálogo que ven los clientes lleva el alias como `id` y un `name` legible;
el modelo real solo circula dentro del gateway (enrutado, tarifas, nodos). Con
al menos un alias definido, los modelos sin alias quedan fuera del catálogo de
los usuarios normales (los admins los siguen viendo).
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any

logger = logging.getLogger("lixbon.aliases")

_TTL_S = 60
_cache: dict[str, Any] = {"at": 0.0, "rows": []}

ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def alias_rows() -> list[dict[str, Any]]:
    now = time.monotonic()
    if now - _cache["at"] > _TTL_S:
        try:
            from core.persistence.queries import list_model_aliases
            _cache["rows"] = list_model_aliases(active_only=True)
        except Exception as exc:
            logger.warning(f"No se pudieron cargar los alias de modelo ({exc})")
        _cache["at"] = now
    return _cache["rows"]


def invalidate_aliases_cache() -> None:
    _cache["at"] = 0.0
    _cache["rows"] = []


def to_real(model: str | None, rows: list[dict[str, Any]] | None = None) -> str | None:
    """El modelo que hay que pedir a Ollama. Un id que no es alias vuelve tal cual."""
    if not model:
        return model
    for row in rows if rows is not None else alias_rows():
        if row["alias"] == model:
            return row["model"]
    return model


def to_public(model: str | None, rows: list[dict[str, Any]] | None = None) -> str | None:
    """El id con el que se enseña un modelo real (su alias si lo tiene)."""
    if not model:
        return model
    for row in rows if rows is not None else alias_rows():
        if row["model"] == model:
            return row["alias"]
    return model


def public_catalog(catalog: list[dict[str, Any]], include_raw: bool = False,
                   rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Catálogo para clientes: una entrada por alias (con los datos del modelo
    real: capacidades, tamaño, contexto) y, si `include_raw` o no hay alias,
    también los modelos sin alias."""
    rows = rows if rows is not None else alias_rows()
    by_id = {str(e.get("id")): e for e in catalog if isinstance(e, dict)}
    out: list[dict[str, Any]] = []
    aliased_real: set[str] = set()
    for row in sorted(rows, key=lambda r: (r.get("sort_order") or 0, r["alias"])):
        real = by_id.get(row["model"])
        if real is None:
            continue  # el modelo real no está en ningún nodo ahora mismo
        aliased_real.add(row["model"])
        out.append({**real, "id": row["alias"], "name": row["name"], "model": row["model"],
                    "description": row.get("description") or "", "alias": True})
    if include_raw or not rows:
        for entry in catalog:
            if not isinstance(entry, dict):
                out.append(entry)
            elif entry.get("id") not in aliased_real:
                out.append({**entry, "name": entry.get("name") or entry.get("id")})
    return out
