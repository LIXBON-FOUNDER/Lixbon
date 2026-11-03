"""Compactación: el principio del prompt queda fijo entre compactaciones."""
import asyncio

from core.inference import compaction as c
from core.inference.context import PREFIJO_RESUMEN, desglose, estimate_tokens

VENTANA = 4096


def _historia(n, largo=600):
    msgs = [{"role": "system", "content": "Eres Lixbon."}]
    for i in range(n):
        msgs.append({"role": "user", "content": f"pregunta {i} " + "u" * largo})
        msgs.append({"role": "assistant", "content": f"respuesta {i} " + "a" * largo})
    return msgs


class Resumidor:
    def __init__(self):
        self.llamadas = []

    async def __call__(self, previo, tramo):
        self.llamadas.append((previo, len(tramo)))
        return f"resumen de {len(tramo)} (antes: {previo is not None})", {"prompt_tokens": 100, "completion_tokens": 20,
                                                                          "cached_tokens": 0}


def _correr(msgs, guardado, resumir):
    return asyncio.run(c.compactar(msgs, VENTANA, guardado, resumir))


def test_si_cabe_no_toca_nada():
    msgs = _historia(2)
    r = _correr(msgs, None, Resumidor())
    assert r.messages == msgs and r.guardar is None and r.compactados == 0


def test_compacta_una_vez_y_luego_reutiliza_el_resumen():
    msgs = _historia(12)
    resumir = Resumidor()
    r = _correr(msgs, None, resumir)
    assert r.guardar and r.compactados > 0
    assert estimate_tokens(r.messages) <= c.presupuesto(VENTANA)
    assert r.messages[0]["content"] == "Eres Lixbon."
    assert r.messages[1]["content"].startswith(PREFIJO_RESUMEN)
    assert r.messages[2]["role"] == "user"            # no se parte un intercambio
    assert r.messages[-1] == msgs[-1]                 # lo último siempre va
    assert r.uso["prompt_tokens"] == 100 * len(resumir.llamadas)

    # Siguiente mensaje: mismo principio (system + resumen), sin resumir otra vez.
    siguiente = msgs + [{"role": "assistant", "content": "ok"}, {"role": "user", "content": "¿y ahora?"}]
    r2 = _correr(siguiente, r.guardar, resumir_nuevo := Resumidor())
    assert resumir_nuevo.llamadas == []
    assert r2.messages[:2] == r.messages[:2]
    assert r2.messages[-1]["content"] == "¿y ahora?"


def test_otra_historia_no_aplica_el_resumen():
    msgs = _historia(12)
    r = _correr(msgs, None, Resumidor())
    editada = [dict(m) for m in msgs]
    editada[1]["content"] = "otra pregunta"       # el usuario editó un mensaje antiguo
    resumir = Resumidor()
    r2 = _correr(editada, r.guardar, resumir)
    assert resumir.llamadas and resumir.llamadas[0][0] is None   # resume de nuevo, sin el resumen viejo
    assert r2.guardar["digest"] != r.guardar["digest"]


def test_al_volver_a_llenarse_resume_sobre_el_resumen_previo():
    msgs = _historia(12)
    r = _correr(msgs, None, Resumidor())
    mas = msgs + _historia(12)[1:]
    resumir = Resumidor()
    r2 = _correr(mas, r.guardar, resumir)
    assert resumir.llamadas[0][0] == r.guardar["summary"]
    assert r2.guardar["upto"] > r.guardar["upto"]


def test_si_resumir_falla_devuelve_lo_que_hay():
    async def falla(previo, tramo):
        raise RuntimeError("nodo caído")
    msgs = _historia(12)
    r = _correr(msgs, None, falla)
    assert r.messages == msgs and r.guardar is None


def test_un_solo_mensaje_enorme_no_se_resume():
    msgs = [{"role": "system", "content": "x"}, {"role": "user", "content": "u" * 50_000}]
    r = _correr(msgs, None, Resumidor())
    assert r.guardar is None


def test_el_desglose_cuenta_el_resumen_aparte():
    msgs = [{"role": "system", "content": "s" * 300}, c.mensaje_resumen("r" * 300),
            {"role": "user", "content": "u" * 300}]
    d = desglose(msgs, None, 900)
    assert d["summary"] > 0 and d["system"] > 0 and sum(d.values()) == 900
