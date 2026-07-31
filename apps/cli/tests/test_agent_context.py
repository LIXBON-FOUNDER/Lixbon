"""Presupuesto de contexto del turno de agente y fin de turno explícito.

Regresión del bug que hacía inservible el modo agente: tras 10-15 minutos de
trabajo el historial (con los resultados de cada herramienta dentro) superaba el
`num_ctx` pedido a Ollama. Ollama no falla en ese caso: descarta el principio
del prompt, que es donde van el system prompt y las definiciones de
herramientas. El modelo se quedaba sin instrucciones, "pensaba" el tiempo de
reprocesar toda la ventana y devolvía vacío — el turno terminaba en silencio y
el agente parecía congelado. Y seguía igual al mensaje siguiente, porque el
historial no adelgazaba.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli.agent import MAX_AGENT_STEPS, run_agent_turn  # noqa: E402
from lixbon_cli.context import (  # noqa: E402
    clip_tool_output,
    estimate_tokens,
    fit_history,
    prompt_budget,
    shrink_old_results,
)


def _agent_history(steps: int, result_chars: int = 8000) -> list[dict]:
    """Historial típico de un turno largo: leer archivos una y otra vez."""
    history = [{"role": "user", "content": "arregla el bug del login"}]
    for i in range(steps):
        history.append({"role": "assistant", "content": "",
                        "tool_calls": [{"id": f"c{i}", "function": {
                            "name": "read_file", "arguments": '{"path":"app.py"}'}}]})
        history.append({"role": "tool", "content": "X" * result_chars,
                        "name": "read_file", "tool_call_id": f"c{i}"})
    return history


# ── presupuesto ─────────────────────────────────────────────────────────────

def test_clip_conserva_principio_y_final():
    # El principio importa en un read_file (imports) y el final en un
    # run_command (el error y el código de salida): se recorta por el medio.
    text = "INICIO" + ("x" * 50000) + "FINAL"
    clipped = clip_tool_output(text, 1000)
    assert clipped.startswith("INICIO")
    assert clipped.endswith("FINAL")
    assert len(clipped) < 1200


def test_clip_no_toca_lo_que_ya_cabe():
    assert clip_tool_output("corto") == "corto"


def test_presupuesto_descuenta_tools_y_system():
    solo = prompt_budget(16384)
    con_tools = prompt_budget(16384, [{"function": {"name": "x" * 4000}}], system_tokens=500)
    assert con_tools < solo
    assert con_tools >= 512  # nunca deja un presupuesto imposible


def test_fit_history_hace_caber_un_turno_largo():
    history = _agent_history(30)
    assert estimate_tokens(history) > 50000  # desbordaba cualquier ventana

    fitted, pruned = fit_history(history, 6000)
    assert pruned
    assert estimate_tokens(fitted) <= 6000


def test_fit_history_conserva_la_peticion_original():
    # Sin la petición original el modelo olvida qué se le pidió y responde
    # cualquier cosa: es lo primero que hay que salvar al podar.
    fitted, _ = fit_history(_agent_history(30), 6000)
    assert fitted[0]["role"] == "user"
    assert "login" in fitted[0]["content"]


def test_fit_history_no_deja_resultados_huerfanos():
    # Un role="tool" al principio, sin el assistant que lo pidió, rompe el
    # template del modelo: otra forma de acabar con una respuesta vacía.
    fitted, _ = fit_history(_agent_history(30), 6000)
    for msg in fitted:
        if msg["role"] == "tool":
            break
        assert not (msg.get("content") or "").startswith("TOOL_RESULT")
    resto = fitted[1:]  # tras la petición original
    assert resto[0]["role"] != "tool"


def test_fit_history_no_toca_lo_que_ya_cabe():
    corto = [{"role": "user", "content": "hola"}, {"role": "assistant", "content": "qué tal"}]
    fitted, pruned = fit_history(corto, 8000)
    assert not pruned
    assert fitted == corto


def test_shrink_respeta_los_pasos_recientes():
    history = _agent_history(10)
    shrunk = shrink_old_results(history, keep_recent=4)
    assert len(shrunk[-1]["content"]) == 8000        # el paso en curso, intacto
    assert len(shrunk[2]["content"]) < 8000          # los viejos, adelgazados


# ── el turno nunca acaba en silencio ────────────────────────────────────────

class _FakeStream:
    """Modelo de mentira: devuelve las respuestas que se le den, en orden.

    `reasonings` simula el canal `thinking` de Ollama, que es por donde los
    modelos de razonamiento mandan (a veces) la llamada a la herramienta.
    """

    def __init__(self, replies, reasonings=None, session=None):
        self.replies = list(replies)
        self.reasonings = list(reasonings or [])
        self.session = session
        self.calls = []

    def __call__(self, messages, tools):
        self.calls.append(messages)
        reply = self.replies.pop(0) if self.replies else ""
        if self.session is not None:
            self.session["last_reasoning"] = (
                self.reasonings.pop(0) if self.reasonings else "")
        return reply, []


def test_respuesta_vacia_se_reintenta_liberando_contexto(tmp_path):
    # Antes: el turno terminaba devolviendo "" y el CLI volvía al prompt sin
    # decir nada (el síntoma que el usuario veía como "se congela y para").
    stream = _FakeStream(["", "", "Ya está: corregido el login."])
    session = {"native_tools": True, "auto_approve": True, "context_window": 8192}
    answer, _ = run_agent_turn(_agent_history(20), tmp_path, session, stream)

    assert len(stream.calls) == 3           # reintentó en vez de rendirse
    assert "corregido el login" in answer


def test_reintentar_no_borra_la_conversacion(tmp_path):
    # El reintento podaba el historial de trabajo, así que la conversación del
    # usuario desaparecía (la barra de contexto se quedaba en 1 %).
    historia = _agent_history(20)
    stream = _FakeStream(["", "Listo."])
    session = {"native_tools": True, "auto_approve": True, "context_window": 8192}
    _, working = run_agent_turn(historia, tmp_path, session, stream)

    assert working[0]["content"] == historia[0]["content"]
    assert len(working) >= len(historia)


def test_la_llamada_escondida_en_el_razonamiento_se_rescata(tmp_path):
    # qwen3.5:9b y otros modelos thinking deciden la herramienta DENTRO del
    # bloque de pensamiento: Ollama la manda por `thinking` y nunca llega como
    # content ni como tool_call. Ignorarlo era ver "pensó 12 s" y nada más.
    (tmp_path / "index.html").write_text("<h1>hola</h1>", encoding="utf-8")
    session = {"native_tools": False, "auto_approve": True, "context_window": 8192}
    stream = _FakeStream(
        ["", "Ya lo he leído."],
        reasonings=['Debería mirar el archivo: {"tool":"read_file","args":{"path":"index.html"}}',
                    ""],
        session=session,
    )
    answer, working = run_agent_turn([{"role": "user", "content": "lee el html"}],
                                     tmp_path, session, stream)

    assert "leído" in answer
    resultados = [m for m in working if (m.get("content") or "").startswith("TOOL_RESULT")]
    assert resultados and "hola" in resultados[0]["content"]


def test_razonar_sin_responder_pide_el_paso_concreto(tmp_path):
    # Sin llamada que rescatar, repetir la petición tal cual le hace razonar lo
    # mismo otra vez: hay que pedirle el paso concreto.
    session = {"native_tools": False, "auto_approve": True, "context_window": 8192}
    stream = _FakeStream(["", "Hecho."],
                         reasonings=["Mmm, déjame pensar cómo abordarlo…", ""],
                         session=session)
    answer, _ = run_agent_turn([{"role": "user", "content": "arregla el css"}],
                               tmp_path, session, stream)

    empujon = stream.calls[1][-1]
    assert empujon["role"] == "user"
    assert "NO vuelvas a razonar" in empujon["content"]
    assert answer == "Hecho."


def test_respuesta_vacia_persistente_lo_dice(tmp_path):
    session = {"native_tools": True, "auto_approve": True, "context_window": 8192}
    stream = _FakeStream(["", "", "", ""],
                         reasonings=["pienso", "pienso", "pienso", "pienso"],
                         session=session)
    answer, _ = run_agent_turn([{"role": "user", "content": "haz algo"}], tmp_path, session, stream)

    assert answer.strip()                    # nunca vuelve en blanco
    assert "responder" in answer.lower()     # y explica qué le pasa al modelo


def test_bucle_de_la_misma_llamada_se_corta_con_explicacion(tmp_path):
    repetida = '{"tool":"list_files","args":{"path":"."}}'
    stream = _FakeStream([repetida] * 10)
    session = {"native_tools": False, "auto_approve": True, "context_window": 8192}
    answer, _ = run_agent_turn([{"role": "user", "content": "lista"}], tmp_path, session, stream)

    assert "repitiendo" in answer.lower()
    assert len(stream.calls) < 10           # cortó antes de agotar los pasos


def test_el_prompt_del_agente_cabe_en_la_ventana(tmp_path):
    # Lo que de verdad arregla el bug: por muy largo que sea el historial, lo
    # que se manda al modelo cabe en la ventana con su system prompt dentro.
    (tmp_path / "app.py").write_text("print('hola')", encoding="utf-8")
    stream = _FakeStream(["Listo."])
    session = {"native_tools": True, "auto_approve": True, "context_window": 8192}
    run_agent_turn(_agent_history(40), tmp_path, session, stream)

    enviado = stream.calls[0]
    assert enviado[0]["role"] == "system"           # el system prompt sobrevive
    assert estimate_tokens(enviado) < 8192


def test_el_tope_de_pasos_es_amplio_y_se_explica(tmp_path):
    # 12 pasos se agotaban en una tarea real y el turno moría con un mensaje
    # de fallo. Ahora hay margen y, si se llega, se dice cómo continuar.
    assert MAX_AGENT_STEPS >= 30
    stream = _FakeStream(['{"tool":"list_files","args":{"path":"."}}'] * 200)
    # argumentos alternos para que no lo pare el detector de bucles
    stream.replies = [f'{{"tool":"list_files","args":{{"path":".","n":{i}}}}}'
                      for i in range(200)]
    session = {"native_tools": False, "auto_approve": True, "context_window": 8192}
    answer, _ = run_agent_turn([{"role": "user", "content": "explora"}], tmp_path, session, stream)

    assert len(stream.calls) == MAX_AGENT_STEPS
    assert "continúa" in answer.lower()
