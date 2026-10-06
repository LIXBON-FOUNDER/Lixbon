// Package mcp es un cliente del Model Context Protocol por stdio y por HTTP
// (Streamable HTTP) sin dependencias. Cada herramienta del servidor se expone
// al modelo como mcp__<servidor>__<herramienta>.
package mcp

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const FileName = "mcp.json"

// Spec es un servidor declarado en mcp.json: un programa local (Command) o un
// servidor remoto (URL).
type Spec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	Cwd     string
	URL     string
	Headers map[string]string
}

func (s Spec) Remote() bool { return s.URL != "" }

// Target resume a qué se conecta el servidor sin exponer credenciales: las
// URL se muestran sin query ni usuario.
func (s Spec) Target() string {
	if s.Remote() {
		return redactURL(s.URL)
	}
	return truncateRunes(strings.Join(append([]string{s.Command}, s.Args...), " "), 80)
}

// LoadSpecs lee los servidores del usuario (<home>/mcp.json) y del proyecto
// (<workspace>/.lixbon/mcp.json); los del proyecto pisan a los del usuario sin
// cambiar su posición. Acepta las claves servers y mcpServers.
func LoadSpecs(workspace, home string) []Spec {
	var specs []Spec
	index := map[string]int{}
	for _, path := range []string{
		filepath.Join(home, FileName),
		filepath.Join(workspace, ".lixbon", FileName),
	} {
		for _, spec := range readFile(path, workspace) {
			if i, ok := index[spec.Name]; ok {
				specs[i] = spec
				continue
			}
			index[spec.Name] = len(specs)
			specs = append(specs, spec)
		}
	}
	return specs
}

func readFile(path, workspace string) []Spec {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &top) != nil {
		return nil
	}
	entries := orderedEntries(top["servers"])
	if len(entries) == 0 {
		entries = orderedEntries(top["mcpServers"])
	}
	var specs []Spec
	for _, entry := range entries {
		if spec, ok := parseSpec(entry.name, entry.value, workspace); ok {
			specs = append(specs, spec)
		}
	}
	return specs
}

type entry struct {
	name  string
	value json.RawMessage
}

// orderedEntries recorre un objeto JSON respetando el orden del archivo.
func orderedEntries(raw json.RawMessage) []entry {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var out []entry
	for dec.More() {
		key, err := dec.Token()
		name, isString := key.(string)
		if err != nil || !isString {
			return out
		}
		var value json.RawMessage
		if dec.Decode(&value) != nil {
			return out
		}
		out = append(out, entry{name, value})
	}
	return out
}

func parseSpec(name string, raw json.RawMessage, workspace string) (Spec, bool) {
	var fields struct {
		Command string         `json:"command"`
		URL     string         `json:"url"`
		Cwd     string         `json:"cwd"`
		Args    []any          `json:"args"`
		Env     map[string]any `json:"env"`
		Headers map[string]any `json:"headers"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if dec.Decode(&fields) != nil {
		return Spec{}, false
	}
	switch {
	case fields.URL != "":
		return Spec{Name: name, URL: fields.URL, Headers: stringMap(fields.Headers)}, true
	case fields.Command != "":
		cwd := fields.Cwd
		if cwd == "" {
			cwd = workspace
		}
		args := make([]string, 0, len(fields.Args))
		for _, a := range fields.Args {
			args = append(args, scalar(a))
		}
		return Spec{Name: name, Command: fields.Command, Args: args, Env: stringMap(fields.Env), Cwd: cwd}, true
	}
	return Spec{}, false
}

func stringMap(in map[string]any) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		if v != nil {
			out[k] = scalar(v)
		}
	}
	return out
}

func scalar(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case bool:
		if t {
			return "true"
		}
		return "false"
	case nil:
		return ""
	}
	encoded, _ := json.Marshal(v)
	return string(encoded)
}
