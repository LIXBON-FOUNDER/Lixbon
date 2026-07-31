"""Presupuesto de la ventana de contexto del turno de agente.

Por qué existe: en modo agent el historial NO son solo los mensajes del chat;
son también los resultados de cada herramienta. Un `read_file` puede aportar
100 000 caracteres y un `run_command` varios miles, así que en pocos pasos el
prompt supera el `num_ctx` que se le pide a Ollama.

Y cuando eso pasa Ollama no da error: descarta el principio del prompt, que es
justo donde viven el system prompt y las definiciones de herramientas. El
modelo se queda sin instrucciones y sin tools, "razona" un rato (el tiempo de
reprocesar toda la ventana, decenas de segundos) y devuelve una respuesta vacía
o sin ninguna llamada. El turno termina en silencio y el agente parece
congelado — y sigue igual con el mensaje siguiente, porque el historial no ha
adelgazado.

Aquí se resuelve en dos niveles:

1. `clip_tool_output` recorta lo que un resultado de herramienta APORTA AL
   MODELO (el usuario sigue viendo la salida completa en pantalla).
2. `fit_history` poda mensajes enteros —por fronteras seguras, sin romper el
   round-trip de tool-calling— hasta que el prompt cabe en el presupuesto.
"""

# Fracción de la ventana que puede ocupar el PROMPT. El resto queda para que el
# modelo genere: sin margen, un prompt que "cabe justo" deja al modelo sin sitio
# para responder y la respuesta sale vacía o truncada.
PROMPT_BUDGET_RATIO = 0.65

# Estimación conservadora. El código y el JSON de las herramientas tienen peor
# ratio que la prosa (~3 chars/token frente a ~4), y quedarse corto en la
# estimación es lo que provoca el desbordamiento que este módulo evita.
CHARS_PER_TOKEN = 3.2

# Lo que un resultado de herramienta puede aportar al contexto del modelo.
# Suficiente para que razone sobre un archivo o la salida de un comando, lejos
# del orden de magnitud que reventaba la ventana.
MAX_TOOL_OUTPUT_CHARS = 6000

# Los resultados que ya no son el último paso valen aún menos: el modelo suele
# necesitar el detalle solo del turno que está resolviendo.
MAX_OLD_TOOL_OUTPUT_CHARS = 1200

# Mensajes recientes que nunca se podan (el paso en curso y su contexto
# inmediato): sin ellos el modelo pierde el hilo de lo que acaba de hacer.
KEEP_RECENT = 6

CLIP_MARK = "\n…[recortado: {omitted} caracteres omitidos]…\n"
PRUNE_NOTE = ("[Nota del sistema: los pasos más antiguos de este turno se han "
              "recortado para no desbordar la ventana de contexto. Si necesitas "
              "algo de un archivo que ya leíste, vuelve a leerlo.]")


def estimate_tokens(messages: list[dict]) -> int:
    """Tokens aproximados que ocupa una lista de mensajes.

    Incluye el JSON de los `tool_calls`: en modo nativo el argumento `content`
    de un write_file viaja ahí y es lo más pesado del mensaje.
    """
    chars = 0
    for m in messages:
        chars += len(m.get("content") or "")
        calls = m.get("tool_calls")
        if calls:
            chars += sum(len(str(c)) for c in calls)
        # Cada mensaje paga además los tokens del template (rol, separadores).
        chars += 16
    return int(chars / CHARS_PER_TOKEN)


def tools_tokens(tools: list[dict] | None) -> int:
    """Coste de las definiciones de herramientas, que Ollama inyecta en el
    template. Son ~700 tokens que hay que descontar del presupuesto."""
    if not tools:
        return 0
    return int(len(str(tools)) / CHARS_PER_TOKEN)


def clip_tool_output(text: str, limit: int = MAX_TOOL_OUTPUT_CHARS) -> str:
    """Recorta por el MEDIO un resultado de herramienta.

    Por el medio y no por el final a propósito: en un `read_file` importa el
    principio (imports, cabecera) y en un `run_command` importa el final (el
    error y el código de salida). Cortando por el medio se conservan ambos.
    """
    if not text or len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    omitted = len(text) - limit
    return text[:head] + CLIP_MARK.format(omitted=omitted) + text[-tail:]


def _is_tool_result(msg: dict) -> bool:
    """¿El mensaje es el resultado de una herramienta?

    Cubre los dos protocolos: `role="tool"` (tool-calling nativo) y el mensaje
    de usuario `TOOL_RESULT …` (protocolo de texto).
    """
    if msg.get("role") == "tool":
        return True
    return (msg.get("role") == "user"
            and (msg.get("content") or "").lstrip().startswith("TOOL_RESULT"))


def shrink_old_results(messages: list[dict],
                       keep_recent: int = KEEP_RECENT,
                       limit: int = MAX_OLD_TOOL_OUTPUT_CHARS) -> list[dict]:
    """Recorta más los resultados de herramienta que ya no son recientes.

    Es la poda barata: conserva la ESTRUCTURA del turno (el modelo sigue viendo
    qué hizo y en qué orden) y solo adelgaza el detalle que ya no necesita.
    """
    if len(messages) <= keep_recent:
        return messages
    cut = len(messages) - keep_recent
    out = []
    for i, msg in enumerate(messages):
        if i < cut and _is_tool_result(msg):
            content = msg.get("content") or ""
            if len(content) > limit:
                msg = {**msg, "content": clip_tool_output(content, limit)}
        out.append(msg)
    return out


def _safe_start(messages: list[dict], index: int) -> int:
    """Primer índice ≥ `index` en el que se puede empezar sin dejar huérfano un
    resultado de herramienta.

    Un `role="tool"` (o un `TOOL_RESULT`) suelto al principio, sin el assistant
    que lo pidió, rompe el template del modelo — que es otra forma de acabar con
    una respuesta vacía.
    """
    while index < len(messages) and _is_tool_result(messages[index]):
        index += 1
    return index


def fit_history(messages: list[dict], budget_tokens: int,
                keep_recent: int = KEEP_RECENT) -> tuple[list[dict], bool]:
    """Devuelve (historial que cabe en el presupuesto, si hubo que podar).

    Estrategia, de menos a más destructiva:
      1. recortar el detalle de los resultados antiguos,
      2. soltar los mensajes más antiguos conservando SIEMPRE la petición
         original del usuario (sin ella el modelo olvida qué se le pidió),
      3. como último recurso, quedarse con los últimos mensajes.

    El primer mensaje se conserva aparte y se marca con una nota, para que el
    modelo sepa que el hueco es un recorte y no que nunca pasó nada.
    """
    if budget_tokens <= 0 or not messages:
        return messages, False

    working = shrink_old_results(messages, keep_recent)
    if estimate_tokens(working) <= budget_tokens:
        return working, working is not messages and working != messages

    # El primer mensaje del usuario es la petición que se está resolviendo:
    # viaja siempre, aunque todo lo de en medio se caiga.
    first = working[0] if working and working[0].get("role") == "user" else None
    head = [first, {"role": "user", "content": PRUNE_NOTE}] if first else []
    head_tokens = estimate_tokens(head)

    # Se avanza el corte hasta que el resto quepa.
    start = 1 if first else 0
    while start < len(working):
        start = _safe_start(working, start)
        tail = working[start:]
        if not tail:
            break
        if head_tokens + estimate_tokens(tail) <= budget_tokens:
            return head + tail, True
        start += 1

    # Nada cabe con la cabecera: se salva lo último, que es lo que el modelo
    # necesita para dar el siguiente paso.
    tail = working[-keep_recent:] if len(working) > keep_recent else working
    tail = tail[_safe_start(tail, 0):]
    return ([{"role": "user", "content": PRUNE_NOTE}] + tail) if tail else working, True


def prompt_budget(context_window: int, tools: list[dict] | None = None,
                  system_tokens: int = 0) -> int:
    """Tokens disponibles para el HISTORIAL, descontando lo que ya ocupan el
    system prompt y las definiciones de herramientas."""
    total = int(max(context_window, 1) * PROMPT_BUDGET_RATIO)
    return max(total - tools_tokens(tools) - system_tokens, 512)
