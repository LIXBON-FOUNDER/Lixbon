"""Slash-commands: especificación, autocompletado con menú y adjuntos de imagen."""
import base64
import re
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
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
    ("history", "", "Ver los mensajes de la sesión y reenviar uno", "conversación"),
    ("image", "<ruta>", "Adjuntar una imagen al próximo mensaje (también @ruta)", "conversación"),
    ("web", "[on|off]", "Búsqueda web durante las respuestas", "conversación"),
    ("copy", "", "Copiar la última respuesta al portapapeles", "conversación"),
    ("save", "[ruta]", "Guardar la conversación en un archivo Markdown", "conversación"),
    ("clear", "", "Limpiar la pantalla", "conversación"),
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


def make_completer(app):
    """Completer de prompt_toolkit: menú al escribir `/` y modelos en `/model `."""
    from prompt_toolkit.completion import Completer, Completion

    class SlashCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
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
            prefix = text[1:]
            for name, args, desc, group in COMMAND_SPECS:
                if name.startswith(prefix):
                    display = f"/{name} {args}".strip()
                    # Con argumento: dejar espacio final para encadenar el
                    # autocompletado del argumento (ej. /model → modelos)
                    completion_text = f"/{name} " if args else f"/{name}"
                    yield Completion(
                        completion_text,
                        start_position=-len(text),
                        display=display,
                        display_meta=f"{desc}  ·  {group}",
                    )

    return SlashCompleter()


# ── Adjuntos de imagen ──────────────────────────────────────────────────────

_AT_PATH_RE = re.compile(r'@(?:"([^"]+)"|(\S+))')


def _looks_like_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def parse_attachments(text: str, base_dir: Path) -> tuple[str, list[Path], list[str]]:
    """Extrae rutas de imagen `@ruta` del mensaje.

    Devuelve (texto_limpio, imágenes, errores). Solo se tratan como adjunto
    los @tokens que apuntan a una imagen; el resto del texto queda intacto.
    """
    images: list[Path] = []
    errors: list[str] = []

    def _replace(match: re.Match) -> str:
        raw = match.group(1) or match.group(2)
        path = Path(raw)
        if not path.is_absolute():
            path = (base_dir / path)
        if not _looks_like_image(path):
            return match.group(0)  # no es imagen: se deja tal cual
        if not path.exists():
            errors.append(f"No existe la imagen: {raw}")
            return ""
        images.append(path.resolve())
        return path.name  # el texto conserva el nombre para dar contexto al modelo

    clean = _AT_PATH_RE.sub(_replace, text).strip()
    return clean, images, errors


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


def fmt_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / 1024:.0f} KB"
