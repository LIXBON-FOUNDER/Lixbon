"""Saneado de los prompts remotos con adjuntos y menciones."""
import pytest
from fastapi import HTTPException

from core.gateway.routers.remote import (
    MAX_ATTACHMENTS,
    MAX_DOC_CHARS,
    _clean_attachments,
    _clean_mentions,
)


def test_adjuntos_validos_y_basura_descartada():
    out = _clean_attachments([
        {"kind": "doc", "name": "a.pdf", "text": "x" * (MAX_DOC_CHARS + 50)},
        {"kind": "image", "name": "f.jpg", "base64": "AAAA"},
        {"kind": "doc", "name": "vacío", "text": "   "},
        {"kind": "audio", "name": "nota.m4a"},
        "no es un dict",
    ])
    assert [a["kind"] for a in out] == ["doc", "image"]
    assert len(out[0]["text"]) == MAX_DOC_CHARS
    assert out[1]["mime"] == "image/jpeg"


def test_demasiados_adjuntos():
    with pytest.raises(HTTPException) as exc:
        _clean_attachments([{"kind": "doc", "name": "a", "text": "x"}] * (MAX_ATTACHMENTS + 1))
    assert exc.value.status_code == 422


def test_imagenes_demasiado_pesadas():
    with pytest.raises(HTTPException) as exc:
        _clean_attachments([{"kind": "image", "name": "a", "base64": "A" * (5 * 1024 * 1024)}] * 2)
    assert exc.value.status_code == 413


def test_menciones_solo_con_ruta():
    out = _clean_mentions([{"path": "src/app.js", "name": "app.js", "rel": "src/app.js"}, {"name": "sin ruta"}])
    assert out == [{"path": "src/app.js", "name": "app.js", "rel": "src/app.js"}]
