"""
Regresión del formato de `keep_alive` (residencia del modelo en VRAM).

Ollama parsea el string con `time.ParseDuration` de Go, que exige unidad. Medido
contra Ollama 0.31.1: `keep_alive: -1` → 200, pero `keep_alive: "-1"` → **400**
`time: missing unit in duration "-1"`. Como `-1` es el default del rol `embed`
(0.3 GB, residente), sin la conversión se rompían TODOS los embeddings.
"""
from core.inference.ollama import coerce_keep_alive


def test_los_enteros_viajan_como_numero():
    """`-1` (permanente) y `0` (descargar ya) NO son duraciones válidas de Go."""
    assert coerce_keep_alive("-1") == -1
    assert coerce_keep_alive("0") == 0
    assert coerce_keep_alive("300") == 300
    assert all(isinstance(coerce_keep_alive(v), int) for v in ("-1", "0", "300"))


def test_las_duraciones_se_dejan_como_string():
    for valor in ("30m", "60s", "1h", "10m30s"):
        assert coerce_keep_alive(valor) == valor


def test_vacio_y_none_no_ponen_la_clave():
    """None ⇒ el llamador NO añade `keep_alive` y Ollama usa su default (5m)."""
    assert coerce_keep_alive(None) is None
    assert coerce_keep_alive("") is None
    assert coerce_keep_alive("   ") is None


def test_los_enteros_ya_tipados_pasan_tal_cual():
    assert coerce_keep_alive(-1) == -1
    assert coerce_keep_alive(0) == 0


def test_se_ignoran_los_espacios():
    assert coerce_keep_alive("  -1  ") == -1
    assert coerce_keep_alive("  30m  ") == "30m"


def test_el_cero_no_se_confunde_con_ausencia():
    """`0` significa "descárgalo ya", no "sin configurar": el llamador usa
    `is not None`, no la veracidad del valor."""
    assert coerce_keep_alive("0") is not None
