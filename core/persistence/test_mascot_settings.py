# Preferencias de la mascota dentro de settings_json: defaults, mezcla parcial
# y que nada fuera de lo conocido llegue a guardarse. Sin base de datos.
import json

from core.persistence.queries import MASCOT_DEFAULTS, _clean_mascot, _parse_settings


def test_sin_guardar_devuelve_defaults():
    s = _parse_settings(None)
    assert s["mascot"] == MASCOT_DEFAULTS
    assert s["save_history"] is True


def test_mezcla_parcial_sobre_lo_guardado():
    guardado = _clean_mascot({"personaje": "leya", "dormir_min": 10})
    nuevo = _clean_mascot({"activa": False}, guardado)
    assert nuevo["personaje"] == "leya"
    assert nuevo["dormir_min"] == 10
    assert nuevo["activa"] is False


def test_descarta_claves_y_valores_invalidos():
    m = _clean_mascot({
        "personaje": "pikachu",     # enum desconocido
        "activa": "si",             # no es bool
        "latigo_min": 999,          # se recorta al rango
        "dormir_min": True,         # bool no cuenta como número
        "<script>": 1,              # clave desconocida
    })
    assert m["personaje"] == "gael"
    assert m["activa"] is True
    assert m["latigo_min"] == 30
    assert m["dormir_min"] == 5
    assert "<script>" not in m


def test_settings_json_corrupto_o_raro():
    assert _parse_settings("no es json")["mascot"] == MASCOT_DEFAULTS
    assert _parse_settings(json.dumps({"mascot": "texto"}))["mascot"] == MASCOT_DEFAULTS
    s = _parse_settings(json.dumps({"mascot": {"guia": False}, "save_history": False}))
    assert s["mascot"]["guia"] is False
    assert s["save_history"] is False


def test_web_e_ide_son_independientes():
    s = _parse_settings(json.dumps({"mascot": {"personaje": "leya"}, "mascot_ide": {"personaje": "gael", "latigo": False}}))
    assert s["mascot"]["personaje"] == "leya"
    assert s["mascot_ide"]["personaje"] == "gael"
    assert s["mascot_ide"]["latigo"] is False
    assert s["mascot"]["latigo"] is True
    assert _parse_settings(None)["mascot_ide"] == MASCOT_DEFAULTS
