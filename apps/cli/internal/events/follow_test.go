package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type step struct {
	page *Page
	err  error
}

type scripted struct {
	steps   []step
	cursors []int64
	onFetch func(n int)
}

func (s *scripted) Fetch(ctx context.Context, q Query) (*Page, error) {
	s.cursors = append(s.cursors, q.Cursor)
	n := len(s.cursors)
	if s.onFetch != nil {
		s.onFetch(n)
	}
	if n > len(s.steps) {
		return nil, context.Canceled
	}
	return s.steps[n-1].page, s.steps[n-1].err
}

func page(next int64, hasMore bool, seqs ...int64) step {
	p := &Page{NextCursor: next, HasMore: hasMore, HeadSeq: next, Seqs: seqs}
	for _, seq := range seqs {
		p.Events = append(p.Events, json.RawMessage(fmt.Sprintf(`{"seq":%d}`, seq)))
	}
	return step{page: p}
}

type memStore struct {
	cursor  int64
	found   bool
	saves   []int64
	loadErr error
	saveErr error
}

func (m *memStore) Load() (int64, bool, error) { return m.cursor, m.found, m.loadErr }
func (m *memStore) Save(c int64) error {
	if m.saveErr != nil {
		return m.saveErr
	}
	m.cursor, m.found = c, true
	m.saves = append(m.saves, c)
	return nil
}

type harness struct {
	f       *Follower
	emitted []int64
	notes   []string
	sleeps  []time.Duration
	now     time.Time
	cancel  context.CancelFunc
	ctx     context.Context
}

func newHarness(t *testing.T, fetch Fetcher, store CursorStore) *harness {
	t.Helper()
	h := &harness{now: time.Unix(1_800_000_000, 0)}
	h.ctx, h.cancel = context.WithCancel(context.Background())
	prevSleep, prevNow := Sleep, Now
	Sleep = func(ctx context.Context, d time.Duration) error {
		h.sleeps = append(h.sleeps, d)
		h.now = h.now.Add(d)
		return ctx.Err()
	}
	Now = func() time.Time { return h.now }
	t.Cleanup(func() { Sleep, Now = prevSleep, prevNow })
	h.f = &Follower{
		Fetcher: fetch,
		Store:   store,
		Notify:  func(format string, args ...any) { h.notes = append(h.notes, fmt.Sprintf(format, args...)) },
		Emit: func(raw json.RawMessage) error {
			var ev struct{ Seq int64 }
			_ = json.Unmarshal(raw, &ev)
			h.emitted = append(h.emitted, ev.Seq)
			return nil
		},
	}
	return h
}

func TestSeguirDescartaPorSeqElEventoDeBorde(t *testing.T) {
	fetch := &scripted{steps: []step{page(7, false, 5, 6, 7)}}
	store := &memStore{}
	h := newHarness(t, fetch, store)
	fetch.onFetch = func(n int) {
		if n == 2 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{Cursor: 5}, true); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(h.emitted) != "[6 7]" {
		t.Errorf("emitidos %v", h.emitted)
	}
	if fmt.Sprint(store.saves) != "[7]" {
		t.Errorf("guardados %v", store.saves)
	}
}

func TestSeguirEsperasDeSondeoConRetroceso(t *testing.T) {
	fetch := &scripted{steps: []step{
		page(2, true, 1, 2), page(3, false, 3), page(3, false), page(3, false), page(3, false), page(3, false), page(4, false, 4),
	}}
	h := newHarness(t, fetch, &memStore{})
	fetch.onFetch = func(n int) {
		if n == 8 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{500 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second, 2 * time.Second, 500 * time.Millisecond}
	if fmt.Sprint(h.sleeps) != fmt.Sprint(want) {
		t.Errorf("esperas %v, quería %v", h.sleeps, want)
	}
	if fmt.Sprint(fetch.cursors) != "[0 2 3 3 3 3 3 4]" {
		t.Errorf("cursores pedidos %v", fetch.cursors)
	}
	if fmt.Sprint(h.emitted) != "[1 2 3 4]" {
		t.Errorf("emitidos %v", h.emitted)
	}
}

func TestSeguirFiltradoAvanzaHastaHeadSinEventos(t *testing.T) {
	fetch := &scripted{steps: []step{page(40, false)}}
	store := &memStore{}
	h := newHarness(t, fetch, store)
	fetch.onFetch = func(n int) {
		if n == 2 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
	if fetch.cursors[1] != 40 || fmt.Sprint(store.saves) != "[40]" {
		t.Errorf("cursores %v, guardados %v", fetch.cursors, store.saves)
	}
}

func TestSeguirCancelarEnMitadDePaginaGuardaElUltimoEmitido(t *testing.T) {
	fetch := &scripted{steps: []step{page(4, false, 1, 2, 3, 4)}}
	store := &memStore{}
	h := newHarness(t, fetch, store)
	emit := h.f.Emit
	h.f.Emit = func(raw json.RawMessage) error {
		err := emit(raw)
		if len(h.emitted) == 2 {
			h.cancel()
		}
		return err
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(h.emitted) != "[1 2]" || fmt.Sprint(store.saves) != "[2]" {
		t.Errorf("emitidos %v, guardados %v", h.emitted, store.saves)
	}
}

func TestSeguirErrorDeSalidaGuardaLoEmitidoYFalla(t *testing.T) {
	fetch := &scripted{steps: []step{page(3, false, 1, 2, 3)}}
	store := &memStore{}
	h := newHarness(t, fetch, store)
	boom := errors.New("tubería rota")
	emit := h.f.Emit
	h.f.Emit = func(raw json.RawMessage) error {
		if len(h.emitted) == 2 {
			return boom
		}
		return emit(raw)
	}
	if err := h.f.Run(h.ctx, Query{}, false); !errors.Is(err, boom) {
		t.Fatalf("error %v", err)
	}
	if fmt.Sprint(store.saves) != "[2]" {
		t.Errorf("guardados %v", store.saves)
	}
}

func TestSeguirNoGuardaSiNoPudoEmitirNada(t *testing.T) {
	fetch := &scripted{steps: []step{page(3, false, 1, 2, 3)}}
	store := &memStore{cursor: 0, found: true}
	h := newHarness(t, fetch, store)
	h.f.Emit = func(json.RawMessage) error { return errors.New("sin salida") }
	if err := h.f.Run(h.ctx, Query{}, false); err == nil {
		t.Fatal("debía fallar")
	}
	if len(store.saves) != 0 {
		t.Errorf("guardados %v", store.saves)
	}
}

func TestSeguirReintentaRedConRetrocesoAcotado(t *testing.T) {
	down := step{err: newError(KindNetwork, "network", "refused")}
	fetch := &scripted{steps: []step{down, down, down, down, down, down, page(1, false, 1)}}
	h := newHarness(t, fetch, &memStore{})
	fetch.onFetch = func(n int) {
		if n == 8 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 8 * time.Second, 8 * time.Second, 500 * time.Millisecond}
	if fmt.Sprint(h.sleeps) != fmt.Sprint(want) {
		t.Errorf("esperas %v, quería %v", h.sleeps, want)
	}
	if fmt.Sprint(h.emitted) != "[1]" {
		t.Errorf("emitidos %v", h.emitted)
	}
}

func TestSeguirNoReintentaErroresQueNoSonDeRed(t *testing.T) {
	for _, kind := range []Kind{KindAuth, KindVersion, KindUsage, KindInternal, KindCursor} {
		fetch := &scripted{steps: []step{{err: newError(kind, "x", "falla")}, page(1, false, 1)}}
		h := newHarness(t, fetch, &memStore{})
		if err := h.f.Run(h.ctx, Query{}, false); err == nil || len(fetch.cursors) != 1 || len(h.sleeps) != 0 {
			t.Errorf("kind %d: err %v, intentos %d, esperas %v", kind, err, len(fetch.cursors), h.sleeps)
		}
	}
}

func TestSeguirErrorDeAlmacenDeCursorNoSeSilencia(t *testing.T) {
	fetch := &scripted{steps: []step{page(2, false, 1, 2)}}
	h := newHarness(t, fetch, &memStore{saveErr: errors.New("disco lleno")})
	err := h.f.Run(h.ctx, Query{}, false)
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Kind != KindInternal {
		t.Fatalf("error %v", err)
	}
}

func TestSeguirCursorGuardadoIlegibleEmpiezaDondePideLaConsulta(t *testing.T) {
	fetch := &scripted{steps: []step{page(1, false, 1)}}
	h := newHarness(t, fetch, &memStore{loadErr: errors.New("corrupto")})
	fetch.onFetch = func(n int) {
		if n == 2 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
	if fetch.cursors[0] != 0 || len(h.notes) == 0 {
		t.Errorf("cursores %v, avisos %v", fetch.cursors, h.notes)
	}
}

func TestSeguirCursorAdelantadoTrasProgresoPropioTambienReinicia(t *testing.T) {
	ahead := step{err: newError(KindCursorAhead, "cursor_ahead", "adelantado")}
	fetch := &scripted{steps: []step{page(5, false, 5), ahead, page(2, false, 1, 2)}}
	h := newHarness(t, fetch, &memStore{})
	fetch.onFetch = func(n int) {
		if n == 4 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{Cursor: 3}, true); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(fetch.cursors) != "[3 5 0 2]" || fmt.Sprint(h.emitted) != "[5 1 2]" {
		t.Errorf("cursores %v, emitidos %v", fetch.cursors, h.emitted)
	}
}

func TestStorePathSeparaTareaYFiltrosPeroNoElLimite(t *testing.T) {
	dir := t.TempDir()
	base := StorePath(dir, "t1", map[string]string{"kind": "a", "limit": "5"})
	if base != StorePath(dir, "t1", map[string]string{"limit": "50", "kind": "a"}) {
		t.Error("el límite no debe cambiar el cursor")
	}
	for name, other := range map[string]string{
		"tarea":   StorePath(dir, "t2", map[string]string{"kind": "a"}),
		"filtro":  StorePath(dir, "t1", map[string]string{"kind": "b"}),
		"nombre":  StorePath(dir, "t1", map[string]string{"kind_prefix": "a"}),
		"sin":     StorePath(dir, "t1", nil),
		"ambiguo": StorePath(dir, "t1", map[string]string{"kind": "a", "run": "x"}),
	} {
		if other == base {
			t.Errorf("%s comparte archivo de cursor", name)
		}
	}
}

func TestFileStoreIdaYVuelta(t *testing.T) {
	store := FileStore{Path: filepath.Join(t.TempDir(), "sub", "c.cursor")}
	if _, found, err := store.Load(); found || err != nil {
		t.Fatalf("archivo ausente: %v %v", found, err)
	}
	for _, want := range []int64{3, 9007199254740993} {
		if err := store.Save(want); err != nil {
			t.Fatal(err)
		}
		if got, found, err := store.Load(); err != nil || !found || got != want {
			t.Fatalf("leído %d %v %v, quería %d", got, found, err, want)
		}
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(store.Path), ".cursor-*"))
	if len(leftovers) != 0 {
		t.Errorf("temporales sin limpiar: %v", leftovers)
	}
	if err := os.WriteFile(store.Path, []byte("abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found, err := store.Load(); found || err == nil {
		t.Errorf("un cursor corrupto debe ser error: %v %v", found, err)
	}
}

func TestParseCursor(t *testing.T) {
	for text, want := range map[string]int64{"0": 0, "42": 42, "007": 7, "9223372036854775807": 9223372036854775807} {
		if got, err := ParseCursor(text); err != nil || got != want {
			t.Errorf("%q: %d %v", text, got, err)
		}
	}
	for _, text := range []string{"", "-1", "+1", "1.0", "1e3", " 1", "9223372036854775808", "１２"} {
		var apiErr *Error
		if _, err := ParseCursor(text); !errors.As(err, &apiErr) || apiErr.ExitCode() != ExitCursor {
			t.Errorf("%q: %v", text, err)
		}
	}
}

func TestHumanLineNoInterpretaPayloadNiDejaPasarControles(t *testing.T) {
	line, err := HumanLine(json.RawMessage(`{"seq":7,"ts":1792045113470,"kind":"x\u001b[31m.y","actor":{"kind":"agent","id":"t9"},"entity":{"kind":"task","id":null},"project_id":null,"run_id":null,"payload":{"title":"secreto"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := "7  2026-10-15T06:18:33.470Z  x?[31m.y  task  agent:t9"; line != want {
		t.Errorf("\n got %q\nwant %q", line, want)
	}
}

func TestSeguirCancelarSinConexionDevuelveErrorDeRedNoExito(t *testing.T) {
	down := step{err: newError(KindNetwork, "network", "refused")}
	fetch := &scripted{steps: []step{down, down, down}}
	h := newHarness(t, fetch, &memStore{})
	fetch.onFetch = func(n int) {
		if n == 3 {
			h.cancel()
		}
	}
	err := h.f.Run(h.ctx, Query{}, false)
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.ExitCode() != ExitNetwork {
		t.Fatalf("error %v", err)
	}
	if len(h.emitted) != 0 {
		t.Errorf("emitidos %v", h.emitted)
	}
}

func TestSeguirCancelarTrasRecuperarLaConexionEsExito(t *testing.T) {
	down := step{err: newError(KindNetwork, "network", "refused")}
	fetch := &scripted{steps: []step{down, page(1, false, 1)}}
	h := newHarness(t, fetch, &memStore{})
	fetch.onFetch = func(n int) {
		if n == 3 {
			h.cancel()
		}
	}
	if err := h.f.Run(h.ctx, Query{}, false); err != nil {
		t.Fatal(err)
	}
}

func TestPaginaRechazaViolacionesDelCursor(t *testing.T) {
	ev := func(seqs ...int64) []json.RawMessage {
		var out []json.RawMessage
		for _, s := range seqs {
			out = append(out, json.RawMessage(fmt.Sprintf(`{"seq":%d}`, s)))
		}
		return out
	}
	cases := []struct {
		name   string
		cursor int64
		page   Page
		ok     bool
	}{
		{"correcta con has_more", 2, Page{Events: ev(3, 4), NextCursor: 4, HasMore: true, HeadSeq: 9}, true},
		{"correcta al final", 2, Page{Events: ev(3, 4), NextCursor: 4, HeadSeq: 4}, true},
		{"vacía avanza hasta head", 2, Page{NextCursor: 9, HeadSeq: 9}, true},
		{"evento igual al cursor", 3, Page{Events: ev(3, 4), NextCursor: 4, HeadSeq: 4}, false},
		{"evento anterior al cursor", 3, Page{Events: ev(2), NextCursor: 3, HeadSeq: 3}, false},
		{"seq sobre head", 0, Page{Events: ev(5), NextCursor: 4, HeadSeq: 4}, false},
		{"has_more con next distinto del último", 0, Page{Events: ev(1, 2), NextCursor: 3, HasMore: true, HeadSeq: 9}, false},
		{"final con next distinto de head", 0, Page{Events: ev(1), NextCursor: 1, HeadSeq: 5}, false},
		{"next anterior al cursor", 7, Page{NextCursor: 3, HeadSeq: 3}, false},
		{"has_more sin eventos", 0, Page{NextCursor: 0, HasMore: true, HeadSeq: 4}, false},
	}
	for _, tc := range cases {
		p := tc.page
		err := p.validate(tc.cursor)
		var apiErr *Error
		if tc.ok && err != nil {
			t.Errorf("%s: %v", tc.name, err)
		}
		if !tc.ok && (!errors.As(err, &apiErr) || apiErr.ExitCode() != ExitVersion) {
			t.Errorf("%s: debía ser un error de contrato, fue %v", tc.name, err)
		}
	}
}
