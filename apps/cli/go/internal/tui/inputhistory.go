package tui

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxInputHistory = 1000

// inputHistory es el historial de lo que se teclea (flechas arriba y abajo).
// Usa el formato de FileHistory de prompt_toolkit, el mismo que escribe el CLI
// Python en ~/.lixbon/history, para que los dos compartan el historial:
//
//	<línea en blanco>
//	# 2026-10-06 12:00:00.123456
//	+primera línea
//	+segunda línea
type inputHistory struct {
	path    string
	entries []string
}

func loadInputHistory(path string) *inputHistory {
	h := &inputHistory{path: path}
	file, err := os.Open(path)
	if err != nil {
		return h
	}
	defer file.Close()
	var current []string
	flush := func() {
		if len(current) > 0 {
			h.entries = append(h.entries, strings.Join(current, "\n"))
			current = nil
		}
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for scanner.Scan() {
		line := strings.TrimPrefix(scanner.Text(), "\ufeff")
		if strings.HasPrefix(line, "+") {
			current = append(current, line[1:])
			continue
		}
		flush()
	}
	flush()
	if len(h.entries) > maxInputHistory {
		h.entries = h.entries[len(h.entries)-maxInputHistory:]
	}
	return h
}

// add guarda una entrada nueva (sin repetir la anterior) y la anexa al archivo.
func (h *inputHistory) add(text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	if n := len(h.entries); n > 0 && h.entries[n-1] == text {
		return
	}
	h.entries = append(h.entries, text)
	if h.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(h.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	var sb strings.Builder
	fmt.Fprintf(&sb, "\n# %s\n", time.Now().Format("2006-01-02 15:04:05.000000"))
	for _, line := range strings.Split(text, "\n") {
		sb.WriteString("+" + line + "\n")
	}
	_, _ = f.WriteString(sb.String())
}
