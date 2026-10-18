package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

// streamedCall manda una llamada nativa con los argumentos en trozos, como
// llega una larga.
func streamedCall(id, name string, fragments ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		head, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
			"tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": ""}}},
		}}}})
		io.WriteString(w, "data: "+string(head)+"\n\n")
		for _, f := range fragments {
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
				"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"arguments": f}}},
			}}}})
			io.WriteString(w, "data: "+string(chunk)+"\n\n")
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}
}

// El móvil ve lo mismo que la terminal mientras el modelo escribe una acción:
// qué prepara y sobre qué.
func TestThePhoneSeesTheCallBeingWritten(t *testing.T) {
	h, relay := remoteHarness(t, func(c *config.Config) { c.Mode = "agent" },
		streamedCall("c1", "list_files", `{"pa`, `th":"src`, `"}`),
		textReply("En src no hay nada."))
	writeTree(t, h.chat.Workspace, "src/a.txt")
	startRemote(t, h, relay)
	relay.push(prompt("¿qué hay en src?"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()
	var labels []string
	for _, e := range relay.snapshotEvents() {
		if e["type"] == "status" && e["activity"] == "preparing" {
			labels = append(labels, e["label"].(string))
		}
	}
	if !slicesContainsPrefix(labels, "Listando src") {
		t.Fatalf("el móvil recibe la acción en preparación: %q", labels)
	}
	h.m.remote.link.Stop(true)
}

func slicesContainsPrefix(list []string, prefix string) bool {
	for _, s := range list {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}
