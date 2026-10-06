// Package config lee y escribe ~/.lixbon/config.json con el mismo formato que
// el CLI Python, preservando los campos que este no conoce.
package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const (
	Version        = "2.3.0-go.0"
	DefaultBaseURL = "https://lixbon.com/v1"
	UserAgent      = "Lixbon-CLI/" + Version
)

type Config struct {
	BaseURL            string
	APIKey             string
	Model              string
	KeyModel           string
	MaxContextMessages int
	ContextWindow      int
	Mode               string
	Workspace          string
	AutoApproveTools   bool
	InputQueue         bool

	// Extra conserva los campos que el CLI Go no interpreta (plan_name,
	// web_search, allowed_commands…) para no perderlos al guardar.
	Extra map[string]json.RawMessage
}

func Default() Config {
	workspace, _ := os.Getwd()
	return Config{
		BaseURL:            DefaultBaseURL,
		MaxContextMessages: 12,
		ContextWindow:      16384,
		Mode:               "agent",
		Workspace:          workspace,
		AutoApproveTools:   true,
		InputQueue:         true,
		Extra:              map[string]json.RawMessage{},
	}
}

func DefaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".lixbon"), nil
}

func DefaultPath() (string, error) {
	dir, err := DefaultDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Load devuelve los valores por defecto si el archivo falta o no es un objeto
// JSON válido, igual que el CLI Python. Un campo con tipo incorrecto o null
// conserva su valor por defecto.
func Load(path string) Config {
	cfg := Default()
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	var stored map[string]json.RawMessage
	if json.Unmarshal(raw, &stored) != nil {
		return cfg
	}
	for key, value := range stored {
		if string(bytes.TrimSpace(value)) == "null" {
			continue
		}
		if field := cfg.field(key); field != nil {
			_ = json.Unmarshal(value, field)
			continue
		}
		cfg.Extra[key] = value
	}
	return cfg
}

var knownKeys = []string{
	"base_url", "api_key", "model", "key_model", "max_context_messages",
	"context_window", "mode", "workspace", "auto_approve_tools", "input_queue",
}

func (c *Config) field(key string) any {
	switch key {
	case "base_url":
		return &c.BaseURL
	case "api_key":
		return &c.APIKey
	case "model":
		return &c.Model
	case "key_model":
		return &c.KeyModel
	case "max_context_messages":
		return &c.MaxContextMessages
	case "context_window":
		return &c.ContextWindow
	case "mode":
		return &c.Mode
	case "workspace":
		return &c.Workspace
	case "auto_approve_tools":
		return &c.AutoApproveTools
	case "input_queue":
		return &c.InputQueue
	}
	return nil
}

func (c *Config) MarshalIndent() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	write := func(key string, value any) error {
		encoded, err := marshalNoEscape(value)
		if err != nil {
			return err
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		name, _ := marshalNoEscape(key)
		buf.Write(name)
		buf.WriteByte(':')
		buf.Write(encoded)
		return nil
	}
	for _, key := range knownKeys {
		if err := write(key, reflectValue(c.field(key))); err != nil {
			return nil, err
		}
	}
	extraKeys := make([]string, 0, len(c.Extra))
	for key := range c.Extra {
		extraKeys = append(extraKeys, key)
	}
	slices.Sort(extraKeys)
	for _, key := range extraKeys {
		if err := write(key, c.Extra[key]); err != nil {
			return nil, err
		}
	}
	buf.WriteByte('}')
	var out bytes.Buffer
	if err := json.Indent(&out, buf.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func reflectValue(ptr any) any {
	switch p := ptr.(type) {
	case *string:
		return *p
	case *int:
		return *p
	case *bool:
		return *p
	}
	return nil
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Save escribe de forma atómica y con permisos de solo dueño: el archivo
// contiene la API key.
func Save(path string, cfg Config) error {
	body, err := cfg.MarshalIndent()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (c Config) ExtraString(key string) string {
	var s string
	if raw, ok := c.Extra[key]; ok && json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func (c *Config) SetExtraString(key, value string) {
	encoded, _ := marshalNoEscape(value)
	c.Extra[key] = encoded
}

// WebMode traduce el campo web_search (auto|on|off o el booleano antiguo).
func (c Config) WebMode() string {
	raw := c.Extra["web_search"]
	var s string
	if json.Unmarshal(raw, &s) == nil && (s == "auto" || s == "on" || s == "off") {
		return s
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil && b {
		return "on"
	}
	return "auto"
}

func ServerBase(baseURL string) string {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(baseURL, "/v1") {
		return strings.TrimSuffix(baseURL, "/v1")
	}
	return baseURL
}

func MaskKey(key string) string {
	runes := []rune(key)
	switch {
	case len(runes) == 0:
		return "no configurada"
	case len(runes) > 14:
		return string(runes[:10]) + "…" + string(runes[len(runes)-4:])
	}
	return "***"
}

// ExtraBool lee un booleano de los campos que el CLI Go no tipa, con valor
// por defecto si falta o no es booleano.
func (c Config) ExtraBool(key string, def bool) bool {
	var b bool
	if raw, ok := c.Extra[key]; ok && json.Unmarshal(raw, &b) == nil {
		return b
	}
	return def
}

func (c Config) ExtraStringList(key string) []string {
	var list []string
	if raw, ok := c.Extra[key]; ok && json.Unmarshal(raw, &list) == nil {
		return list
	}
	return nil
}

func (c *Config) SetExtraStringList(key string, list []string) {
	encoded, _ := marshalNoEscape(list)
	c.Extra[key] = encoded
}
