package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var serverName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`)

// AddServer declara un servidor en el mcp.json de path (lo crea si no existe)
// sin tocar el resto del archivo: otras claves y el orden de los servidores
// se conservan, y el nuevo va al final. server es lo que va bajo su nombre
// ({"command": …, "args": …} o {"url": …}).
func AddServer(path, name string, server map[string]any) error {
	if !serverName.MatchString(name) {
		return errors.New("Nombre no válido: letras, números, guion o guion bajo (máximo 40).")
	}
	value, err := json.Marshal(server)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	top := orderedEntries(raw)
	if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 && (trimmed[0] != '{' || !json.Valid(trimmed)) {
		return fmt.Errorf("%s no es un JSON válido: corrígelo antes de añadir servidores.", path)
	}
	key := "servers"
	if !hasKey(top, "servers") && hasKey(top, "mcpServers") {
		key = "mcpServers"
	}
	found := false
	for i, e := range top {
		if e.name != key {
			continue
		}
		found = true
		servers := orderedEntries(e.value)
		if hasKey(servers, name) {
			return fmt.Errorf("Ya hay un servidor «%s» en %s.", name, path)
		}
		top[i].value = encodeObject(append(servers, entry{name, value}))
	}
	if !found {
		top = append(top, entry{key, encodeObject([]entry{{name, value}})})
	}
	var out bytes.Buffer
	if err := json.Indent(&out, encodeObject(top), "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Puede llevar claves de API: solo para el usuario.
	return os.WriteFile(path, out.Bytes(), 0o600)
}

func hasKey(entries []entry, key string) bool {
	for _, e := range entries {
		if e.name == key {
			return true
		}
	}
	return false
}

// encodeObject escribe las entradas como un objeto JSON en su orden.
func encodeObject(entries []entry) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range entries {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(e.name)
		b.Write(k)
		b.WriteByte(':')
		b.Write(e.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}
