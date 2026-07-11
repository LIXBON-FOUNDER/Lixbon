"""Parseo del stream SSE del gateway y clasificación de eventos.

Eventos tipados que consume la app:
  ("sources", list)     — fuentes de web_search (primer evento si aplica)
  ("reasoning", str)    — razonamiento del modelo (segundo plano)
  ("content", str)      — texto de la respuesta
  ("usage", dict)       — tokens reales, llega en el último chunk
  ("done", None)        — fin del stream
"""
import json

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


class ThinkTagFilter:
    """Reclasifica como reasoning el texto entre <think>…</think>.

    Algunos modelos (deepseek-r1, qwen) emiten el razonamiento inline en el
    content en lugar del campo thinking de Ollama. Los tags pueden llegar
    partidos entre chunks, así que se retiene la cola que podría ser el
    principio de un tag hasta poder decidir.
    """

    def __init__(self):
        self._inside = False
        self._buffer = ""

    def _tag(self) -> str:
        return THINK_CLOSE if self._inside else THINK_OPEN

    @staticmethod
    def _partial_tail(text: str, tag: str) -> int:
        """Longitud del sufijo de text que es prefijo (incompleto) de tag."""
        max_len = min(len(text), len(tag) - 1)
        for size in range(max_len, 0, -1):
            if text.endswith(tag[:size]):
                return size
        return 0

    def feed(self, text: str) -> list[tuple[str, str]]:
        self._buffer += text
        out: list[tuple[str, str]] = []
        while True:
            tag = self._tag()
            pos = self._buffer.find(tag)
            if pos == -1:
                hold = self._partial_tail(self._buffer, tag)
                emit = self._buffer[: len(self._buffer) - hold]
                self._buffer = self._buffer[len(self._buffer) - hold:]
                if emit:
                    out.append(("reasoning" if self._inside else "content", emit))
                return out
            emit = self._buffer[:pos]
            if emit:
                out.append(("reasoning" if self._inside else "content", emit))
            self._buffer = self._buffer[pos + len(tag):]
            self._inside = not self._inside

    def flush(self) -> list[tuple[str, str]]:
        emit = self._buffer
        self._buffer = ""
        if emit:
            return [("reasoning" if self._inside else "content", emit)]
        return []


def iter_sse_data(response):
    """Itera los payloads JSON de las líneas `data:` de una respuesta SSE.

    Ignora keepalives (líneas que empiezan con ':') y corta en [DONE].
    """
    for raw in response:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            return
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def events_from_stream(response):
    """Convierte la respuesta SSE cruda en los eventos tipados del CLI."""
    think_filter = ThinkTagFilter()
    for chunk in iter_sse_data(response):
        if "lixbon_sources" in chunk:
            yield ("sources", chunk["lixbon_sources"])
            continue
        choices = chunk.get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            reasoning = delta.get("reasoning_content")
            if reasoning:
                yield ("reasoning", reasoning)
            content = delta.get("content")
            if content:
                yield from think_filter.feed(content)
        usage = chunk.get("usage")
        if usage:
            yield ("usage", usage)
    yield from think_filter.flush()
    yield ("done", None)
