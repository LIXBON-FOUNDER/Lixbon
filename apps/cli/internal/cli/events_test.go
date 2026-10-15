package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/events"
)

const testToken = "tok-secret"

type coreEvent struct {
	seq                int64
	kind, project, run string
}

type fakeCore struct {
	t       *testing.T
	dir     string
	srv     *httptest.Server
	mu      sync.Mutex
	events  []coreEvent
	queries []url.Values
	headers []http.Header
	status  int
	body    string
}

func newFakeCore(t *testing.T, dir string, seqs ...int64) *fakeCore {
	t.Helper()
	c := &fakeCore{t: t, dir: dir}
	for _, seq := range seqs {
		c.events = append(c.events, coreEvent{seq: seq, kind: "task.created", run: "r1"})
	}
	c.start()
	t.Cleanup(func() { c.stop() })
	return c
}

func (c *fakeCore) start() {
	c.srv = httptest.NewServer(http.HandlerFunc(c.serve))
	port := c.srv.Listener.Addr().(*net.TCPAddr).Port
	raw, _ := json.Marshal(map[string]any{"port": port, "token": testToken})
	if err := os.WriteFile(filepath.Join(c.dir, "orch.json"), raw, 0o600); err != nil {
		c.t.Fatal(err)
	}
}

func (c *fakeCore) stop() {
	if c.srv != nil {
		c.srv.Close()
		c.srv = nil
	}
}

func (c *fakeCore) restart() {
	c.stop()
	c.start()
}

func (c *fakeCore) append(seqs ...int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, seq := range seqs {
		c.events = append(c.events, coreEvent{seq: seq, kind: "task.created", run: "r1"})
	}
}

func (c *fakeCore) replaceEvents(seqs ...int64) {
	c.mu.Lock()
	c.events = nil
	c.mu.Unlock()
	c.append(seqs...)
}

func (c *fakeCore) lastQuery() url.Values {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queries) == 0 {
		c.t.Fatal("el Core no recibió ninguna petición")
	}
	return c.queries[len(c.queries)-1]
}

func (c *fakeCore) requests() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queries)
}

func coreError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"ok":false,"code":%q,"error":%q}`, code, message)
}

func (c *fakeCore) serve(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.URL.Path != "/events" || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	c.queries = append(c.queries, q)
	c.headers = append(c.headers, r.Header.Clone())
	if c.status != 0 {
		w.WriteHeader(c.status)
		io.WriteString(w, c.body)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		coreError(w, 401, "unauthorized", "token inválido")
		return
	}
	known := map[string]bool{"cursor": true, "limit": true, "project": true, "run": true, "entity_kind": true,
		"entity_id": true, "kind": true, "kind_prefix": true, "class": true}
	for name := range q {
		if !known[name] {
			coreError(w, 400, "invalid_filter", "parámetro desconocido: "+name)
			return
		}
	}
	cursor := int64(0)
	if v := q.Get("cursor"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			coreError(w, 400, "invalid_cursor", "`cursor` debe ser un entero decimal >= 0")
			return
		}
		cursor = n
	}
	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			coreError(w, 400, "invalid_limit", "`limit` debe ser un entero >= 1")
			return
		}
		limit = min(n, 500)
	}
	head := int64(0)
	if n := len(c.events); n > 0 {
		head = c.events[n-1].seq
	}
	if cursor > head {
		coreError(w, 409, "cursor_ahead", "el cursor supera head_seq")
		return
	}
	var rows []coreEvent
	for _, e := range c.events {
		if e.seq <= cursor || (q.Get("kind") != "" && e.kind != q.Get("kind")) || (q.Get("project") != "" && e.project != q.Get("project")) {
			continue
		}
		rows = append(rows, e)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	next := head
	if hasMore {
		next = rows[len(rows)-1].seq
	}
	items := make([]string, len(rows))
	for i, e := range rows {
		project := "null"
		if e.project != "" {
			project = strconv.Quote(e.project)
		}
		items[i] = fmt.Sprintf(`{"seq":%d,"id":"id-%d","ts":1792045113470,"v":1,"kind":%q,"class":"state","actor":{"kind":"system","id":null},`+
			`"channel":"core","client_id":null,"project_id":%s,"run_id":%q,"entity":{"kind":"task","id":"t%d"},"correlation_id":null,"payload":{}}`,
			e.seq, e.seq, e.kind, project, e.run, e.seq)
	}
	fmt.Fprintf(w, `{"ok":true,"data":{"v":1,"events":[%s],"next_cursor":%d,"has_more":%t,"head_seq":%d,"limit":%d}}`,
		strings.Join(items, ","), next, hasMore, head, limit)
}

func newEventsHarness(t *testing.T, seqs ...int64) (*harness, *fakeCore) {
	t.Helper()
	t.Setenv("LXO_TASK_ID", "t1")
	h := newHarness(t, nil, nil)
	return h, newFakeCore(t, filepath.Dir(h.path), seqs...)
}

type sleeps struct {
	mu    sync.Mutex
	calls []time.Duration
	now   time.Time
	hook  func(n int)
}

func fakeClock(t *testing.T, hook func(n int)) *sleeps {
	t.Helper()
	s := &sleeps{now: time.Unix(1_800_000_000, 0), hook: hook}
	prevSleep, prevNow := events.Sleep, events.Now
	events.Sleep = func(ctx context.Context, d time.Duration) error {
		s.mu.Lock()
		s.calls = append(s.calls, d)
		s.now = s.now.Add(d)
		n := len(s.calls)
		s.mu.Unlock()
		if s.hook != nil {
			s.hook(n)
		}
		return ctx.Err()
	}
	events.Now = func() time.Time {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.now
	}
	t.Cleanup(func() { events.Sleep, events.Now = prevSleep, prevNow })
	return s
}

func (h *harness) runCtx(ctx context.Context, args ...string) int {
	return h.app.Run(ctx, args)
}

func outLines(h *harness) []string {
	text := strings.TrimRight(h.out.String(), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func seqsOf(t *testing.T, lines []string) []int64 {
	t.Helper()
	var seqs []int64
	for _, line := range lines {
		var ev struct {
			Seq int64 `json:"seq"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("línea NDJSON inválida %q: %v", line, err)
		}
		seqs = append(seqs, ev.Seq)
	}
	return seqs
}

func TestEventsSinArgumentosLeeLaPrimeraPagina(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3)
	if code := h.run("events"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if got, want := core.lastQuery(), (url.Values{"cursor": {"0"}}); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("query %v, quería %v", got, want)
	}
	if got := core.headers[0].Get("X-Lixbon-Caller"); got != "t1" {
		t.Errorf("X-Lixbon-Caller %q", got)
	}
	if got := core.headers[0].Get("Authorization"); got != "Bearer "+testToken {
		t.Errorf("Authorization %q", got)
	}
	lines := outLines(h)
	if len(lines) != 3 {
		t.Fatalf("salida %q", h.out)
	}
	want := "1  2026-10-15T06:18:33.470Z  task.created  task:t1  system  run=r1"
	if lines[0] != want {
		t.Errorf("primera línea\n got %q\nwant %q", lines[0], want)
	}
	if strings.Contains(h.errOut.String(), "--after") {
		t.Errorf("sin más páginas no debe sugerir --after: %q", h.errOut)
	}
}

func TestEventsVacioNoEsErrorYSalidaLimpia(t *testing.T) {
	h, _ := newEventsHarness(t)
	if code := h.run("events"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if h.out.Len() != 0 {
		t.Errorf("stdout debe quedar vacío: %q", h.out)
	}
	if !strings.Contains(h.errOut.String(), "Sin eventos") {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsAyuda(t *testing.T) {
	for _, flag := range []string{"--help", "-h"} {
		h, core := newEventsHarness(t)
		if code := h.run("events", flag); code != 0 {
			t.Fatalf("%s: code %d", flag, code)
		}
		for _, want := range []string{"--after", "--follow", "--json", "--limit", "--kind-prefix", "--max-outage", "Códigos de salida", "LXO_TASK_ID"} {
			if !strings.Contains(h.out.String(), want) {
				t.Errorf("%s: la ayuda no menciona %q", flag, want)
			}
		}
		if core.requests() != 0 {
			t.Errorf("%s: la ayuda no debe consultar el Core", flag)
		}
	}
	h := newHarness(t, nil, nil)
	if code := h.run("--help"); code != 0 || !strings.Contains(h.out.String(), "events") {
		t.Errorf("la ayuda general no lista events: %q", h.out)
	}
}

func TestEventsAfterEnvíaElCursorExacto(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3, 4)
	if code := h.run("events", "--after", "2"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if core.lastQuery().Get("cursor") != "2" {
		t.Errorf("query %v", core.lastQuery())
	}
	if lines := outLines(h); len(lines) != 2 || !strings.HasPrefix(lines[0], "3  ") || !strings.HasPrefix(lines[1], "4  ") {
		t.Errorf("salida %q", h.out)
	}
}

func TestEventsAfterInvalidoNoConsultaElCore(t *testing.T) {
	for _, value := range []string{"abc", "-1", "+3", "1.5", "", " 3", "3 ", "0x10", "9223372036854775808"} {
		h, core := newEventsHarness(t, 1)
		if code := h.run("events", "--after", value); code != events.ExitCursor {
			t.Errorf("--after %q: code %d, quería %d", value, code, events.ExitCursor)
		}
		if core.requests() != 0 || h.out.Len() != 0 || !strings.Contains(h.errOut.String(), "cursor") {
			t.Errorf("--after %q: peticiones %d, stdout %q, stderr %q", value, core.requests(), h.out, h.errOut)
		}
	}
}

func TestEventsFiltrosSeMapeanUnoAUnoALaListaCerrada(t *testing.T) {
	cases := []struct {
		args []string
		want url.Values
	}{
		{[]string{"--project", "p1"}, url.Values{"project": {"p1"}}},
		{[]string{"--run", "r1"}, url.Values{"run": {"r1"}}},
		{[]string{"--entity-kind", "task", "--entity-id", "t3"}, url.Values{"entity_kind": {"task"}, "entity_id": {"t3"}}},
		{[]string{"--kind", "task.created"}, url.Values{"kind": {"task.created"}}},
		{[]string{"--kind-prefix", "task."}, url.Values{"kind_prefix": {"task."}}},
		{[]string{"--class", "decision"}, url.Values{"class": {"decision"}}},
		{[]string{"--limit", "7", "--class", "effect", "--after", "5"}, url.Values{"limit": {"7"}, "class": {"effect"}, "cursor": {"5"}}},
		{[]string{"--project", "a&b=c d", "--kind", "x%y"}, url.Values{"project": {"a&b=c d"}, "kind": {"x%y"}}},
	}
	for _, tc := range cases {
		h, core := newEventsHarness(t, 1, 2, 3, 4, 5, 6)
		if code := h.run(append([]string{"events"}, tc.args...)...); code != 0 {
			t.Fatalf("%v: code %d, stderr %q", tc.args, code, h.errOut)
		}
		want := tc.want
		if want.Get("cursor") == "" {
			want.Set("cursor", "0")
		}
		got := core.lastQuery()
		if len(got) != len(want) {
			t.Errorf("%v: query %v, quería exactamente %v", tc.args, got, want)
			continue
		}
		for name, values := range want {
			if got.Get(name) != values[0] {
				t.Errorf("%v: %s=%q, quería %q", tc.args, name, got.Get(name), values[0])
			}
		}
	}
}

func TestEventsFiltroVacioSeEnviaYElCoreLoRechaza(t *testing.T) {
	h, core := newEventsHarness(t, 1)
	core.status, core.body = 400, `{"ok":false,"code":"invalid_filter","error":"filtro vacío"}`
	if code := h.run("events", "--project", ""); code != events.ExitUsage {
		t.Fatalf("code %d", code)
	}
	if _, sent := core.lastQuery()["project"]; !sent {
		t.Errorf("un filtro vacío no se ignora en silencio: %v", core.lastQuery())
	}
}

func TestEventsNoReenviaParametrosAjenos(t *testing.T) {
	h, _ := newEventsHarness(t, 1)
	for _, args := range [][]string{{"--session"}, {"--filter", "x"}, {"--task", "t1"}, {"extra"}} {
		if code := h.run(append([]string{"events"}, args...)...); code != events.ExitUsage {
			t.Errorf("%v: code %d, quería %d", args, code, events.ExitUsage)
		}
	}
}

func TestEventsJSONEsElDocumentoDelCoreTalCual(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "events_v1_page.json"))
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(fixture, &envelope); err != nil {
		t.Fatal(err)
	}
	var want bytes.Buffer
	if err := json.Compact(&want, envelope.Data); err != nil {
		t.Fatal(err)
	}

	h, core := newEventsHarness(t)
	core.status, core.body = 200, string(fixture)
	if code := h.run("events", "--json"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if got := h.out.String(); got != want.String()+"\n" {
		t.Errorf("--json no es el documento del Core\n got %s\nwant %s", got, want.String())
	}
	if !strings.Contains(h.out.String(), `"seq":9007199254740993`) {
		t.Errorf("el seq debe conservarse exacto: %s", h.out)
	}
	if h.errOut.Len() != 0 {
		t.Errorf("--json no escribe avisos: %q", h.errOut)
	}
}

func TestEventsPaginaSinSaltarNiRepetir(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3, 4, 5)
	var seen []int64
	cursor := "0"
	for page := 0; page < 5; page++ {
		h.out.Reset()
		h.errOut.Reset()
		if code := h.run("events", "--limit", "2", "--after", cursor, "--json"); code != 0 {
			t.Fatalf("code %d, stderr %q", code, h.errOut)
		}
		var doc struct {
			Events []struct {
				Seq int64 `json:"seq"`
			} `json:"events"`
			NextCursor int64 `json:"next_cursor"`
			HasMore    bool  `json:"has_more"`
		}
		if err := json.Unmarshal(h.out.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		for _, e := range doc.Events {
			seen = append(seen, e.Seq)
		}
		cursor = strconv.FormatInt(doc.NextCursor, 10)
		if !doc.HasMore {
			break
		}
	}
	if fmt.Sprint(seen) != "[1 2 3 4 5]" {
		t.Errorf("eventos leídos %v", seen)
	}
	if core.requests() != 3 {
		t.Errorf("peticiones %d", core.requests())
	}
}

func TestEventsHumanoSugiereLaSiguientePagina(t *testing.T) {
	h, _ := newEventsHarness(t, 1, 2, 3)
	if code := h.run("events", "--limit", "2", "--kind", "task.created"); code != 0 {
		t.Fatalf("code %d", code)
	}
	if !strings.Contains(h.errOut.String(), "--after 2") {
		t.Errorf("falta la pista de paginación: %q", h.errOut)
	}
	if strings.Contains(h.out.String(), "--after") {
		t.Errorf("la pista no va en stdout: %q", h.out)
	}
}

func TestEventsRedCaidaNuncaEsExito(t *testing.T) {
	h, core := newEventsHarness(t, 1)
	core.stop()
	if code := h.run("events"); code != events.ExitNetwork {
		t.Fatalf("code %d, quería %d", code, events.ExitNetwork)
	}
	if h.out.Len() != 0 {
		t.Errorf("stdout debe quedar vacío: %q", h.out)
	}
	if !strings.Contains(h.errOut.String(), "Error:") || strings.Contains(h.errOut.String(), testToken) {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsSinDesktopAbiertoEsErrorDeRed(t *testing.T) {
	t.Setenv("LXO_TASK_ID", "t1")
	h := newHarness(t, nil, nil)
	if code := h.run("events", "--json"); code != events.ExitNetwork {
		t.Fatalf("code %d", code)
	}
	var failure struct {
		OK    bool   `json:"ok"`
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(h.errOut.Bytes(), &failure); err != nil || failure.OK || failure.Code != "network" || failure.Error == "" {
		t.Errorf("stderr %q (%v)", h.errOut, err)
	}
	if h.out.Len() != 0 {
		t.Errorf("stdout %q", h.out)
	}
}

func TestEventsCodigosDeSalidaPorError(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   int
		text   string
	}{
		{"sin token", 401, `{"ok":false,"code":"unauthorized","error":"token inválido"}`, events.ExitAuth, "token inválido"},
		{"forbidden", 403, `{"ok":false,"code":"forbidden","error":"sin identidad"}`, events.ExitAuth, "sin identidad"},
		{"ruta inexistente", 404, `not found`, events.ExitVersion, "actualiza"},
		{"v distinta", 200, `{"ok":true,"data":{"v":2,"events":[],"next_cursor":0,"has_more":false,"head_seq":0,"limit":100}}`, events.ExitVersion, "v=2"},
		{"respuesta ajena", 200, `<html>`, events.ExitVersion, "respuesta"},
		{"cursor inválido", 400, `{"ok":false,"code":"invalid_cursor","error":"cursor malo"}`, events.ExitCursor, "cursor malo"},
		{"cursor adelantado", 409, `{"ok":false,"code":"cursor_ahead","error":"supera head_seq"}`, events.ExitCursor, "supera head_seq"},
		{"filtro inválido", 400, `{"ok":false,"code":"invalid_filter","error":"filtro malo"}`, events.ExitUsage, "filtro malo"},
		{"límite inválido", 400, `{"ok":false,"code":"invalid_limit","error":"límite malo"}`, events.ExitUsage, "límite malo"},
		{"event log no disponible", 503, `{"ok":false,"code":"event_log_unavailable","error":"sin SQLite"}`, events.ExitInternal, "sin SQLite"},
		{"interno", 500, `{"ok":false,"code":"internal","error":"fallo"}`, events.ExitInternal, "fallo"},
		{"contrato: has_more sin eventos", 200, `{"ok":true,"data":{"v":1,"events":[],"next_cursor":0,"has_more":true,"head_seq":9,"limit":100}}`, events.ExitVersion, "has_more"},
		{"contrato: seq no creciente", 200, `{"ok":true,"data":{"v":1,"events":[{"seq":3},{"seq":3}],"next_cursor":3,"has_more":false,"head_seq":3,"limit":100}}`, events.ExitVersion, "creciente"},
		{"contrato: next_cursor atrasado", 200, `{"ok":true,"data":{"v":1,"events":[{"seq":5}],"next_cursor":2,"has_more":false,"head_seq":5,"limit":100}}`, events.ExitVersion, "next_cursor"},
	}
	for _, tc := range cases {
		for _, asJSON := range []bool{false, true} {
			h, core := newEventsHarness(t, 1)
			core.status, core.body = tc.status, tc.body
			args := []string{"events"}
			if asJSON {
				args = append(args, "--json")
			}
			if code := h.run(args...); code != tc.want {
				t.Errorf("%s (json=%t): code %d, quería %d", tc.name, asJSON, code, tc.want)
			}
			if h.out.Len() != 0 {
				t.Errorf("%s (json=%t): un error no escribe en stdout: %q", tc.name, asJSON, h.out)
			}
			if !strings.Contains(h.errOut.String(), tc.text) || strings.Contains(h.errOut.String(), testToken) {
				t.Errorf("%s (json=%t): stderr %q no contiene %q", tc.name, asJSON, h.errOut, tc.text)
			}
		}
	}
}

func TestEventsForbiddenSinTareaExplicaLaIdentidad(t *testing.T) {
	h, core := newEventsHarness(t, 1)
	t.Setenv("LXO_TASK_ID", "")
	core.status, core.body = 403, `{"ok":false,"code":"forbidden","error":"sin identidad"}`
	if code := h.run("events"); code != events.ExitAuth {
		t.Fatalf("code %d", code)
	}
	if _, sent := core.headers[0]["X-Lixbon-Caller"]; sent {
		t.Errorf("sin LXO_TASK_ID no se declara ninguna identidad: %v", core.headers[0])
	}
	if !strings.Contains(h.errOut.String(), "LXO_TASK_ID") {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsFollowReanudaDesdeElCursorGuardado(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3)
	ctx, cancel := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel() })

	if code := h.runCtx(ctx, "events", "--follow", "--json"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[1 2 3]" {
		t.Fatalf("primera corrida %v", got)
	}
	saved, err := filepath.Glob(filepath.Join(filepath.Dir(h.path), "events", "*.cursor"))
	if err != nil || len(saved) != 1 {
		t.Fatalf("archivos de cursor %v (%v)", saved, err)
	}
	if raw, _ := os.ReadFile(saved[0]); strings.TrimSpace(string(raw)) != "3" {
		t.Errorf("cursor guardado %q", raw)
	}

	core.append(4, 5)
	h.out.Reset()
	ctx2, cancel2 := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel2() })
	if code := h.runCtx(ctx2, "events", "--follow", "--json"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if core.lastQuery().Get("cursor") != "3" {
		t.Errorf("la reanudación debe pedir desde el cursor guardado: %v", core.lastQuery())
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[4 5]" {
		t.Errorf("la reanudación repite o salta: %v", got)
	}
}

func TestEventsFollowAfterExplicitoGanaSobreElGuardado(t *testing.T) {
	h, _ := newEventsHarness(t, 1, 2, 3, 4)
	ctx, cancel := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel() })
	if code := h.runCtx(ctx, "events", "--follow", "--json"); code != 0 {
		t.Fatal(h.errOut)
	}
	h.out.Reset()
	ctx2, cancel2 := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel2() })
	if code := h.runCtx(ctx2, "events", "--follow", "--json", "--after", "2"); code != 0 {
		t.Fatal(h.errOut)
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[3 4]" {
		t.Errorf("salida %v", got)
	}
}

func TestEventsFollowReconectaSinSaltarNiRepetir(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3)
	ctx, cancel := context.WithCancel(context.Background())
	clock := fakeClock(t, func(n int) {
		switch n {
		case 1:
			core.stop()
		case 2:
			core.append(4)
			core.restart()
		case 3:
			cancel()
		}
	})
	if code := h.runCtx(ctx, "events", "--follow", "--json"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[1 2 3 4]" {
		t.Errorf("salida %v", got)
	}
	want := []time.Duration{500 * time.Millisecond, time.Second, 500 * time.Millisecond}
	if fmt.Sprint(clock.calls) != fmt.Sprint(want) {
		t.Errorf("esperas %v, quería %v", clock.calls, want)
	}
	if !strings.Contains(h.errOut.String(), "Reconectando") || strings.Contains(h.errOut.String(), testToken) {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsFollowSinConexionTrasMaxOutageFallaConRed(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2)
	core.stop()
	fakeClock(t, nil)
	code := h.runCtx(context.Background(), "events", "--follow", "--max-outage", "10s")
	if code != events.ExitNetwork {
		t.Fatalf("code %d, quería %d (stderr %q)", code, events.ExitNetwork, h.errOut)
	}
	if h.out.Len() != 0 {
		t.Errorf("stdout %q", h.out)
	}
	if !strings.Contains(h.errOut.String(), "10s") {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsFollowMaxOutageCeroNoReintenta(t *testing.T) {
	h, core := newEventsHarness(t, 1)
	core.stop()
	clock := fakeClock(t, nil)
	if code := h.runCtx(context.Background(), "events", "--follow", "--max-outage", "0"); code != events.ExitNetwork {
		t.Fatalf("code %d", code)
	}
	if len(clock.calls) != 0 {
		t.Errorf("esperas %v", clock.calls)
	}
}

func TestEventsFollowCursorAdelantadoGuardadoReiniciaEnCero(t *testing.T) {
	h, core := newEventsHarness(t, 1, 2, 3)
	ctx, cancel := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel() })
	if code := h.runCtx(ctx, "events", "--follow", "--json"); code != 0 {
		t.Fatal(h.errOut)
	}

	core.replaceEvents(1, 2)
	h.out.Reset()
	h.errOut.Reset()
	ctx2, cancel2 := context.WithCancel(context.Background())
	fakeClock(t, func(int) { cancel2() })
	if code := h.runCtx(ctx2, "events", "--follow", "--json"); code != 0 {
		t.Fatalf("code %d, stderr %q", code, h.errOut)
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[1 2]" {
		t.Errorf("salida %v", got)
	}
	if !strings.Contains(h.errOut.String(), "cursor guardado") {
		t.Errorf("stderr %q", h.errOut)
	}
}

func TestEventsFollowCursorAdelantadoExplicitoEsError(t *testing.T) {
	h, _ := newEventsHarness(t, 1, 2)
	fakeClock(t, nil)
	if code := h.runCtx(context.Background(), "events", "--follow", "--after", "50"); code != events.ExitCursor {
		t.Fatalf("code %d (stderr %q)", code, h.errOut)
	}
}

func TestEventsFollowTerminaLasPaginasAntesDeDormir(t *testing.T) {
	h, _ := newEventsHarness(t, 1, 2, 3, 4, 5)
	ctx, cancel := context.WithCancel(context.Background())
	clock := fakeClock(t, func(int) { cancel() })
	if code := h.runCtx(ctx, "events", "--follow", "--limit", "2", "--json"); code != 0 {
		t.Fatal(h.errOut)
	}
	if got := seqsOf(t, outLines(h)); fmt.Sprint(got) != "[1 2 3 4 5]" {
		t.Errorf("salida %v", got)
	}
	if len(clock.calls) != 1 {
		t.Errorf("solo debe dormir al llegar al final: %v", clock.calls)
	}
}

func TestEventsCancelarSinSeguirNoEsExito(t *testing.T) {
	h, _ := newEventsHarness(t, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if code := h.runCtx(ctx, "events"); code != events.ExitInterrupted {
		t.Fatalf("code %d, quería %d", code, events.ExitInterrupted)
	}
	if h.out.Len() != 0 {
		t.Errorf("stdout %q", h.out)
	}
}
