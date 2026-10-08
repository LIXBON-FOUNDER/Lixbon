package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRemoteEndpointsMatchTheGatewayContract(t *testing.T) {
	type call struct {
		method, path, query, auth string
		body                      map[string]any
	}
	var calls []call
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		entry := call{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, auth: r.Header.Get("Authorization")}
		json.NewDecoder(r.Body).Decode(&entry.body)
		calls = append(calls, entry)
		switch {
		case strings.HasSuffix(r.URL.Path, "/qr"):
			io.WriteString(w, "▀▄ QR")
		case r.Method == http.MethodPost && r.URL.Path == "/api/remote/sessions":
			io.WriteString(w, `{"session":{"id":"r1"},"share_url":"https://x/remote/tok"}`)
		default:
			io.WriteString(w, `{}`)
		}
	})
	ctx := context.Background()

	session, err := c.RemoteCreate(ctx, "cli", "proyecto", "mi-pc")
	if err != nil || session.ID != "r1" || session.ShareURL != "https://x/remote/tok" {
		t.Fatalf("create: %+v %v", session, err)
	}
	if err := c.RemoteEvents(ctx, "r1", []map[string]any{{"type": "hello"}}); err != nil {
		t.Fatal(err)
	}
	if qr, err := c.RemoteQR(ctx, "https://x/remote/tok?a=b c"); err != nil || qr != "▀▄ QR" {
		t.Fatalf("qr: %q %v", qr, err)
	}
	if err := c.RemoteEnd(ctx, "r1"); err != nil {
		t.Fatal(err)
	}

	want := []call{
		{"POST", "/api/remote/sessions", "", "Bearer lixbon_sk_test", map[string]any{"source": "cli", "title": "proyecto", "machine": "mi-pc"}},
		{"POST", "/api/remote/sessions/r1/events", "", "Bearer lixbon_sk_test", map[string]any{"events": []any{map[string]any{"type": "hello"}}}},
		{"GET", "/api/remote/qr", "fmt=txt&data=https%3A%2F%2Fx%2Fremote%2Ftok%3Fa%3Db+c", "Bearer lixbon_sk_test", nil},
		{"DELETE", "/api/remote/sessions/r1", "", "Bearer lixbon_sk_test", nil},
	}
	if len(calls) != len(want) {
		t.Fatalf("llamadas: %+v", calls)
	}
	for i, w := range want {
		g := calls[i]
		gotBody, _ := json.Marshal(g.body)
		wantBody, _ := json.Marshal(w.body)
		if g.method != w.method || g.path != w.path || g.query != w.query || g.auth != w.auth || string(gotBody) != string(wantBody) {
			t.Errorf("llamada %d:\n got: %+v\nwant: %+v", i, g, w)
		}
	}
}

func TestRemoteCommandsStreamsAndCancelClosesIt(t *testing.T) {
	closed := make(chan struct{})
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, ": connected\n\ndata: {\"type\":\"prompt\",\"text\":\"hola\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	})
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := c.RemoteCommands(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stream)
	var data string
	for data == "" {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if rest, ok := strings.CutPrefix(line, "data: "); ok {
			data = strings.TrimSpace(rest)
		}
	}
	if data != `{"type":"prompt","text":"hola"}` {
		t.Fatalf("data: %q", data)
	}
	cancel()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelar el contexto debe cerrar la conexión")
	}
	stream.Close()
}

func TestRemoteRefusesAGenericProvider(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) { t.Error("no debe hacer peticiones") })
	c.Generic = true
	ctx := context.Background()
	if _, err := c.RemoteCreate(ctx, "cli", "t", "m"); err == nil {
		t.Error("create")
	}
	if _, err := c.RemoteQR(ctx, "x"); err == nil {
		t.Error("qr")
	}
	if _, err := c.RemoteCommands(ctx, "r1"); err == nil {
		t.Error("commands")
	}
}
