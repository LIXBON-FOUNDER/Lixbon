package cloudhost

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/process"
	"lixbon.com/cli/internal/remote"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
)

// Mismo formato de eventos que el /remote de la TUI (tui/remote.go), que es el
// que pinta la web: tool_use/tool_result, assistant_delta/done, reasoning…
const (
	diffChars  = 6000
	diffRowMax = 240
	thinkMax   = 6000
	listMax    = 20
)

// sink reenvía lo que pasa en un turno como eventos del relay.
type sink struct {
	h       *Host
	agent   bool
	started time.Time

	mu         sync.Mutex
	raw        strings.Builder
	base, sent string
	toolID     string
	readID     string
	readTool   string
	activity   string
	thinking   strings.Builder
	thinkSince time.Time
	output     []byte
}

func (s *sink) setActivity(activity, tool, label string) {
	if key := activity + "|" + tool + "|" + label; key != s.activity {
		s.activity = key
		s.h.link.Emit("status", map[string]any{"state": "thinking", "activity": activity, "tool": tool, "label": label})
	}
}

func (s *sink) prose() string {
	text := s.raw.String()
	if s.agent {
		text = toolparse.CleanProse(text)
	}
	if text == "" {
		return strings.TrimSuffix(s.base, "\n\n")
	}
	return s.base + text
}

func (s *sink) Delta(kind sse.Kind, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch kind {
	case sse.Reasoning:
		s.setActivity("reasoning", "", "")
		if s.thinking.Len() == 0 {
			s.thinkSince = time.Now()
		}
		if s.thinking.Len() < thinkMax {
			s.thinking.WriteString(text)
			s.h.link.Emit("reasoning_delta", map[string]any{"text": text})
		}
		return
	case sse.Content:
	default:
		return
	}
	s.raw.WriteString(text)
	prose := s.prose()
	if prose == s.sent {
		return
	}
	s.endThinking()
	s.setActivity("writing", "", "")
	if rest, ok := strings.CutPrefix(prose, s.sent); ok {
		s.h.link.Emit("assistant_delta", map[string]any{"text": rest})
	} else {
		s.h.link.Emit("assistant_replace", map[string]any{"text": prose})
	}
	s.sent = prose
}

func (s *sink) endThinking() {
	text := strings.TrimSpace(s.thinking.String())
	s.thinking.Reset()
	if text != "" {
		s.h.emit("reasoning", map[string]any{"text": textutil.Head(text, thinkMax), "ms": time.Since(s.thinkSince).Milliseconds()})
	}
}

func (s *sink) closeStep(beforeTool bool) {
	s.endThinking()
	s.raw.Reset()
	switch {
	case beforeTool && s.sent != "":
		s.h.record("assistant_prose", map[string]any{"text": s.sent})
		s.base, s.sent = "", ""
	case beforeTool:
		s.base = ""
	case s.sent != "":
		s.base = s.sent + "\n\n"
	}
}

func (s *sink) Note(text string) { s.h.notice(text) }

func (s *sink) Title(string) {}

func (s *sink) Event(e agent.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch e.Kind {
	case agent.EventStep:
		s.closeStep(false)
		s.setActivity("working", "", "")
		s.h.emitContext()
	case agent.EventNote:
		s.closeStep(true)
		s.h.notice(e.Text)
	case agent.EventAction:
		s.closeStep(true)
		id := remote.NewID()
		fields := map[string]any{"id": id, "tool": e.Tool, "summary": e.Text, "readonly": e.ReadOnly}
		if e.Change != nil {
			for k, v := range changeFields(*e.Change) {
				fields[k] = v
			}
		}
		s.h.emit("tool_use", fields)
		if e.ReadOnly {
			result := map[string]any{"id": id, "tool": e.Tool, "result": e.Meta, "meta": e.Meta, "error": false}
			if lines := listLines(e.Tool, e.Result); len(lines) > 0 {
				result["lines"] = lines
			}
			s.h.emit("tool_result", result)
			s.toolID, s.readID, s.readTool = "", id, e.Tool
			s.setActivity("working", "", "")
		} else {
			s.toolID, s.readID, s.output = id, "", nil
			s.setActivity("tool", e.Tool, textutil.Head(e.Text, 120))
		}
	case agent.EventActionResult:
		id := s.toolID
		if id == "" && s.readID != "" && e.Tool == s.readTool {
			id = s.readID
		}
		if id == "" {
			id = remote.NewID()
		}
		s.flushOutput(true)
		s.toolID, s.readID = "", ""
		s.setActivity("working", "", "")
		result := firstNonEmpty(e.Result, e.Summary)
		fields := map[string]any{"id": id, "tool": e.Tool, "error": e.Failed}
		if e.Elapsed > 0 {
			fields["ms"] = e.Elapsed.Milliseconds()
		}
		if e.Tool == "run_command" {
			if code, rest, ok := exitCode(result); ok {
				fields["exit"], result = code, rest
			}
		}
		fields["result"] = textutil.Head(result, remote.ResultChars)
		s.h.emit("tool_result", fields)
	case agent.EventReadGroup:
		s.closeStep(true)
		id := remote.NewID()
		s.h.emit("tool_use", map[string]any{"id": id, "tool": "read_file", "summary": strings.Join(e.Names, ", "), "readonly": true})
		meta := fmt.Sprintf("%d líneas", e.Lines)
		s.h.emit("tool_result", map[string]any{"id": id, "tool": "read_file", "result": meta, "meta": meta, "error": false})
	}
}

// outputChunk manda la salida del comando en curso por líneas completas.
func (s *sink) outputChunk(chunk []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.toolID == "" {
		return
	}
	s.output = append(s.output, chunk...)
	s.flushOutput(false)
}

func (s *sink) flushOutput(all bool) {
	data := s.output
	cut := len(data)
	if !all {
		cut = strings.LastIndexByte(string(data), '\n') + 1
	}
	if cut <= 0 || s.toolID == "" {
		if all {
			s.output = nil
		}
		return
	}
	var lines []string
	for line := range strings.SplitSeq(string(data[:cut]), "\n") {
		if i := strings.LastIndexByte(line, '\r'); i >= 0 && i < len(line)-1 {
			line = line[i+1:]
		}
		if text := process.DecodeOutput([]byte(line)); text != "" {
			lines = append(lines, textutil.Head(text, 300))
		}
	}
	s.output = append([]byte(nil), data[cut:]...)
	if len(lines) > 0 {
		s.h.link.Emit("tool_output", map[string]any{"id": s.toolID, "text": strings.Join(lines, "\n") + "\n"})
	}
}

func (s *sink) bubble(answer string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	text := s.sent
	if answer = strings.TrimSpace(answer); answer != "" && !strings.Contains(text, answer) {
		if text != "" {
			text += "\n\n"
		}
		text += answer
	}
	return text
}

func (s *sink) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.endThinking()
	if s.toolID != "" {
		s.h.emit("tool_result", map[string]any{"id": s.toolID, "result": "interrumpido", "error": true})
		s.toolID = ""
	}
}

// changeFields describe una edición: ruta, líneas y diff (como tui/remote.go).
func changeFields(c agent.Change) map[string]any {
	adds, dels := agent.DiffCounts(c)
	var b strings.Builder
	for _, r := range agent.DiffRows(c, 2) {
		switch r.Kind {
		case "add":
			b.WriteString("+" + r.Text + "\n")
		case "del":
			b.WriteString("-" + r.Text + "\n")
		case "gap":
			b.WriteString("@@\n")
		default:
			b.WriteString(" " + r.Text + "\n")
		}
	}
	rows := agent.DiffRows(c, 1)
	out := make([][]any, 0, min(len(rows), diffRowMax))
	for i, r := range rows {
		if len(out) == diffRowMax {
			break
		}
		switch r.Kind {
		case "add":
			out = append(out, []any{"a", r.NewNo, textutil.Head(r.Text, 240)})
		case "del":
			out = append(out, []any{"d", r.OldNo, textutil.Head(r.Text, 240)})
		case "gap":
			skipped := 0
			if i > 0 && i+1 < len(rows) {
				skipped = max(0, rows[i+1].OldNo-rows[i-1].OldNo-1)
			}
			out = append(out, []any{"g", skipped, ""})
		default:
			out = append(out, []any{"c", r.NewNo, textutil.Head(r.Text, 240)})
		}
	}
	return map[string]any{"path": c.Path, "adds": adds, "dels": dels, "diff": textutil.Head(b.String(), diffChars), "rows": out}
}

func exitCode(result string) (int, string, bool) {
	if rest, ok := strings.CutPrefix(result, "[TIMEOUT]"); ok {
		return -1, strings.TrimSpace(rest), true
	}
	rest, ok := strings.CutPrefix(result, "[EXIT ")
	if !ok {
		return 0, result, false
	}
	num, rest, ok := strings.Cut(rest, "]")
	code, err := strconv.Atoi(num)
	if !ok || err != nil {
		return 0, result, false
	}
	return code, strings.TrimSpace(rest), true
}

func listLines(tool, result string) []string {
	switch tool {
	case "search", "search_codebase", "find_files", "list_files", "grep", "glob":
	default:
		return nil
	}
	var out []string
	for line := range strings.SplitSeq(result, "\n") {
		if line = strings.TrimRight(line, " \r"); strings.TrimSpace(line) == "" {
			continue
		}
		if len(out) == listMax {
			break
		}
		out = append(out, textutil.Head(line, 200))
	}
	return out
}
