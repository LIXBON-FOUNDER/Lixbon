package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadMissingFileGivesDefaults(t *testing.T) {
	cfg := Load(filepath.Join(t.TempDir(), "no-existe.json"))
	if cfg.BaseURL != DefaultBaseURL || cfg.ContextWindow != 16384 || cfg.Mode != "agent" || !cfg.InputQueue {
		t.Fatalf("defaults inesperados: %+v", cfg)
	}
}

func TestLoadAcceptsBOMAndKeepsUnknownFields(t *testing.T) {
	path := writeFile(t, "\xef\xbb\xbf"+`{"api_key":"k","model":"m","plan_name":"Pro","allowed_commands":["npm test"],"context_window":null,"mode":5}`)
	cfg := Load(path)
	if cfg.APIKey != "k" || cfg.Model != "m" {
		t.Fatalf("campos conocidos: %+v", cfg)
	}
	if cfg.ContextWindow != 16384 {
		t.Fatalf("null debe conservar el default, obtuve %d", cfg.ContextWindow)
	}
	if cfg.Mode != "agent" {
		t.Fatalf("tipo incorrecto debe conservar el default, obtuve %q", cfg.Mode)
	}
	if cfg.ExtraString("plan_name") != "Pro" {
		t.Fatalf("plan_name perdido: %v", cfg.Extra)
	}
}

func TestLoadCorruptFileGivesDefaults(t *testing.T) {
	for _, content := range []string{"{no json", "[1,2]", ""} {
		if cfg := Load(writeFile(t, content)); cfg.BaseURL != DefaultBaseURL || cfg.APIKey != "" {
			t.Fatalf("%q: %+v", content, cfg)
		}
	}
}

func TestSaveRoundTripPreservesUnknownFields(t *testing.T) {
	path := writeFile(t, `{"api_key":"k","web_search":true,"allowed_commands":["a","b"],"fixed_status_bar":false}`)
	cfg := Load(path)
	cfg.Model = "nuevo"
	if err := Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("JSON inválido: %v\n%s", err, raw)
	}
	if stored["model"] != "nuevo" || stored["web_search"] != true || stored["fixed_status_bar"] != false {
		t.Fatalf("campos perdidos: %v", stored)
	}
	if list, _ := stored["allowed_commands"].([]any); len(list) != 2 {
		t.Fatalf("allowed_commands: %v", stored["allowed_commands"])
	}
	again := Load(path)
	if again.WebMode() != "on" {
		t.Fatalf("WebMode = %q", again.WebMode())
	}
}

func TestSaveRestrictsPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("los bits POSIX no aplican en Windows")
	}
	path := filepath.Join(t.TempDir(), "sub", "config.json")
	if err := Save(path, Default()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("permisos %o", info.Mode().Perm())
	}
}

func TestSaveLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	if err := Save(filepath.Join(dir, "config.json"), Default()); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("archivos sobrantes: %v", entries)
	}
}

func TestWebMode(t *testing.T) {
	cases := map[string]string{
		`"on"`: "on", `"off"`: "off", `"auto"`: "auto", `true`: "on", `false`: "auto", `"x"`: "auto", ``: "auto",
	}
	for raw, want := range cases {
		cfg := Default()
		if raw != "" {
			cfg.Extra["web_search"] = json.RawMessage(raw)
		}
		if got := cfg.WebMode(); got != want {
			t.Errorf("web_search=%s: got %q want %q", raw, got, want)
		}
	}
}

func TestServerBase(t *testing.T) {
	cases := map[string]string{
		"https://lixbon.com/v1":  "https://lixbon.com",
		"https://lixbon.com/v1/": "https://lixbon.com",
		"http://localhost:8000":  "http://localhost:8000",
		"":                       "https://lixbon.com",
	}
	for in, want := range cases {
		if got := ServerBase(in); got != want {
			t.Errorf("ServerBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMaskKey(t *testing.T) {
	cases := map[string]string{
		"":                         "no configurada",
		"corta":                    "***",
		"12345678901234":           "***",
		"lixbon_sk_abcdefghijklmn": "lixbon_sk_…klmn",
	}
	for in, want := range cases {
		if got := MaskKey(in); got != want {
			t.Errorf("MaskKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSaveKeepsACopyOfACorruptFile(t *testing.T) {
	path := writeFile(t, `{"api_key": "lixbon_sk_a_mano", rota`)
	if err := Save(path, Default()); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(path + ".corrupt-*")
	if len(backups) != 1 {
		t.Fatalf("copias: %v", backups)
	}
	if data, _ := os.ReadFile(backups[0]); !strings.Contains(string(data), "lixbon_sk_a_mano") {
		t.Fatalf("la copia perdió el contenido: %q", data)
	}
	if cfg := Load(path); cfg.BaseURL != DefaultBaseURL {
		t.Fatalf("el archivo nuevo debe ser válido: %+v", cfg)
	}
}

func TestSaveDoesNotCopyValidOrEmptyFiles(t *testing.T) {
	for _, content := range []string{`{"api_key":"k"}`, "\xef\xbb\xbf" + `{"api_key":"k"}`, "", "  \n"} {
		path := writeFile(t, content)
		if err := Save(path, Default()); err != nil {
			t.Fatal(err)
		}
		if backups, _ := filepath.Glob(path + ".corrupt-*"); len(backups) != 0 {
			t.Errorf("%q no debía generar copia: %v", content, backups)
		}
	}
}
