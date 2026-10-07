package config

import (
	"path/filepath"
	"testing"
)

func lixbonConfig() Config {
	cfg := Default()
	cfg.APIKey, cfg.Model, cfg.KeyModel = "lixbon_sk_abc", "qwen", "qwen"
	cfg.SetExtraString("plan_name", "Pro")
	return cfg
}

func TestLegacyConfigIsTheGatewayProfile(t *testing.T) {
	cfg := lixbonConfig()
	if cfg.ActiveProfile() != DefaultProfile || cfg.IsGeneric() {
		t.Fatalf("un config sin perfiles debe ser el gateway: %q generic=%v", cfg.ActiveProfile(), cfg.IsGeneric())
	}
	got := cfg.Profiles()[DefaultProfile]
	if got.BaseURL != DefaultBaseURL || got.APIKey != "lixbon_sk_abc" || got.Generic {
		t.Fatalf("perfil implícito: %+v", got)
	}
}

func TestUseProfileSwapsTopLevelFieldsAndKeepsTheOldOne(t *testing.T) {
	cfg := lixbonConfig()
	cfg.ContextWindow = 32768
	if err := cfg.AddProfile("local", Profile{BaseURL: "http://localhost:1234/v1", Model: "qwen-coder", ContextWindow: 8192, Generic: true}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.UseProfile("local"); err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "http://localhost:1234/v1" || cfg.APIKey != "" || cfg.Model != "qwen-coder" || cfg.KeyModel != "" || cfg.ContextWindow != 8192 {
		t.Fatalf("campos de nivel superior: %+v", cfg)
	}
	if cfg.ActiveProfile() != "local" || !cfg.IsGeneric() {
		t.Fatalf("activo: %q generic=%v", cfg.ActiveProfile(), cfg.IsGeneric())
	}

	cfg.Model = "otro-modelo"
	if err := cfg.UseProfile(DefaultProfile); err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != DefaultBaseURL || cfg.APIKey != "lixbon_sk_abc" || cfg.KeyModel != "qwen" || cfg.ContextWindow != 32768 || cfg.IsGeneric() {
		t.Fatalf("no se restauró lixbon: %+v", cfg)
	}
	if got := cfg.Profiles()["local"]; got.Model != "otro-modelo" || !got.Generic {
		t.Fatalf("el cambio de modelo en local debe recordarse: %+v", got)
	}
}

func TestProfilesSurviveSaveAndKeepUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := lixbonConfig()
	if err := cfg.AddProfile("ollama", Profile{BaseURL: Presets["ollama"], Model: "llama3", Generic: true}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.UseProfile("ollama"); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded := Load(path)
	if loaded.ActiveProfile() != "ollama" || !loaded.IsGeneric() || loaded.BaseURL != Presets["ollama"] {
		t.Fatalf("recarga: %q %v %q", loaded.ActiveProfile(), loaded.IsGeneric(), loaded.BaseURL)
	}
	if loaded.ExtraString("plan_name") != "Pro" {
		t.Fatal("se perdió un campo que el CLI Go no interpreta")
	}
	if names := loaded.ProfileNames(); len(names) != 2 || names[0] != "lixbon" || names[1] != "ollama" {
		t.Fatalf("nombres: %v", names)
	}
}

func TestProfileErrors(t *testing.T) {
	cfg := lixbonConfig()
	if err := cfg.UseProfile("nada"); err == nil {
		t.Fatal("cambiar a un perfil inexistente debe fallar")
	}
	if err := cfg.AddProfile(DefaultProfile, Profile{}); err == nil {
		t.Fatal("no se puede duplicar un nombre")
	}
	if err := cfg.RemoveProfile(DefaultProfile); err == nil {
		t.Fatal("no se puede eliminar el perfil activo")
	}
	if err := cfg.RemoveProfile("nada"); err == nil {
		t.Fatal("eliminar un perfil inexistente debe fallar")
	}
	cfg.AddProfile("temp", Profile{BaseURL: "http://x/v1", Generic: true})
	if err := cfg.RemoveProfile("temp"); err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Profiles()["temp"]; ok {
		t.Fatal("el perfil debería haberse eliminado")
	}
}

func TestNormalizeNamesAndURLs(t *testing.T) {
	if name, err := NormalizeProfileName("  Mi-Local "); err != nil || name != "mi-local" {
		t.Fatalf("%q %v", name, err)
	}
	for _, bad := range []string{"", "con espacios", "-x", "ñandú", "a/b"} {
		if _, err := NormalizeProfileName(bad); err == nil {
			t.Errorf("%q debería rechazarse", bad)
		}
	}
	cases := map[string]string{
		"LMStudio":                   "http://localhost:1234/v1",
		"http://10.0.0.5:8000/v1/":   "http://10.0.0.5:8000/v1",
		" https://api.openai.com/v1": "https://api.openai.com/v1",
	}
	for in, want := range cases {
		if got, err := NormalizeBaseURL(in); err != nil || got != want {
			t.Errorf("%q -> %q (%v), esperaba %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "localhost:1234", "ftp://x"} {
		if _, err := NormalizeBaseURL(bad); err == nil {
			t.Errorf("%q debería rechazarse", bad)
		}
	}
}
