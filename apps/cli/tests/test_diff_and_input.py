"""Las tres piezas nuevas del turno: filas del diff, portapapeles y cola.

Todo lo que se prueba aquí es lógica pura: nada toca la terminal ni el
portapapeles real, así que corre igual en CI.
"""
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import struct  # noqa: E402
import zlib  # noqa: E402

from lixbon_cli.clipboard import dib_to_png  # noqa: E402
from lixbon_cli.diffs import FileChange, diff_counts, diff_rows  # noqa: E402
from lixbon_cli.inputq import InputQueue, suspend_input  # noqa: E402


# ── Diff ────────────────────────────────────────────────────────────────────

def _change(old: str, new: str) -> FileChange:
    return FileChange("update", "x.py", old, new)


def test_las_filas_llevan_el_numero_de_linea_correcto():
    """El número de una eliminación es del archivo VIEJO; el de una adición,
    del nuevo. Es lo que permite situar el cambio al leer el transcript."""
    rows = diff_rows(_change("a\nb\nc\n", "a\nB\nc\n"), context=1)
    assert rows == [
        ("ctx", 1, 1, "a"),
        ("del", 2, 0, "b"),
        ("add", 0, 2, "B"),
        ("ctx", 3, 3, "c"),
    ]


def test_solo_se_muestra_el_entorno_del_cambio():
    """Un archivo largo con un cambio en medio no arrastra el archivo entero."""
    old = "\n".join(["x"] * 20 + ["viejo"] + ["y"] * 20)
    new = "\n".join(["x"] * 20 + ["nuevo"] + ["y"] * 20)
    rows = diff_rows(_change(old, new), context=2)
    assert [row[0] for row in rows] == ["ctx", "ctx", "del", "add", "ctx", "ctx"]
    assert [row[1] for row in rows if row[0] == "ctx"] == [19, 20, 22, 23]


def test_dos_cambios_separados_se_unen_con_un_hueco():
    old = "\n".join(["uno"] + ["x"] * 20 + ["dos"])
    new = "\n".join(["UNO"] + ["x"] * 20 + ["DOS"])
    rows = diff_rows(_change(old, new), context=2)
    assert [row[0] for row in rows] == [
        "del", "add", "ctx", "ctx", "gap", "ctx", "ctx", "del", "add",
    ]


def test_no_se_marca_hueco_por_una_sola_linea_omitida():
    """Un `…` que oculta UNA línea ocupa lo mismo que la línea."""
    old = "a\nb\nc\nd\ne\n"
    new = "A\nb\nc\nd\nE\n"
    rows = diff_rows(_change(old, new), context=1)
    assert "gap" not in [row[0] for row in rows]


def test_el_diff_no_termina_en_un_hueco_colgando():
    old = "\n".join(["cambio"] + ["igual"] * 30)
    new = "\n".join(["CAMBIO"] + ["igual"] * 30)
    rows = diff_rows(_change(old, new), context=2)
    assert rows[-1][0] == "ctx"


def test_las_cuentas_coinciden_con_las_filas():
    old = "a\nb\nc\nd\n"
    new = "a\nB\nC\nd\ne\n"
    adds, dels = diff_counts(_change(old, new))
    rows = diff_rows(_change(old, new))
    assert adds == sum(1 for r in rows if r[0] == "add")
    assert dels == sum(1 for r in rows if r[0] == "del")


def test_un_archivo_nuevo_es_todo_adiciones():
    rows = diff_rows(FileChange("create", "n.py", "", "uno\ndos\n"))
    assert rows == [("add", 0, 1, "uno"), ("add", 0, 2, "dos")]


# ── Portapapeles ────────────────────────────────────────────────────────────

def _dib(width: int, height: int, bits: int, rows: list[bytes]) -> bytes:
    header = struct.pack("<IiiHHIIiiII", 40, width, height, 1, bits, 0, 0, 0, 0, 0, 0)
    return header + b"".join(rows)


def _png_pixels(png: bytes) -> bytes:
    index = png.index(b"IDAT")
    length = struct.unpack(">I", png[index - 4:index])[0]
    return zlib.decompress(png[index + 4:index + 4 + length])


def test_el_dib_de_windows_se_convierte_a_png_con_los_colores_en_orden():
    """El DIB guarda BGR y de abajo arriba; el PNG quiere RGB y al revés."""
    stride = ((2 * 24 + 31) // 32) * 4
    inferior = bytes([0, 0, 255, 0, 255, 0]) + b"\x00" * (stride - 6)   # rojo, verde
    superior = bytes([255, 0, 0, 255, 255, 255]) + b"\x00" * (stride - 6)  # azul, blanco
    png = dib_to_png(_dib(2, 2, 24, [inferior, superior]))

    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    ancho, alto = struct.unpack(">II", png[16:24])
    assert (ancho, alto) == (2, 2)
    filas = _png_pixels(png)
    assert filas[:7] == bytes([0, 0, 0, 255, 255, 255, 255])   # filtro + azul + blanco
    assert filas[7:] == bytes([0, 255, 0, 0, 0, 255, 0])       # filtro + rojo + verde


def test_el_alfa_se_descarta_en_las_imagenes_de_32_bits():
    """Muchas apps copian con alfa a cero: un PNG RGBA saldría transparente."""
    fila = bytes([10, 20, 30, 0])
    png = dib_to_png(_dib(1, 1, 32, [fila]))
    assert png is not None
    assert struct.unpack("<B", png[25:26])[0] == 2  # color type 2 = RGB, sin alfa
    assert _png_pixels(png) == bytes([0, 30, 20, 10])


def test_los_formatos_raros_se_rechazan_sin_reventar():
    assert dib_to_png(b"") is None
    assert dib_to_png(_dib(2, 2, 8, [b"\x00" * 8])) is None


# ── Cola de entrada ─────────────────────────────────────────────────────────

class _FakeQueue(InputQueue):
    """Misma cola, con la lista de teclas en vez de la consola."""

    def __init__(self):
        super().__init__()
        self.keys: list[str] = []
        self.keys_lock = threading.Lock()

    def _enter_mode(self):
        return True

    def _exit_mode(self):
        return None

    def _read_char(self):
        with self.keys_lock:
            if self.keys:
                return self.keys.pop(0)
        time.sleep(0.005)
        return None

    def type(self, text: str):
        with self.keys_lock:
            self.keys.extend(text)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            with self.keys_lock:
                if not self.keys:
                    break
            time.sleep(0.005)
        time.sleep(0.05)  # margen para que el hilo procese la última tecla


def test_enter_encola_la_linea_y_deja_el_buffer_limpio():
    queue = _FakeQueue()
    assert queue.start()
    try:
        queue.type("/status\rsigo escribiendo")
        assert queue.queued == 1
        assert queue.typing == "sigo escribiendo"
        assert queue.drain() == ["/status"]
        assert queue.queued == 0
    finally:
        queue.stop()


def test_lo_escrito_sin_enter_sobrevive_para_el_prompt():
    queue = _FakeQueue()
    queue.start()
    queue.type("a medias")
    queue.stop()
    assert queue.take_partial() == "a medias"
    assert queue.take_partial() == ""


def test_ctrl_c_pide_interrumpir_y_borra_lo_escrito():
    queue = _FakeQueue()
    queue.start()
    try:
        queue.type("texto\x03")
        assert queue.interrupted is True
        assert queue.typing == ""
    finally:
        queue.stop()


def test_suspend_input_cede_el_teclado_y_lo_devuelve():
    """Mientras hay un selector abierto, la cola no puede robar teclas."""
    queue = _FakeQueue()
    queue.start()
    try:
        queue.type("hola")
        with suspend_input():
            with queue.keys_lock:
                queue.keys.extend("ROBADO")
            time.sleep(0.15)
            assert queue.typing == "hola"
        queue.type("")
        assert queue.typing == "holaROBADO"
    finally:
        queue.stop()


def test_backspace_y_escape_editan_lo_tecleado():
    queue = _FakeQueue()
    queue.start()
    try:
        queue.type("abcd\x08\x08")
        assert queue.typing == "ab"
        queue.type("\x1b")
        assert queue.typing == ""
    finally:
        queue.stop()
