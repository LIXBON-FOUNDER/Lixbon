package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

func fragments(t *testing.T, batches ...string) []map[string]any {
	t.Helper()
	var a toolCallAssembler
	for _, b := range batches {
		var batch []json.RawMessage
		if err := json.Unmarshal([]byte(b), &batch); err != nil {
			t.Fatal(err)
		}
		a.add(batch)
	}
	var out []map[string]any
	for _, raw := range a.calls() {
		var call map[string]any
		if err := json.Unmarshal(raw, &call); err != nil {
			t.Fatal(err)
		}
		out = append(out, call)
	}
	return out
}

func function(call map[string]any) map[string]any { return call["function"].(map[string]any) }

func TestOpenAIStyleFragmentsBecomeOneCall(t *testing.T) {
	calls := fragments(t,
		`[{"index":0,"id":"call_a","type":"function","function":{"name":"fetch_url","arguments":""}}]`,
		`[{"index":0,"function":{"arguments":"{\"url\":"}}]`,
		`[{"index":0,"function":{"arguments":"\"https://x.dev\"}"}}]`,
	)
	if len(calls) != 1 {
		t.Fatalf("llamadas: %v", calls)
	}
	f := function(calls[0])
	if calls[0]["id"] != "call_a" || f["name"] != "fetch_url" || f["arguments"] != `{"url":"https://x.dev"}` {
		t.Fatalf("llamada: %v", calls[0])
	}
}

func TestParallelCallsStayApartByIndex(t *testing.T) {
	calls := fragments(t,
		`[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{\"path\":"}},{"index":1,"id":"b","function":{"name":"list_dir","arguments":"{}"}}]`,
		`[{"index":0,"function":{"arguments":"\"x.go\"}"}}]`,
	)
	if len(calls) != 2 || function(calls[0])["arguments"] != `{"path":"x.go"}` || function(calls[1])["name"] != "list_dir" {
		t.Fatalf("llamadas: %v", calls)
	}
}

func TestCompleteCallsFromTheGatewayPassThrough(t *testing.T) {
	calls := fragments(t,
		`[{"id":"g1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]`,
		`[{"id":"g2","type":"function","function":{"name":"read_file","arguments":{"path":"b"}}}]`,
	)
	if len(calls) != 2 || function(calls[0])["arguments"] != `{"path":"a"}` || function(calls[1])["arguments"] != `{"path":"b"}` {
		t.Fatalf("llamadas: %v", calls)
	}
}

func TestAServerReusingIndexZeroForDistinctCallsKeepsThemApart(t *testing.T) {
	byID := fragments(t,
		`[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]`,
		`[{"index":0,"id":"b","function":{"name":"read_file","arguments":"{\"path\":\"b\"}"}}]`,
	)
	withoutIDs := fragments(t,
		`[{"index":0,"function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]`,
		`[{"index":0,"function":{"name":"read_file","arguments":"{\"path\":\"b\"}"}}]`,
	)
	for name, calls := range map[string][]map[string]any{"con id": byID, "sin id": withoutIDs} {
		if len(calls) != 2 || function(calls[1])["arguments"] != `{"path":"b"}` {
			t.Fatalf("%s: %v", name, calls)
		}
	}
}

func TestMissingIDsAreSynthesizedAndNamelessFragmentsDropped(t *testing.T) {
	calls := fragments(t,
		`[{"index":0,"function":{"name":"list_dir","arguments":""}}]`,
		`[{"index":3,"function":{"arguments":"{}"}}]`,
	)
	if len(calls) != 1 || calls[0]["id"] != "call_1" || calls[0]["type"] != "function" || function(calls[0])["arguments"] != "{}" {
		t.Fatalf("llamadas: %v", calls)
	}
}

func TestExtraFieldsAreKeptForTheNextTurn(t *testing.T) {
	calls := fragments(t,
		`[{"index":0,"id":"a","function":{"name":"list_dir","arguments":"{}"},"extra_content":{"google":{"thought_signature":"abc"}}}]`,
	)
	if len(calls) != 1 || calls[0]["extra_content"] == nil {
		t.Fatalf("falta extra_content: %v", calls)
	}
}

func sseChunk(delta map[string]any) string {
	raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta}}})
	return "data: " + string(raw) + "\n\n"
}

func TestAgentRunsAToolCallThatArrivesInFragments(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(n int, w http.ResponseWriter) {
		if n > 0 {
			reply("listo")(w)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		call := func(fn map[string]any, extra map[string]any) string {
			item := map[string]any{"index": 0, "function": fn}
			for k, v := range extra {
				item[k] = v
			}
			return sseChunk(map[string]any{"tool_calls": []any{item}})
		}
		io.WriteString(w, call(map[string]any{"name": "list_files", "arguments": ""}, map[string]any{"id": "call_a", "type": "function"}))
		io.WriteString(w, call(map[string]any{"arguments": `{"pa`}, nil))
		io.WriteString(w, call(map[string]any{"arguments": `th":"."}`}, nil))
		io.WriteString(w, "data: [DONE]\n\n")
	}
	c := newChat(t, client, func(cfg *config.Config) { cfg.Mode = ModeAgent }, Options{})
	rec := &recorder{}
	if _, err := c.Send(context.Background(), "qué hay aquí", rec); err != nil {
		t.Fatal(err)
	}
	if len(rec.notes) != 0 {
		t.Fatalf("no debe caer al protocolo de texto: %v", rec.notes)
	}
	body := g.bodyAt(1)
	var tool map[string]any
	for _, m := range body["messages"].([]any) {
		if msg := m.(map[string]any); msg["role"] == "tool" {
			tool = msg
		}
	}
	if tool == nil || tool["tool_call_id"] != "call_a" || strings.Contains(tool["content"].(string), "no soportada") {
		t.Fatalf("la herramienta debe ejecutarse con su id: %v", tool)
	}
}
