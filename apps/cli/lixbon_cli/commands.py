"""Slash-commands: especificación, autocompletado con menú y adjuntos de imagen."""
import base64
import re
from pathlib import Path

from lixbon_cli.documents import IMAGE_EXTS, fmt_size, is_pdf, pdf_text

MAX_IMAGE_BYTES = 8 * 1024 * 1024

# (nombre, argumentos, descripción, grupo) — los handlers viven en ChatApp
# como cmd_<nombre>. El grupo ordena /help y el menú de la barra de comandos:
# leer 30 comandos en una lista plana no ayuda a nadie.
COMMAND_SPECS: list[tuple[str, str, str, str]] = [
    # ── conversación ────────────────────────────────────────────────────
    ("help", "", "Ver todos los comandos", "conversación"),
    ("model", "[nombre]", "Cambiar de modelo (sin argumento abre el selector)", "conversación"),
    ("mode", "[ask|agent|delegate]", "Cambiar modo de trabajo", "conversación"),
    ("new", "", "Empezar una conversación nueva", "conversación"),
    ("compact", "", "Compactar la conversación para liberar contexto", "conversación"),
    ("history", "[mensajes]", "Ver y reabrir conversaciones anteriores", "conversación"),
    ("image", "<ruta>", "Escribir una imagen en el mensaje (también @ruta)", "conversación"),
    ("paste", "", "Escribir la imagen del portapapeles en el mensaje (Alt+V)", "conversación"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas", "conversación"),
    ("copy", "", "Copiar la última respuesta al portapapeles", "conversación"),
    ("save", "[ruta]", "Guardar la conversación en un archivo Markdown", "conversación"),
    ("clear", "", "Vaciar el contexto y empezar de cero", "conversación"),
    # ── agente ──────────────────────────────────────────────────────────
    ("approve", "[on|off]", "Auto-aprobar herramientas del agente", "agente"),
    ("tools", "", "Ver las herramientas que puede usar el agente", "agente"),
    ("diff", "[ruta]", "Ver los cambios sin confirmar del workspace", "agente"),
    ("run", "<comando>", "Ejecutar un comando y darle la salida al modelo", "agente"),
    ("workspace", "[ruta]", "Carpeta de trabajo del modo agent", "agente"),
    ("init", "", "Generar LIXBON.md con el contexto del proyecto", "agente"),
    # ── cuenta ──────────────────────────────────────────────────────────
    ("status", "", "Ver estado de la sesión", "cuenta"),
    ("cost", "", "Tokens y contexto consumidos en esta sesión", "cuenta"),
    ("usage", "", "Ver uso global de la cuenta", "cuenta"),
    ("nodes", "", "Ver nodos del clúster", "cuenta"),
    ("login", "", "Iniciar sesión de nuevo", "cuenta"),
    ("logout", "", "Cerrar la sesión de esta máquina", "cuenta"),
    ("key", "<api_key>", "Usar otra API key", "cuenta"),
    # ── sistema ─────────────────────────────────────────────────────────
    ("config", "", "Ajustes del CLI en un menú", "sistema"),
    ("context-window", "<n>", "Tokens de la ventana de contexto (para la barra)", "sistema"),
    ("bar", "[on|off]", "Barra de estado fija al pie de la terminal", "sistema"),
    ("doctor", "", "Diagnóstico de terminal, conexión y sesión", "sistema"),
    ("remote", "", "Controlar esta sesión desde la app móvil (link + QR)", "sistema"),
    ("update", "", "Actualizar el CLI desde el servidor", "sistema"),
    ("exit", "", "Salir", "sistema"),
]

COMMAND_GROUPS = ("conversación", "agente", "cuenta", "sistema")

# El menú del prompt no puede pintar cabeceras de grupo, así que el grupo se
# codifica en el COLOR del nombre. Las clases van sin acentos: prompt_toolkit
# usa el nombre de clase como selector de estilo.
GROUP_CLASS = {
    "conversación": "class:cmd.conversacion",
    "agente": "class:cmd.agente",
    "cuenta": "class:cmd.cuenta",
    "sistema": "class:cmd.sistema",
}

# Orden de presentación: por grupo (el del catálogo) y, dentro, alfabético.
# El menú del prompt no puede pintar cabeceras, así que el orden es lo único
# que agrupa visualmente; sin él son 31 comandos en desorden.
COMMAND_ORDER: list[tuple[str, str, str, str]] = sorted(
    COMMAND_SPECS,
    key=lambda spec: (COMMAND_GROUPS.index(spec[3]) if spec[3] in COMMAND_GROUPS else 99, spec[0]),
)

# Ancho de la columna del nombre: alinea los argumentos y las descripciones.
COMMAND_NAME_WIDTH = max(len(name) for name, _a, _d, _g in COMMAND_SPECS) + 1


def command_matches(prefix: str) -> list[tuple[str, str, str, str]]:
    """Comandos cuyo nombre empieza por `prefix` (sin la barra), en orden de menú."""
    prefix = prefix.lower()
    return [spec for spec in COMMAND_ORDER if spec[0].startswith(prefix)]


def common_command_prefix(names: list[str]) -> str:
    """Prefijo común a todos los nombres (para completar sin elegir por el usuario)."""
    if not names:
        return ""
    shared = names[0]
    for name in names[1:]:
        while not name.startswith(shared):
            shared = shared[:-1]
            if not shared:
                return ""
    return shared


# ── Archivos del workspace tras un `@` ──────────────────────────────────────
#
# Se busca en TODO el árbol por trozo de ruta, no carpeta a carpeta: escribir
# `@par` tiene que encontrar `src/utils/parser.py` sin saber dónde está. El
# árbol se cachea unos segundos: se consulta en cada tecla y recorrerlo cada vez
# se notaba al escribir en proyectos grandes.

_AT_TOKEN_RE = re.compile(r'@([^\s"]*)$')
MAX_PATH_COMPLETIONS = 30
MAX_INDEX_ENTRIES = 5000
INDEX_TTL_SECONDS = 30.0

_index_cache: dict[str, tuple[float, list[tuple[str, bool, int]]]] = {}


def workspace_index(workspace: Path) -> list[tuple[str, bool, int]]:
    """Entradas `(ruta relativa, es carpeta, bytes)` del workspace, cacheadas."""
    import time

    from lixbon_cli.agent import IGNORED_TREE_DIRS

    key = str(workspace)
    cached = _index_cache.get(key)
    if cached and time.monotonic() - cached[0] < INDEX_TTL_SECONDS:
        return cached[1]

    entries: list[tuple[str, bool, int]] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > 8 or len(entries) >= MAX_INDEX_ENTRIES:
            return
        try:
            items = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for item in items:
            if len(entries) >= MAX_INDEX_ENTRIES:
                return
            rel = item.relative_to(workspace).as_posix()
            if item.is_dir():
                if item.name in IGNORED_TREE_DIRS:
                    continue
                entries.append((rel + "/", True, 0))
                walk(item, depth + 1)
            else:
                try:
                    size = item.stat().st_size
                except OSError:
                    size = 0
                entries.append((rel, False, size))

    walk(workspace, 1)
    _index_cache[key] = (time.monotonic(), entries)
    return entries


def search_workspace(workspace: Path, query: str,
                     limit: int = MAX_PATH_COMPLETIONS) -> list[tuple[str, bool, int]]:
    """Entradas cuyo camino contiene `query`; primero las que empiezan por él."""
    needle = query.replace("\\", "/").lower()
    show_hidden = needle.rsplit("/", 1)[-1].startswith(".")
    ranked = []
    for rel, is_dir, size in workspace_index(workspace):
        name = rel.rstrip("/").rsplit("/", 1)[-1]
        if name.startswith(".") and not show_hidden:
            continue
        lower = rel.lower()
        if needle and needle not in lower:
            continue
        rank = 0 if name.lower().startswith(needle) else (1 if lower.startswith(needle) else 2)
        ranked.append((rank, rel.count("/"), rel, is_dir, size))
    ranked.sort()
    return [(rel, is_dir, size) for _rank, _depth, rel, is_dir, size in ranked[:limit]]


def _path_completions(workspace: Path, token: str):
    from prompt_toolkit.completion import Completion

    from lixbon_cli.term import g

    for rel, is_dir, size in search_workspace(workspace, token):
        if is_dir:
            meta = "carpeta"
        else:
            kind = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else "archivo"
            meta = f"{fmt_size(size)} {g('sep')} {kind}"
        text = f'"{rel}"' if " " in rel else rel  # el parser de @ admite comillas
        yield Completion(text, start_position=-len(token), display=rel, display_meta=meta)


def wants_completion(text: str) -> bool:
    """¿Hay algo que completar en lo escrito hasta el cursor?

    Lo consulta el prompt para abrir el menú (y reservarle hueco) solo cuando
    toca, en vez de dejar `complete_while_typing` reservándolo siempre.
    """
    if _AT_TOKEN_RE.search(text):
        return True
    if not text.startswith("/"):
        return False
    return " " not in text or text.startswith("/model ")


def make_marker_lexer():
    """Pinta los marcadores `[IMG#n]` del prompt como fichas.

    Solo restyla: los fragmentos tienen que medir lo mismo que el texto o el
    cursor deja de caer donde se escribe.
    """
    from prompt_toolkit.lexers import Lexer

    class MarkerLexer(Lexer):
        def lex_document(self, document):
            lines = document.lines

            def get_line(index: int) -> list:
                line = lines[index]
                fragments, position = [], 0
                for match in _IMG_MARKER_RE.finditer(line):
                    if match.start() > position:
                        fragments.append(("", line[position:match.start()]))
                    fragments.append(("class:img-marker", match.group(0)))
                    position = match.end()
                if position < len(line):
                    fragments.append(("", line[position:]))
                return fragments

            return get_line

    return MarkerLexer()


def slash_rprompt():
    """Recuento de comandos que casan con lo escrito, al margen derecho de la caja."""
    from prompt_toolkit.application import get_app

    text = get_app().current_buffer.text
    if not text.startswith("/") or " " in text:
        return ""
    return [("class:placeholder", f"{len(command_matches(text[1:]))} de {len(COMMAND_SPECS)} ")]


def make_completer(app):
    """Completer de prompt_toolkit: comandos con `/`, modelos y rutas con `@`."""
    from prompt_toolkit.completion import Completer, Completion

    class SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            # El `@` va primero: puede aparecer en cualquier parte del mensaje.
            at_token = _AT_TOKEN_RE.search(text)
            if at_token:
                yield from _path_completions(app.workspace, at_token.group(1))
                return
            if not text.startswith("/"):
                return
            # Autocompletar el argumento de /model con los modelos cargados
            if text.startswith("/model "):
                prefix = text[len("/model "):]
                for model in app.models_cache:
                    if prefix.lower() in model.lower():
                        yield Completion(model, start_position=-len(prefix))
                return
            if " " in text:
                return
            prefix = text[1:].lower()
            for name, args, desc, group in COMMAND_ORDER:
                if not name.startswith(prefix):
                    continue
                # Dos columnas dentro del propio display: el nombre ocupa
                # siempre lo mismo, así los argumentos quedan en vertical y la
                # lista se lee como una tabla y no como texto irregular.
                display = [
                    (GROUP_CLASS.get(group, "class:cmd.name"),
                     f"/{name}".ljust(COMMAND_NAME_WIDTH + 1)),
                    ("class:cmd.args", args),
                ]
                # Con argumento: dejar espacio final para encadenar el
                # autocompletado del argumento (ej. /model → modelos)
                completion_text = f"/{name} " if args else f"/{name}"
                yield Completion(
                    completion_text,
                    start_position=-len(text),
                    display=display,
                    display_meta=desc,
                )

    return SlashCompleter()


# ── Adjuntos (@ruta) ────────────────────────────────────────────────────────

# La puntuación pegada («@logo.png,») no forma parte de la ruta.
_AT_PATH_RE = re.compile(r'@(?:"([^"]+)"|(\S+?))(?=[.,;:!?)\]]*(?:\s|$))')
MAX_TEXT_ATTACHMENT_BYTES = 64 * 1024


def _looks_like_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def parse_attachments(text: str, base_dir: Path) -> tuple[str, list[Path], list[tuple[str, str]], list[str]]:
    """Extrae los `@ruta` del mensaje.

    Devuelve (texto_limpio, imágenes, archivos de texto, errores). Una imagen
    viaja aparte (ChatMessage.images); un archivo de texto se adjunta como
    `(ruta, contenido)` para que el modelo lo tenga aunque esté en modo ask,
    donde no puede leerlo él. Un @token que no apunta a nada del disco se deja
    tal cual: puede ser un usuario o un handle.
    """
    images: list[Path] = []
    files: list[tuple[str, str]] = []
    errors: list[str] = []

    def _replace(match: re.Match) -> str:
        raw = match.group(1) or match.group(2)
        path = Path(raw)
        if not path.is_absolute():
            path = base_dir / path
        if _looks_like_image(path):
            if not path.exists():
                errors.append(f"No existe la imagen: {raw}")
                return ""
            images.append(path.resolve())
            return path.name  # el texto conserva el nombre para dar contexto al modelo
        if not path.is_file():
            return match.group(0)
        if is_pdf(path):
            try:
                files.append((raw, pdf_text(path)))
            except Exception as exc:
                errors.append(f"No se pudo leer el PDF {raw}: {exc}")
            return raw
        try:
            if path.stat().st_size > MAX_TEXT_ATTACHMENT_BYTES:
                errors.append(f"{raw} supera los 64 kB: pide al agente que lo lea por partes")
                return raw
            content = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
        except UnicodeDecodeError:
            errors.append(f"{raw} no es un archivo de texto")
            return raw
        except OSError as exc:
            errors.append(f"No se pudo leer {raw}: {exc}")
            return raw
        files.append((raw, content))
        return raw

    clean = _AT_PATH_RE.sub(_replace, text).strip()
    return clean, images, files, errors


def attachments_block(files: list[tuple[str, str]]) -> str:
    """Los archivos adjuntos, listos para ir detrás del mensaje."""
    parts = []
    for name, content in files:
        fence = "````" if "```" in content else "```"
        parts.append(f"Archivo adjunto `{name}`:\n{fence}\n{content.rstrip()}\n{fence}")
    return "\n\n".join(parts)


def encode_image(path: Path) -> str:
    """Valida y codifica una imagen a base64 (para ChatMessage.images)."""
    if not path.exists() or not path.is_file():
        raise ValueError(f"No existe la imagen: {path}")
    if not _looks_like_image(path):
        raise ValueError(f"Formato no soportado ({path.suffix}); usa png/jpg/jpeg/webp")
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"La imagen supera el límite de 8 MB: {path.name}")
    return base64.b64encode(data).decode("ascii")


def fmt_image_marker(index: int) -> str:
    """Marcador único de imagen adjunta: al pegar, al adjuntar y al enviar."""
    return f"[IMG#{index}]"


_IMG_MARKER_RE = re.compile(r"\[IMG#(\d+)\]", re.IGNORECASE)

# Solo el marcador pegado al cursor: lo usa el Backspace del prompt para
# borrarlo entero de una vez, en lugar de carácter a carácter.
IMG_MARKER_AT_END_RE = re.compile(r"\[IMG#\d+\]$", re.IGNORECASE)


def parse_image_markers(text: str, staged: list[Path]) -> list[Path]:
    """Imágenes de `staged` referenciadas por los marcadores del texto.

    El marcador ES el adjunto: si el usuario lo borra del mensaje, la imagen
    no se envía. El orden lo marca el texto, no la cola.
    """
    images: list[Path] = []
    for match in _IMG_MARKER_RE.finditer(text):
        index = int(match.group(1)) - 1
        if 0 <= index < len(staged) and staged[index] not in images:
            images.append(staged[index])
    return images
