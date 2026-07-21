"""Cliente HTTP del gateway Lixbon (urllib stdlib, sin dependencias)."""
import json
from urllib import error, request

from lixbon_cli.config import DEFAULT_BASE_URL, server_base
from lixbon_cli.sse import events_from_stream


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _friendly_detail(body: str) -> str:
    """Extrae el detail legible de un error JSON de FastAPI."""
    try:
        data = json.loads(body)
        detail = data.get("detail", body)
        if isinstance(detail, dict):
            return str(detail.get("message") or detail)
        return str(detail)
    except Exception:
        return body[:300]


class ChatStream:
    """Stream de chat cancelable: iterar produce eventos tipados de sse.py."""

    def __init__(self, response):
        self._response = response
        self.closed = False

    def __iter__(self):
        try:
            yield from events_from_stream(self._response)
        finally:
            self.close()

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            try:
                self._response.close()
            except Exception:
                pass


class ApiClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, api_key: str = ""):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.server = server_base(self.base_url)
        self.api_key = api_key

    # ── infraestructura ──────────────────────────────────────────────────

    def _open(self, method: str, url: str, payload: dict | None = None,
              timeout: int = 120, auth: bool = True):
        headers = {"Content-Type": "application/json"}
        if auth and self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(url=url, method=method, headers=headers, data=data)
        try:
            return request.urlopen(req, timeout=timeout)
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ApiError(_friendly_detail(body), status=exc.code) from exc
        except Exception as exc:
            raise ApiError(f"Error de conexión: {exc}") from exc

    def _json(self, method: str, url: str, payload: dict | None = None,
              timeout: int = 120, auth: bool = True) -> dict:
        with self._open(method, url, payload, timeout, auth) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}

    # ── auth ─────────────────────────────────────────────────────────────

    def login(self, email: str, password: str) -> dict:
        """Login con credenciales. issue_api_key hace que el server entregue
        una API key propia y rotable (mismo flujo que la app desktop)."""
        return self._json("POST", f"{self.server}/api/auth/login",
                          {"email": email, "password": password, "issue_api_key": True},
                          auth=False)

    def register(self, email: str, password: str, first_name: str = "", last_name: str = "") -> dict:
        return self._json("POST", f"{self.server}/api/auth/register",
                          {"email": email, "password": password,
                           "first_name": first_name, "last_name": last_name},
                          auth=False)

    def key_info(self) -> dict:
        return self._json("GET", f"{self.server}/api/key/info", timeout=15)

    # ── datos ────────────────────────────────────────────────────────────

    def models(self) -> list[str]:
        data = self._json("GET", f"{self.base_url}/models", timeout=20)
        return [str(m.get("id")) for m in data.get("data", [])
                if m.get("id") and not str(m.get("id")).startswith("error:")]

    def usage(self) -> dict:
        return self._json("GET", f"{self.server}/api/usage", timeout=20)

    def nodes(self) -> dict:
        return self._json("GET", f"{self.server}/api/nodes", timeout=20)

    def delegate(self, user_input: str) -> dict:
        return self._json("POST", f"{self.server}/api/delegate",
                          {"user_input": user_input}, timeout=180)

    # ── control remoto (/remote) ─────────────────────────────────────────

    def remote_create(self, source: str, title: str, machine: str) -> dict:
        return self._json("POST", f"{self.server}/api/remote/sessions",
                          {"source": source, "title": title, "machine": machine}, timeout=20)

    def remote_events(self, session_id: str, events: list[dict]) -> dict:
        return self._json("POST", f"{self.server}/api/remote/sessions/{session_id}/events",
                          {"events": events}, timeout=20)

    def remote_end(self, session_id: str) -> dict:
        return self._json("DELETE", f"{self.server}/api/remote/sessions/{session_id}", timeout=20)

    def remote_commands_stream(self, session_id: str):
        """SSE de larga duración con los comandos del móvil/web. El timeout es
        de inactividad del socket; el gateway manda keepalives cada 15 s."""
        return self._open("GET", f"{self.server}/api/remote/sessions/{session_id}/commands",
                          timeout=90)

    def remote_qr_txt(self, data: str) -> str:
        from urllib.parse import quote

        with self._open("GET", f"{self.server}/api/remote/qr?fmt=txt&data={quote(data, safe='')}",
                        timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")

    # ── chat ─────────────────────────────────────────────────────────────

    def chat(self, model: str, messages: list[dict], conversation_id: str | None = None,
             client_id: str = "cli", title: str | None = None, timeout: int = 300) -> dict:
        payload = {
            "model": model,
            "messages": messages,
            "conversation_id": conversation_id,
            "client_id": client_id,
            "title": title,
            "source": "cli",  # historial independiente del de la web/IDE
        }
        return self._json("POST", f"{self.base_url}/chat/completions", payload, timeout=timeout)

    def chat_stream(self, model: str, messages: list[dict], conversation_id: str | None = None,
                    client_id: str = "cli", title: str | None = None,
                    web_search: bool = False, num_ctx: int | None = None) -> ChatStream:
        payload = {
            "model": model,
            "messages": messages,
            "conversation_id": conversation_id,
            "client_id": client_id,
            "title": title,
            "stream": True,
            "web_search": web_search,
            "source": "cli",  # historial independiente del de la web/IDE
        }
        if num_ctx:
            payload["num_ctx"] = int(num_ctx)
        response = self._open("POST", f"{self.base_url}/chat/completions", payload, timeout=300)
        return ChatStream(response)
