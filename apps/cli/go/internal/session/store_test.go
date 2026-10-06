package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/history"
)

type corpus struct {
	Sessions struct {
		Files           map[string]string  `json:"files"`
		Listed          []Header           `json:"listed"`
		Loaded          map[string]*Record `json:"loaded"`
		RebuiltIDs      []string           `json:"rebuilt_ids"`
		CorruptIndexIDs []string           `json:"corrupt_index_ids"`
		Deleted         bool               `json:"deleted"`
		AfterDelete     []string           `json:"after_delete"`
		MaxSessions     int                `json:"max_sessions"`
		MaxStoredChars  int                `json:"max_stored_chars"`
	} `json:"sessions"`
	RelativeTime []struct {
		Delta  *float64 `json:"delta"`
		Output string   `json:"output"`
	} `json:"relative_time"`
	Titles []struct {
		Name     string            `json:"name"`
		Messages []history.Message `json:"messages"`
		Output   string            `json:"output"`
	} `json:"titles"`
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/state_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func ids(items []Header) []string {
	out := make([]string, len(items))
	for i, h := range items {
		out[i] = h.ID
	}
	return out
}

func placeCorpusFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, "sessions", name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func normalize(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("JSON inválido: %v\n%s", err, raw)
	}
	return v
}

func TestReadsSessionsWrittenByPython(t *testing.T) {
	c := loadCorpus(t).Sessions
	base := t.TempDir()
	placeCorpusFiles(t, base, c.Files)
	store := NewStore(base)

	listed := store.List(50)
	if !reflect.DeepEqual(listed, c.Listed) {
		t.Fatalf("cabeceras distintas\n got: %+v\nwant: %+v", listed, c.Listed)
	}
	for id, want := range c.Loaded {
		got, ok := store.Load(id)
		if want == nil {
			if ok {
				t.Errorf("%s no debería existir", id)
			}
			continue
		}
		if !ok {
			t.Fatalf("no carga %s", id)
		}
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		if !reflect.DeepEqual(normalize(t, g), normalize(t, w)) {
			t.Errorf("sesión %s distinta\n got: %.300s\nwant: %.300s", id, g, w)
		}
	}
}

// Con el mismo reloj, guardar en Go produce los mismos archivos que Python.
func TestSavingProducesWhatPythonProduces(t *testing.T) {
	c := loadCorpus(t).Sessions
	base := t.TempDir()
	store := NewStore(base)
	now := 1_700_000_000.0
	store.Now = func() float64 { now += 10; return now }

	type input struct {
		id       string
		messages []history.Message
		opts     SaveOptions
	}
	long := strings.Repeat("y", 30000)
	inputs := []input{
		{"s-agente", []history.Message{history.User("crea una API REST"),
			{Role: "assistant", ToolCalls: []json.RawMessage{json.RawMessage(`{"id":"c1","function":{"name":"write_file","arguments":"{}"}}`)}},
			{Role: "tool", Content: "Archivo creado: api.py", Name: "write_file"}, history.Assistant("Listo: creé api.py.")},
			SaveOptions{Model: "qwen", Mode: "agent", Workspace: "/proj", Tokens: 1234}},
		{"s-largo", []history.Message{history.User("lee el archivo " + strings.Repeat("x", 120)), history.Assistant(long)}, SaveOptions{Model: "llama"}},
		{"s-imagen", []history.Message{{Role: "user", Content: "mira esto", Images: []string{strings.Repeat("AAAA", 100)}}}, SaveOptions{}},
		{"s-titulo-fijo", []history.Message{history.User("hola"), history.Assistant("qué tal")}, SaveOptions{Title: "Mi título", Model: "m", Mode: "ask"}},
		{"s-unicode", []history.Message{history.User("canción 🎵   con   espacios\ny salto"), history.Assistant("ok")}, SaveOptions{Workspace: `C:\proj\ñandú`}},
		{"s-titulo-largo", []history.Message{history.User(strings.Repeat("p", 100))}, SaveOptions{}},
		{"s-sin-conversacion", []history.Message{history.User("   "), history.User("TOOL_RESULT read_file: x"), history.Assistant("")}, SaveOptions{}},
		{"s-solo-tool-result-primero", []history.Message{history.User("TOOL_RESULT x: y"), history.User("pregunta real")}, SaveOptions{}},
	}
	for _, in := range inputs {
		if err := store.Save(in.id, in.messages, in.opts); err != nil {
			t.Fatalf("Save %s: %v", in.id, err)
		}
	}
	again := append(append([]history.Message{}, inputs[0].messages...), history.User("gracias"), history.Assistant("de nada"))
	if err := store.Save("s-agente", again, SaveOptions{Tokens: 2000}); err != nil {
		t.Fatal(err)
	}

	for name, want := range c.Files {
		got, err := os.ReadFile(filepath.Join(base, "sessions", name))
		if err != nil {
			t.Errorf("falta %s: %v", name, err)
			continue
		}
		if !reflect.DeepEqual(normalize(t, got), normalize(t, []byte(want))) {
			t.Errorf("%s distinto\n got: %.500s\nwant: %.500s", name, got, want)
		}
	}
	entries, _ := os.ReadDir(filepath.Join(base, "sessions"))
	if len(entries) != len(c.Files) {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("archivos: %v (esperaba %d)", names, len(c.Files))
	}
}

func TestIndexIsRebuiltWhenMissingOrCorrupt(t *testing.T) {
	c := loadCorpus(t).Sessions
	base := t.TempDir()
	placeCorpusFiles(t, base, c.Files)
	store := NewStore(base)

	os.Remove(store.IndexFile)
	if got := ids(store.List(50)); !sameSet(got, c.RebuiltIDs) {
		t.Fatalf("sin índice: %v", got)
	}
	os.WriteFile(store.IndexFile, []byte("{no es json"), 0o644)
	if got := ids(store.List(50)); !sameSet(got, c.CorruptIndexIDs) {
		t.Fatalf("índice corrupto: %v", got)
	}
	os.WriteFile(store.IndexFile, []byte("\xef\xbb\xbf"+`{"sessions":[]}`), 0o644)
	if got := store.List(50); len(got) != len(c.RebuiltIDs) {
		t.Fatalf("índice vacío con BOM: %d", len(got))
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]bool{}
	for _, x := range a {
		seen[x] = true
	}
	for _, x := range b {
		if !seen[x] {
			return false
		}
	}
	return true
}

func TestDeleteRemovesFileAndEntry(t *testing.T) {
	c := loadCorpus(t).Sessions
	base := t.TempDir()
	placeCorpusFiles(t, base, c.Files)
	store := NewStore(base)
	if !store.Delete("s-largo") {
		t.Fatal("Delete falló")
	}
	if got := ids(store.List(50)); !reflect.DeepEqual(got, c.AfterDelete) {
		t.Fatalf("tras borrar: %v, esperaba %v", got, c.AfterDelete)
	}
	if _, err := os.Stat(filepath.Join(base, "sessions", "s-largo.json")); err == nil {
		t.Fatal("el archivo sigue ahí")
	}
	if !store.Delete("no-existe") {
		t.Fatal("borrar algo inexistente no es un error")
	}
}

func TestRetentionKeepsTheNewest200(t *testing.T) {
	if got := loadCorpus(t).Sessions; got.MaxSessions != MaxSessions || got.MaxStoredChars != MaxStoredChars {
		t.Fatalf("constantes distintas a Python: %d %d", got.MaxSessions, got.MaxStoredChars)
	}
	store := NewStore(t.TempDir())
	now := 1_800_000_000.0
	store.Now = func() float64 { now++; return now }
	for i := 0; i < MaxSessions+5; i++ {
		if err := store.Save(fmt.Sprintf("s-%03d", i), []history.Message{history.User(fmt.Sprintf("tema %d", i))}, SaveOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	list := store.List(0)
	if len(list) != MaxSessions || list[0].ID != "s-204" || list[len(list)-1].ID != "s-005" {
		t.Fatalf("lista: %d, primero %s, último %s", len(list), list[0].ID, list[len(list)-1].ID)
	}
	files, _ := filepath.Glob(filepath.Join(store.Dir, "s-*.json"))
	if len(files) != MaxSessions {
		t.Fatalf("archivos en disco: %d", len(files))
	}
	for i := 0; i < 5; i++ {
		if _, err := os.Stat(store.path(fmt.Sprintf("s-%03d", i))); err == nil {
			t.Errorf("la sesión antigua s-%03d no se borró", i)
		}
	}
}

// Dos CLI guardando a la vez no pierden entradas del índice.
func TestTwoProcessesSavingConcurrentlyKeepEveryIndexEntry(t *testing.T) {
	base := t.TempDir()
	stores := []*Store{NewStore(base), NewStore(base)}
	var wg sync.WaitGroup
	const perProcess = 25
	for p, store := range stores {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perProcess; i++ {
				id := fmt.Sprintf("p%d-%02d", p, i)
				if err := store.Save(id, []history.Message{history.User("mensaje " + id)}, SaveOptions{}); err != nil {
					t.Errorf("Save %s: %v", id, err)
				}
			}
		}()
	}
	wg.Wait()
	var index struct {
		Sessions []Header `json:"sessions"`
	}
	raw, _ := os.ReadFile(stores[0].IndexFile)
	if err := json.Unmarshal(raw, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Sessions) != 2*perProcess {
		t.Fatalf("el índice tiene %d entradas, esperaba %d", len(index.Sessions), 2*perProcess)
	}
	if _, err := os.Stat(filepath.Join(stores[0].Dir, ".index.lock")); err == nil {
		t.Fatal("el candado quedó puesto")
	}
}

func TestStaleLockDoesNotBlockForever(t *testing.T) {
	store := NewStore(t.TempDir())
	os.MkdirAll(store.Dir, 0o755)
	lockPath := filepath.Join(store.Dir, ".index.lock")
	os.WriteFile(lockPath, nil, 0o600)
	old := timeAgo(int(lockStale/time.Second) + 5)
	os.Chtimes(lockPath, old, old)
	if err := store.Save("s", []history.Message{history.User("hola")}, SaveOptions{}); err != nil {
		t.Fatalf("un candado caducado no debe bloquear: %v", err)
	}
}

func TestListRepairsAnIndexMissingEntries(t *testing.T) {
	store := NewStore(t.TempDir())
	for _, id := range []string{"a", "b"} {
		store.Save(id, []history.Message{history.User("hola " + id)}, SaveOptions{})
	}
	// Otro proceso (p. ej. el CLI Python, que no usa candado) pisó el índice.
	os.WriteFile(store.IndexFile, []byte(`{"sessions":[]}`), 0o644)
	if got := len(store.List(0)); got != 2 {
		t.Fatalf("entradas tras reparar: %d", got)
	}
}

func TestListDropsEntriesWithoutFile(t *testing.T) {
	store := NewStore(t.TempDir())
	store.Save("a", []history.Message{history.User("hola")}, SaveOptions{})
	store.Save("b", []history.Message{history.User("adiós")}, SaveOptions{})
	os.Remove(store.path("a"))
	if got := ids(store.List(0)); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("got %v", got)
	}
}

func TestEmptyConversationsLeaveNoTrace(t *testing.T) {
	store := NewStore(t.TempDir())
	store.Save("vacia", nil, SaveOptions{})
	store.Save("espacios", []history.Message{history.User("   ")}, SaveOptions{})
	if _, err := os.Stat(store.Dir); err == nil {
		t.Fatal("no debe crear nada sin una conversación real")
	}
}

func TestTitlesCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Titles {
		if got := DeriveTitle(c.Messages); got != c.Output {
			t.Errorf("%s: %q, esperaba %q", c.Name, got, c.Output)
		}
	}
}

func TestRelativeTimeCorpus(t *testing.T) {
	const now = 1_800_000_000.0
	for _, c := range loadCorpus(t).RelativeTime {
		timestamp := 0.0
		if c.Delta != nil {
			timestamp = now - *c.Delta
		}
		if got := RelativeTime(now, timestamp); got != c.Output {
			t.Errorf("delta %v: %q, esperaba %q", c.Delta, got, c.Output)
		}
	}
}

func TestSavedSessionKeepsToolCallsAndRoundTrips(t *testing.T) {
	store := NewStore(t.TempDir())
	calls := []json.RawMessage{json.RawMessage(`{"id":"c1","function":{"name":"mkdir","arguments":{"path":"d"}}}`)}
	msgs := []history.Message{history.User("crea d"), {Role: "assistant", ToolCalls: calls},
		{Role: "tool", Content: "ok", ToolCallID: "c1", Name: "mkdir"}, history.Assistant("hecho")}
	store.Save("s", msgs, SaveOptions{Model: "m"})
	got, ok := store.Load("s")
	if !ok || len(got.Messages) != 4 || compact(t, got.Messages[1].ToolCalls[0]) != string(calls[0]) ||
		got.Messages[2].ToolCallID != "c1" || got.Model != "m" {
		t.Fatalf("round trip: %+v", got)
	}
}

func timeAgo(seconds int) time.Time { return time.Now().Add(-time.Duration(seconds) * time.Second) }

func compact(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}
