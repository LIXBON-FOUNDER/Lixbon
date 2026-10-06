// Package session guarda las conversaciones del CLI en ~/.lixbon/sessions/ con
// el mismo formato que el CLI Python: un JSON por sesión y un index.json con
// las cabeceras. Contrato fijado por validation/fixtures/state_corpus.json.
//
// Ninguna operación debe tumbar el CLI: el historial es una comodidad, no algo
// por lo que valga la pena perder un turno.
package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/textutil"
)

const (
	// MaxStoredChars acota cada mensaje al guardar: un read_file grande no
	// tiene por qué ocupar megas en disco para siempre.
	MaxStoredChars = 20000
	// MaxSessions: las más antiguas se van borrando solas.
	MaxSessions = 200

	truncatedMark = "\n…[truncado al guardar]"
	imageMark     = " [imagen adjunta]"
)

type Header struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	CreatedAt    float64 `json:"created_at"`
	UpdatedAt    float64 `json:"updated_at"`
	Model        string  `json:"model"`
	Mode         string  `json:"mode"`
	Workspace    string  `json:"workspace"`
	Tokens       int     `json:"tokens"`
	Messages     int     `json:"messages"`
	UserMessages int     `json:"user_messages"`
	Tools        int     `json:"tools"`
}

// Record es una sesión completa.
type Record struct {
	ID        string            `json:"id"`
	Title     string            `json:"title"`
	CreatedAt float64           `json:"created_at"`
	UpdatedAt float64           `json:"updated_at"`
	Model     string            `json:"model"`
	Mode      string            `json:"mode"`
	Workspace string            `json:"workspace"`
	Tokens    int               `json:"tokens"`
	Messages  []history.Message `json:"messages"`
}

// storedMessage es la forma en disco: solo los campos presentes, como los
// guardaba Python (a diferencia del payload al gateway, donde un mensaje de
// herramienta siempre lleva tool_call_id y name).
type storedMessage struct {
	Role       string            `json:"role"`
	Content    string            `json:"content"`
	ToolCalls  []json.RawMessage `json:"tool_calls,omitempty"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
	Name       string            `json:"name,omitempty"`
}

type storedRecord struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	CreatedAt float64         `json:"created_at"`
	UpdatedAt float64         `json:"updated_at"`
	Model     string          `json:"model"`
	Mode      string          `json:"mode"`
	Workspace string          `json:"workspace"`
	Tokens    int             `json:"tokens"`
	Messages  []storedMessage `json:"messages"`
}

func toStored(r Record) storedRecord {
	messages := make([]storedMessage, len(r.Messages))
	for i, m := range r.Messages {
		messages[i] = storedMessage{Role: m.Role, Content: m.Content, ToolCalls: m.ToolCalls, ToolCallID: m.ToolCallID, Name: m.Name}
	}
	return storedRecord{ID: r.ID, Title: r.Title, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Model: r.Model,
		Mode: r.Mode, Workspace: r.Workspace, Tokens: r.Tokens, Messages: messages}
}

type SaveOptions struct {
	Title     string
	Model     string
	Mode      string
	Workspace string
	Tokens    int
}

type Store struct {
	Dir       string
	IndexFile string
	// Now devuelve segundos desde la época; se sustituye en las pruebas.
	Now func() float64
}

func NewStore(base string) *Store {
	dir := filepath.Join(base, "sessions")
	return &Store{Dir: dir, IndexFile: filepath.Join(dir, "index.json"),
		Now: func() float64 { return float64(time.Now().UnixNano()) / 1e9 }}
}

func (s *Store) path(id string) string { return filepath.Join(s.Dir, id+".json") }

// DeriveTitle es el título de emergencia a partir del primer mensaje del
// usuario; el bueno lo pone el servidor.
func DeriveTitle(messages []history.Message) string {
	for _, m := range messages {
		if m.Role != "user" {
			continue
		}
		text := strings.Join(strings.FieldsFunc(m.Content, textutil.IsSpace), " ")
		if text == "" || strings.HasPrefix(text, "TOOL_RESULT") {
			continue
		}
		if utf8.RuneCountInString(text) > 60 {
			return textutil.Head(text, 60) + "…"
		}
		return text
	}
	return "Sin título"
}

// RelativeTime es «ahora», «hace 5 horas», «hace 2 días»…
func RelativeTime(now, timestamp float64) string {
	delta := max(0, int(now-timestamp))
	plural := func(n int, singular, plural string) string {
		if n > 1 {
			return plural
		}
		return singular
	}
	switch {
	case delta < 60:
		return "ahora"
	case delta < 3600:
		return fmt.Sprintf("hace %d min", delta/60)
	case delta < 86400:
		h := delta / 3600
		return fmt.Sprintf("hace %d %s", h, plural(h, "hora", "horas"))
	}
	days := delta / 86400
	if days < 30 {
		return fmt.Sprintf("hace %d %s", days, plural(days, "día", "días"))
	}
	if months := days / 30; months < 12 {
		return fmt.Sprintf("hace %d %s", months, plural(months, "mes", "meses"))
	}
	years := days / 365
	return fmt.Sprintf("hace %d %s", years, plural(years, "año", "años"))
}

func trim(messages []history.Message) []history.Message {
	out := make([]history.Message, len(messages))
	for i, m := range messages {
		if utf8.RuneCountInString(m.Content) > MaxStoredChars {
			m.Content = textutil.Head(m.Content, MaxStoredChars) + truncatedMark
		}
		// Las imágenes en base64 no se persisten: multiplicarían el tamaño del
		// archivo y no se pueden reenviar sin el original de todos modos.
		if len(m.Images) > 0 {
			m.Images = nil
			m.Content += imageMark
		}
		out[i] = m
	}
	return out
}

func isRealMessage(m history.Message) bool {
	if m.Role != "user" && m.Role != "assistant" {
		return false
	}
	if textutil.Strip(m.Content) == "" {
		return false
	}
	return !strings.HasPrefix(strings.TrimLeftFunc(m.Content, textutil.IsSpace), "TOOL_RESULT")
}

func header(r Record) Header {
	var users, assistants, tools int
	for _, m := range r.Messages {
		switch {
		case m.Role == "tool" || len(m.ToolCalls) > 0:
			tools++
		case m.Role == "user":
			users++
		case m.Role == "assistant":
			assistants++
		}
	}
	return Header{ID: r.ID, Title: r.Title, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Model: r.Model,
		Mode: r.Mode, Workspace: r.Workspace, Tokens: r.Tokens, Messages: users + assistants,
		UserMessages: users, Tools: tools}
}

func readJSON(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), out)
}

// writeJSON escribe de forma atómica (temporal + renombrado) con sangría de un
// espacio, como json.dumps(indent=1).
func writeJSON(path string, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, bytes.TrimRight(buf.Bytes(), "\n"), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (s *Store) readIndex() []Header {
	var data struct {
		Sessions []Header `json:"sessions"`
	}
	if readJSON(s.IndexFile, &data) != nil {
		return nil
	}
	out := data.Sessions[:0]
	for _, h := range data.Sessions {
		if h.ID != "" {
			out = append(out, h)
		}
	}
	return out
}

func sortRecent(items []Header) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
}

// List devuelve las cabeceras, la más reciente primero. Se repara solo: rehace
// el índice si falta, está corrupto o no recoge sesiones que sí están en
// disco (otro proceso pudo pisarlo), y descarta entradas sin archivo.
func (s *Store) List(limit int) []Header {
	items := s.readIndex()
	files := s.sessionIDs()
	known := map[string]bool{}
	for _, h := range items {
		known[h.ID] = true
	}
	missingFromIndex := false
	for id := range files {
		if !known[id] {
			missingFromIndex = true
			break
		}
	}
	if (len(items) == 0 && len(files) > 0) || (missingFromIndex && len(files) <= MaxSessions) {
		items = s.RebuildIndex()
	}
	kept := items[:0]
	for _, h := range items {
		if files[h.ID] {
			kept = append(kept, h)
		}
	}
	sortRecent(kept)
	if limit > 0 && len(kept) > limit {
		kept = kept[:limit]
	}
	return kept
}

func (s *Store) sessionIDs() map[string]bool {
	ids := map[string]bool{}
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return ids
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || name == "index.json" {
			continue
		}
		ids[strings.TrimSuffix(name, ".json")] = true
	}
	return ids
}

// Load devuelve la sesión completa o false si ya no está.
func (s *Store) Load(id string) (*Record, bool) {
	var r Record
	if readJSON(s.path(id), &r) != nil {
		return nil, false
	}
	return &r, true
}

// Save crea o actualiza una sesión. Sin mensajes reales no guarda nada: abrir
// el CLI y cerrarlo no debe dejar una conversación vacía en la lista.
func (s *Store) Save(id string, messages []history.Message, opts SaveOptions) error {
	real := false
	for _, m := range messages {
		if isRealMessage(m) {
			real = true
			break
		}
	}
	if !real {
		return nil
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	existing, found := s.Load(id)
	if !found {
		existing = &Record{}
	}
	created := existing.CreatedAt
	if created == 0 {
		created = s.Now()
	}
	record := Record{
		ID:        id,
		Title:     firstNonEmpty(opts.Title, existing.Title, DeriveTitle(messages)),
		CreatedAt: created,
		UpdatedAt: s.Now(),
		Model:     firstNonEmpty(opts.Model, existing.Model),
		Mode:      firstNonEmpty(opts.Mode, existing.Mode),
		Workspace: firstNonEmpty(opts.Workspace, existing.Workspace),
		Tokens:    opts.Tokens,
		Messages:  trim(messages),
	}
	if record.Tokens == 0 {
		record.Tokens = existing.Tokens
	}
	if err := writeJSON(s.path(id), toStored(record)); err != nil {
		return err
	}
	return s.updateIndex(record)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func (s *Store) updateIndex(record Record) error {
	unlock, err := s.lock()
	if err != nil {
		return err
	}
	defer unlock()
	items := []Header{}
	for _, h := range s.readIndex() {
		if h.ID != record.ID {
			items = append(items, h)
		}
	}
	items = append(items, header(record))
	sortRecent(items)
	if len(items) > MaxSessions {
		for _, stale := range items[MaxSessions:] {
			_ = os.Remove(s.path(stale.ID))
		}
		items = items[:MaxSessions]
	}
	return writeJSON(s.IndexFile, map[string]any{"sessions": items})
}

// RebuildIndex rehace el índice leyendo los archivos.
func (s *Store) RebuildIndex() []Header {
	items := []Header{}
	for id := range s.sessionIDs() {
		var r Record
		if readJSON(s.path(id), &r) != nil || r.ID == "" {
			continue
		}
		items = append(items, header(r))
	}
	sortRecent(items)
	if err := os.MkdirAll(s.Dir, 0o700); err == nil {
		if unlock, err := s.lock(); err == nil {
			_ = writeJSON(s.IndexFile, map[string]any{"sessions": items})
			unlock()
		}
	}
	return items
}

func (s *Store) Delete(id string) bool {
	if err := os.Remove(s.path(id)); err != nil && !os.IsNotExist(err) {
		return false
	}
	unlock, err := s.lock()
	if err != nil {
		return true
	}
	defer unlock()
	items := []Header{}
	for _, h := range s.readIndex() {
		if h.ID != id {
			items = append(items, h)
		}
	}
	_ = writeJSON(s.IndexFile, map[string]any{"sessions": items})
	return true
}
