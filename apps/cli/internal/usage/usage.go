// Package usage guarda en el equipo los tokens que gasta cada petición al
// modelo, por proveedor y modelo, para que /usage los muestre sin ir a la
// consola de cada proveedor.
//
// Es un archivo de líneas JSON que solo crece: cada petición añade una línea
// con una sola escritura, así que dos CLI abiertos no se pisan.
package usage

import (
	"bufio"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// FileName es el registro dentro de la carpeta de configuración.
const FileName = "usage.jsonl"

// Record es una petición al modelo.
type Record struct {
	At         int64  `json:"at"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Prompt     int    `json:"prompt"`
	Completion int    `json:"completion"`
	Cached     int    `json:"cached,omitempty"`
}

// Log es el registro de un equipo.
type Log struct {
	Path string
	mu   sync.Mutex
}

func Open(path string) *Log { return &Log{Path: path} }

// Add apunta una petición. Un fallo al escribir no corta el turno.
func (l *Log) Add(r Record) error {
	if l == nil || r.Prompt <= 0 && r.Completion <= 0 {
		return nil
	}
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.Path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}

// Totals es lo gastado con un proveedor y un modelo en un periodo.
type Totals struct {
	Requests   int
	Prompt     int
	Completion int
	Cached     int
}

func (t Totals) Tokens() int { return t.Prompt + t.Completion }

func (t *Totals) add(r Record) {
	t.Requests++
	t.Prompt += r.Prompt
	t.Completion += r.Completion
	t.Cached += r.Cached
}

// Summary es lo de un proveedor y un modelo: hoy, los últimos 7 días y los
// últimos 30.
type Summary struct {
	Provider, Model    string
	Today, Week, Month Totals
	Last               time.Time
}

// Summaries resume el registro, del modelo usado más recientemente al más
// antiguo. Lo de hace más de 30 días no cuenta.
func (l *Log) Summaries(now time.Time) ([]Summary, error) {
	if l == nil {
		return nil, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.Open(l.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	y, m, d := now.Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, now.Location())
	week, month := today.AddDate(0, 0, -6), today.AddDate(0, 0, -29)
	byKey := map[string]*Summary{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		var r Record
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			continue
		}
		at := time.Unix(r.At, 0).In(now.Location())
		if at.Before(month) {
			continue
		}
		key := r.Provider + "\x00" + r.Model
		s := byKey[key]
		if s == nil {
			s = &Summary{Provider: r.Provider, Model: r.Model}
			byKey[key] = s
		}
		s.Month.add(r)
		if !at.Before(week) {
			s.Week.add(r)
		}
		if !at.Before(today) {
			s.Today.add(r)
		}
		if at.After(s.Last) {
			s.Last = at
		}
	}
	out := make([]Summary, 0, len(byKey))
	for _, s := range byKey {
		out = append(out, *s)
	}
	slices.SortFunc(out, func(a, b Summary) int {
		if c := b.Last.Compare(a.Last); c != 0 {
			return c
		}
		return strings.Compare(a.Provider+a.Model, b.Provider+b.Model)
	})
	return out, sc.Err()
}
