"""Horario de los agentes y lectura de su respuesta (sin base de datos)."""
from datetime import datetime, timezone

import pytest

from core.gateway.agentes import interpretar
from core.persistence.espacios import ErrorEspacio, proxima_ejecucion


def _utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def test_mismo_dia_si_aun_no_llega_la_hora():
    # Lunes 2 nov 2026, 09:00 en Bogotá (14:00 UTC); toca lunes a las 10:00.
    r = proxima_ejecucion([0], "10:00", "America/Bogota", _utc(2026, 11, 2, 14, 0))
    assert r == _utc(2026, 11, 2, 15, 0)


def test_salta_al_siguiente_dia_elegido():
    # Lunes a las 10:30 en Bogotá: ya pasó; el siguiente es el miércoles.
    r = proxima_ejecucion([0, 2], "10:00", "America/Bogota", _utc(2026, 11, 2, 15, 30))
    assert r == _utc(2026, 11, 4, 15, 0)


def test_a_la_hora_exacta_pasa_a_la_semana_siguiente():
    r = proxima_ejecucion([0], "10:00", "UTC", _utc(2026, 11, 2, 10, 0))
    assert r == _utc(2026, 11, 9, 10, 0)


def test_cambio_de_horario_europeo():
    # Madrid pasa de UTC+2 a UTC+1 el 25 oct 2026: las 10:00 locales son las 09:00 UTC.
    r = proxima_ejecucion([0], "10:00", "Europe/Madrid", _utc(2026, 10, 24, 12, 0))
    assert r == _utc(2026, 10, 26, 9, 0)


def test_zona_invalida():
    with pytest.raises(ErrorEspacio):
        proxima_ejecucion([0], "10:00", "Marte/Olympus", _utc(2026, 11, 2))


def test_interpreta_json_del_modelo():
    d = interpretar('{"resultado": "# Hola", "hizo": ["Escribió el post"], "siguientes": "Revisarlo",'
                    ' "necesita_usuario": true, "memoria": ["Los martes no se publica"]}')
    assert d["resultado"] == "# Hola"
    assert d["hizo"] == ["Escribió el post"]
    assert d["siguientes"] == ["Revisarlo"]
    assert d["tener_en_cuenta"] == []
    assert d["necesita_usuario"] is True
    assert d["memoria"] == ["Los martes no se publica"]


def test_interpreta_json_dentro_de_bloque_de_codigo():
    d = interpretar('```json\n{"resultado": "listo"}\n```')
    assert d["resultado"] == "listo"


def test_texto_que_no_es_json_es_el_resultado():
    d = interpretar("Aquí tienes el resumen de hoy.")
    assert d["resultado"] == "Aquí tienes el resumen de hoy."
    assert d["hizo"] == []


def test_modelo_del_rol_si_esta_en_el_catalogo():
    from core.gateway.agentes import _modelo_disponible
    cat = [{"id": "qwen3.5:2b", "capabilities": ["completion"]}, {"id": "deepseek-r1:8b"}]
    assert _modelo_disponible(cat, "deepseek-r1:8b") == "deepseek-r1:8b"


def test_sin_el_modelo_del_rol_usa_uno_de_chat():
    from core.gateway.agentes import _modelo_disponible
    cat = [{"id": "nomic-embed-text", "capabilities": ["embedding"]}, {"id": "qwen3.5:2b", "capabilities": ["completion"]}]
    assert _modelo_disponible(cat, "deepseek-r1:8b") == "qwen3.5:2b"
