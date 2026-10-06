# lixbon CLI (Go)

Port gradual del CLI Python (`../lixbon_cli`). Decisión y plan en `.planning/DECISION-CLI-GO.md`. Python sigue siendo la referencia y el rollback.

## Estado

| Paquete | Qué hace | Contrato |
|---|---|---|
| `internal/sse` | Stream SSE → eventos tipados, filtro `<think>` | `../validation/fixtures/sse_corpus.json` (oráculo: `sse.py`) |
| `internal/config` | `~/.lixbon/config.json` compatible con Python | BOM, campos desconocidos preservados, escritura atómica 0600 |
| `internal/api` | Cliente del gateway, stream cancelable | sin reintentos del POST, inactividad 300 s, sin gzip |
| `internal/cli` | `init`, `status`, `models`, `chat --once` | pruebas contra un gateway falso |
| `internal/toolspec` | Catálogo de las 20 herramientas (schemas, conjuntos, claves) | `catalog.json` generado por `gen_tool_corpus.py` |
| `internal/toolparse` | Extrae tool-calls del texto del modelo y limpia la prosa | `fixtures/tool_parse_corpus.json` (40 casos de texto + 9 nativos) |
| `internal/tools` | `list_files`, `find_files`, `read_file`, `outline`, `search` | `fixtures/workspace_corpus.json` (87 casos sobre un workspace sintético) |
| `internal/textutil` | Semánticas de texto de Python (decodificación, espacios, splitlines) | usado por los anteriores |

Comandos: `init`, `status`, `models`, `chat --once "texto"`. Pendiente: bucle del agente y herramientas de escritura/shell (`write_file`, `edit_file`, `run_command`…), aprobaciones, interfaz interactiva con **Bubble Tea**, `setup`, `usage`, `update`, MCP, remoto. Los paquetes de este módulo no dependen de la UI.

## Diferencias deliberadas con Python

- `chat --once` equivale hoy al modo `ask`: sin herramientas, sin `LIXBON.md`, sin adjuntos ni historial persistente. Envía `think` solo cuando se añada el agente.
- Los errores de `chat` van a stderr; `status` y `models` siguen imprimiendo a stdout como Python.
- Si no hay modelo y el servidor no define uno para `chat`, falla con un mensaje en vez de abrir un selector.
- Ctrl+C durante `--once` termina con código 0 (igual que Python) y escribe `— interrumpido —` en stderr.
- Versión `2.3.0-go.0` en `status` y en el `User-Agent`.

- `search` usa un recorrido propio en Go (poda carpetas ignoradas, lee por líneas, respeta cancelación) en lugar de ripgrep; el orden de salida es el léxico del recorrido.
- Las lecturas están acotadas: líneas de más de 1 MiB se recortan, un rango de más de 120.000 caracteres se corta con aviso, y `end_line` negativo se trata como ausente.
- `read_file` de PDF y Word devuelve «aún no disponible» hasta decidir la biblioteca de extracción.

## Desarrollo

```bash
cd apps/cli/go
go vet ./... && go test -count=1 ./...
go build -o lixbon ./cmd/lixbon
```

Usa siempre `-count=1`: el corpus vive fuera del módulo y la caché de `go test` no detecta que cambió. Para regenerar el corpus: `python apps/cli/validation/gen_sse_corpus.py`.

Sin CGO (no hay compilador C en este entorno): `go test -race` no está disponible.
