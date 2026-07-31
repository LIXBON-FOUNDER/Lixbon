"""Historial persistente de conversaciones (/history, /new, /clear).

Antes no existía: `/history` mostraba los mensajes de la sesión en curso para
reenviar uno, `/clear` solo borraba la pantalla dejando vivo el contexto, y al
cerrar el CLI se perdía todo lo hablado.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli.sessions import (  # noqa: E402
    SessionStore,
    derive_title,
    relative_time,
)


def _store(tmp_path) -> SessionStore:
    return SessionStore(tmp_path)


def test_una_sesion_se_guarda_y_se_recupera_entera(tmp_path):
    store = _store(tmp_path)
    mensajes = [
        {"role": "user", "content": "crea una API REST"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "function": {"name": "write_file", "arguments": "{}"}}]},
        {"role": "tool", "content": "Archivo creado: api.py", "name": "write_file"},
        {"role": "assistant", "content": "Listo: creé api.py."},
    ]
    store.save("s-1", mensajes, model="qwen", mode="agent", workspace="/proj")

    recuperada = store.load("s-1")
    assert recuperada["messages"] == mensajes      # incluidas las herramientas
    assert recuperada["model"] == "qwen"
    assert recuperada["workspace"] == "/proj"


def test_las_sesiones_se_listan_de_la_mas_reciente_a_la_mas_vieja(tmp_path):
    store = _store(tmp_path)
    store.save("vieja", [{"role": "user", "content": "Corregir Docker"}])
    time.sleep(0.02)
    store.save("nueva", [{"role": "user", "content": "Proyecto Lixbon"}])

    titulos = [s["title"] for s in store.list_sessions()]
    assert titulos == ["Proyecto Lixbon", "Corregir Docker"]


def test_la_cabecera_cuenta_mensajes_y_herramientas(tmp_path):
    store = _store(tmp_path)
    store.save("s-1", [
        {"role": "user", "content": "arregla esto"},
        {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "edit_file"}}]},
        {"role": "tool", "content": "editado", "name": "edit_file"},
        {"role": "assistant", "content": "hecho"},
    ])
    cabecera = store.list_sessions()[0]
    assert cabecera["messages"] == 2   # lo que se lee como conversación
    assert cabecera["tools"] == 2      # la llamada y su resultado


def test_guardar_de_nuevo_conserva_la_fecha_de_creacion(tmp_path):
    # La lista ordena por última modificación, pero cada conversación tiene que
    # recordar cuándo empezó.
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "hola"}])
    creada = store.load("s-1")["created_at"]
    time.sleep(0.02)
    store.save("s-1", [{"role": "user", "content": "hola"},
                       {"role": "assistant", "content": "qué tal"}])
    despues = store.load("s-1")
    assert despues["created_at"] == creada
    assert despues["updated_at"] > creada


def test_una_sesion_sin_conversacion_real_no_se_guarda(tmp_path):
    # Abrir el CLI y cerrarlo no debe dejar una conversación vacía en la lista.
    store = _store(tmp_path)
    store.save("vacia", [])
    store.save("solo-espacios", [{"role": "user", "content": "   "}])
    store.save("solo-tools", [{"role": "user", "content": "TOOL_RESULT read_file: x"}])
    assert store.list_sessions() == []


def test_el_indice_se_reconstruye_si_se_pierde(tmp_path):
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "algo"}])
    store.index_file.unlink()

    assert len(SessionStore(tmp_path).list_sessions()) == 1


def test_un_indice_corrupto_no_tumba_el_listado(tmp_path):
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "algo"}])
    store.index_file.write_text("{no es json", encoding="utf-8")

    assert len(store.list_sessions()) == 1  # se rehace leyendo los archivos


def test_los_mensajes_enormes_se_acotan_en_disco(tmp_path):
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "lee el archivo"},
                       {"role": "assistant", "content": "y" * 500000}])
    guardado = store.load("s-1")["messages"][1]["content"]
    assert len(guardado) < 21000


def test_las_imagenes_no_se_persisten(tmp_path):
    # base64 multiplicaría el tamaño del archivo y no se puede reenviar sin el
    # original de todos modos.
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "mira esto", "images": ["AAAA" * 10000]}])
    guardado = store.load("s-1")["messages"][0]
    assert "images" not in guardado
    assert "[imagen adjunta]" in guardado["content"]


def test_borrar_una_sesion(tmp_path):
    store = _store(tmp_path)
    store.save("s-1", [{"role": "user", "content": "algo"}])
    assert store.delete("s-1")
    assert store.list_sessions() == []
    assert store.load("s-1") is None


def test_titulo_derivado_del_primer_mensaje_util():
    assert derive_title([{"role": "user", "content": "  Crear   API REST  "}]) == "Crear API REST"
    # Los resultados de herramientas no son un título
    assert derive_title([{"role": "user", "content": "TOOL_RESULT read_file: x"},
                         {"role": "user", "content": "Corregir Docker"}]) == "Corregir Docker"
    assert derive_title([{"role": "assistant", "content": "hola"}]) == "Sin título"


def test_fechas_relativas():
    ahora = time.time()
    assert relative_time(ahora) == "ahora"
    assert relative_time(ahora - 7200) == "hace 2 horas"
    assert relative_time(ahora - 86400 * 2) == "hace 2 días"
    assert relative_time(ahora - 86400 * 60) == "hace 2 meses"
