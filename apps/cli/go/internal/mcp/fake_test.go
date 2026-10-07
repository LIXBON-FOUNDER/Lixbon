package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain convierte el binario de pruebas en un servidor MCP stdio de mentira
// cuando se lanza con LIXBON_MCP_FAKE: así las pruebas no dependen de Python ni
// de Node y se comportan igual en los tres sistemas operativos.
func TestMain(m *testing.M) {
	if mode := os.Getenv("LIXBON_MCP_FAKE"); mode != "" {
		runFakeServer(mode)
		return
	}
	os.Exit(m.Run())
}

func runFakeServer(mode string) {
	fmt.Println("log que no es json")
	out := func(v any) {
		raw, _ := json.Marshal(v)
		fmt.Println(string(raw))
	}
	logPath := os.Getenv("LIXBON_MCP_LOG")
	record := func(line string) {
		if logPath == "" {
			return
		}
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintln(f, line)
			f.Close()
		}
	}
	proto := os.Getenv("LIXBON_MCP_PROTO")
	if proto == "" {
		proto = "2025-06-18"
	}
	pinged := false

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		reply := func(result any) { out(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result}) }
		switch msg.Method {
		case "":
			if string(msg.ID) == "99" && msg.Result != nil {
				pinged = true
			}
		case "initialize":
			reply(map[string]any{"protocolVersion": proto, "capabilities": map[string]any{}})
			out(map[string]any{"jsonrpc": "2.0", "id": 99, "method": "ping"})
		case "tools/list":
			var p struct{ Cursor string }
			_ = json.Unmarshal(msg.Params, &p)
			if p.Cursor == "" {
				reply(map[string]any{"tools": []any{
					map[string]any{"name": "echo", "description": "Devuelve el texto",
						"inputSchema": json.RawMessage(`{"type":"object","properties":{"zeta":{"type":"string"},"alfa":{"type":"string"}}}`)},
					map[string]any{"name": "fail", "inputSchema": map[string]any{"type": "object"}},
				}, "nextCursor": "p2"})
			} else {
				reply(map[string]any{"tools": []any{
					map[string]any{"name": "slow", "description": "No responde"},
					map[string]any{"name": "pinged"}, map[string]any{"name": "flood"}, map[string]any{"name": "exit"},
				}})
			}
		case "tools/call":
			var p struct {
				Name      string
				Arguments map[string]any
			}
			_ = json.Unmarshal(msg.Params, &p)
			switch p.Name {
			case "echo":
				reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": "eco: " + fmt.Sprint(p.Arguments["alfa"])}}})
			case "fail":
				reply(map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "roto"}}})
			case "pinged":
				reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprint(pinged)}}})
			case "flood":
				reply(map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Repeat("é", 30000)}}})
			case "exit":
				fmt.Fprintln(os.Stderr, "me voy")
				os.Exit(3)
			}
		case "prompts/get":
			reply(map[string]any{"messages": []any{map[string]any{"role": "user", "content": map[string]any{"type": "text", "text": "hola"}}}})
		case "notifications/cancelled":
			record(string(msg.Params))
		}
	}
	if mode == "stubborn" {
		time.Sleep(time.Hour)
	}
}
