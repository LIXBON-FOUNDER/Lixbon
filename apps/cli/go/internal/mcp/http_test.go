package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeHTTP struct {
	mu        sync.Mutex
	headers   []http.Header
	deleted   bool
	protocols []string
}

func (f *fakeHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.headers = append(f.headers, r.Header.Clone())
	f.mu.Unlock()
	if r.Method == http.MethodDelete {
		f.mu.Lock()
		f.deleted = r.Header.Get("Mcp-Session-Id") == "sesion-1"
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Header.Get("Authorization") != "Bearer buena" {
		http.Error(w, "no autorizado", http.StatusUnauthorized)
		return
	}
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	body, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(body, &msg)
	if msg.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch msg.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sesion-1")
		result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}}
	case "tools/list":
		result = map[string]any{"tools": []any{map[string]any{"name": "visual_list", "description": "Lista"}}}
	case "tools/call":
		result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "hay 2 visuals"}}}
	case "prompts/get":
		result = map[string]any{"messages": []any{map[string]any{"content": map[string]any{"type": "text", "text": "diseña"}}}}
	}
	payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	if msg.Method == "tools/call" {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\nevent: message\ndata: %s\n\n", payload)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(payload)
}

func TestHTTPSessionProtocolSSEAndClose(t *testing.T) {
	fake := &fakeHTTP{}
	srv := httptest.NewServer(fake)
	defer srv.Close()

	r := startRegistry(t, Spec{Name: "lixbon", URL: srv.URL + "/mcp", Headers: map[string]string{"Authorization": "Bearer buena"}})
	if info := r.Summary()[0]; info.Err != "" || info.Tools != 1 {
		t.Fatalf("summary = %+v", info)
	}
	if got := r.Call(context.Background(), "mcp__lixbon__visual_list", nil); got != "hay 2 visuals" {
		t.Fatalf("call = %q", got)
	}
	server, _ := r.Server("lixbon")
	if prompt, err := server.GetPrompt(context.Background(), "visual", nil); err != nil || prompt != "diseña" {
		t.Fatalf("prompt = %q, %v", prompt, err)
	}

	fake.mu.Lock()
	last := fake.headers[len(fake.headers)-1]
	fake.mu.Unlock()
	if last.Get("Mcp-Session-Id") != "sesion-1" || last.Get("MCP-Protocol-Version") != "2025-03-26" {
		t.Fatalf("cabeceras de sesión: %v", last)
	}
	if !strings.HasPrefix(last.Get("User-Agent"), "Lixbon-CLI/") {
		t.Fatalf("User-Agent = %q", last.Get("User-Agent"))
	}
	if fake.headers[0].Get("MCP-Protocol-Version") != "" {
		t.Fatal("initialize no debe llevar MCP-Protocol-Version")
	}

	r.Close()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !fake.deleted {
		t.Fatal("Close no terminó la sesión con DELETE")
	}
}

func TestHTTPUnauthorizedGivesClearError(t *testing.T) {
	srv := httptest.NewServer(&fakeHTTP{})
	defer srv.Close()
	r := startRegistry(t, Spec{Name: "lixbon", URL: srv.URL, Headers: map[string]string{"Authorization": "Bearer mala"}})
	if err := r.Summary()[0].Err; !strings.Contains(err, "respondió 401") || !strings.Contains(err, "no autorizado") {
		t.Fatalf("err = %q", err)
	}
}

func TestHTTPRefusesRedirectToAnotherHost(t *testing.T) {
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer other.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	r := startRegistry(t, Spec{Name: "r", URL: origin.URL, Headers: map[string]string{"X-Api-Key": "secreto"}})
	if err := r.Summary()[0].Err; !strings.Contains(err, "otro servidor") {
		t.Fatalf("err = %q", err)
	}
	if hits != 0 {
		t.Fatalf("la redirección llegó a otro servidor %d veces", hits)
	}
}

func TestHTTPCancelAbortsASlowRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &msg)
		switch {
		case msg.ID == nil:
			w.WriteHeader(http.StatusAccepted)
		case msg.Method == "tools/call":
			<-r.Context().Done()
		default:
			result := map[string]any{"protocolVersion": "2025-06-18"}
			if msg.Method == "tools/list" {
				result = map[string]any{"tools": []any{map[string]any{"name": "lenta"}}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
		}
	}))
	defer srv.Close()

	r := startRegistry(t, Spec{Name: "s", URL: srv.URL})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	if got := r.Call(ctx, "mcp__s__lenta", nil); got != "[ERROR] context deadline exceeded" {
		t.Fatalf("call = %q", got)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("la cancelación tardó demasiado")
	}
}
