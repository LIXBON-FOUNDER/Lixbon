package events

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// CompactJSON conserva los bytes de cada valor (los números no se reinterpretan).
func CompactJSON(raw []byte) ([]byte, error) {
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type ref struct {
	Kind string  `json:"kind"`
	ID   *string `json:"id"`
}

func (r ref) String() string {
	if r.ID == nil || *r.ID == "" {
		return clean(r.Kind)
	}
	return clean(r.Kind) + ":" + clean(*r.ID)
}

// HumanLine resume un evento en una línea sin interpretar su payload.
func HumanLine(raw json.RawMessage) (string, error) {
	var ev struct {
		Seq       int64   `json:"seq"`
		TS        int64   `json:"ts"`
		Kind      string  `json:"kind"`
		Actor     ref     `json:"actor"`
		Entity    ref     `json:"entity"`
		ProjectID *string `json:"project_id"`
		RunID     *string `json:"run_id"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return "", err
	}
	line := fmt.Sprintf("%d  %s  %s  %s  %s", ev.Seq, time.UnixMilli(ev.TS).UTC().Format("2006-01-02T15:04:05.000Z"),
		clean(ev.Kind), ev.Entity, ev.Actor)
	if ev.RunID != nil {
		line += "  run=" + clean(*ev.RunID)
	}
	if ev.ProjectID != nil {
		line += "  project=" + clean(*ev.ProjectID)
	}
	return line, nil
}

// clean evita que un valor del Core inyecte secuencias de control en la terminal.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return '?'
		}
		return r
	}, s)
}
