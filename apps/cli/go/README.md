# lixbon CLI (Go)

Port gradual del CLI Python (`../lixbon_cli`). Decisión y plan en `.planning/DECISION-CLI-GO.md`. Python sigue siendo la referencia y el rollback.

## Estado

| Paquete | Qué hace | Contrato |
|---|---|---|
| `internal/sse` | Stream SSE → eventos tipados, filtro `<think>` | `../validation/fixtures/sse_corpus.json` (oráculo: `sse.py`) |
| `internal/config` | `~/.lixbon/config.json` compatible con Python | BOM, campos desconocidos preservados, escritura atómica 0600 |
| `internal/api` | Cliente del gateway, stream cancelable | sin reintentos del POST, inactividad 300 s, sin gzip |
| `internal/cli` | `init`, `status`, `models`, `chat --once` | pruebas contra un gateway falso |

Comandos: `init`, `status`, `models`, `chat --once "texto"`. Pendiente: chat interactivo, agente y herramientas, `setup`, `usage`, `update`, MCP, remoto.

## Diferencias deliberadas con Python

- `chat --once` equivale hoy al modo `ask`: sin herramientas, sin `LIXBON.md`, sin adjuntos ni historial persistente. Envía `think` solo cuando se añada el agente.
- Los errores de `chat` van a stderr; `status` y `models` siguen imprimiendo a stdout como Python.
- Si no hay modelo y el servidor no define uno para `chat`, falla con un mensaje en vez de abrir un selector.
- Ctrl+C durante `--once` termina con código 0 (igual que Python) y escribe `— interrumpido —` en stderr.
- Versión `2.3.0-go.0` en `status` y en el `User-Agent`.

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
