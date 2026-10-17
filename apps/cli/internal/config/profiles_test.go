package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMiMoGetsItsWindowAndTokenPlanHint(t *testing.T) {
	for base, want := range map[string]bool{
		"https://token-plan-sgp.xiaomimimo.com/v1": true, Presets["xiaomi"]: true,
		"https://xiaomimimo.com.evil.example/v1": false, Presets["openrouter"]: false,
	} {
		if IsMiMo(base) != want {
			t.Errorf("IsMiMo(%s) debería ser %v", base, want)
		}
	}
	if DefaultContext(Presets["xiaomi"]) != mimoContext || DefaultContext(Presets["openai"]) != DefaultGenericContext {
		t.Fatal("la ventana por defecto de MiMo no debe ser la de un modelo local")
	}
	if KeyHint(Presets["xiaomi"], "tp-abc") == "" {
		t.Fatal("una clave del Token Plan en la URL de pago por uso debe avisar")
	}
	for base, key := range map[string]string{
		"https://token-plan-sgp.xiaomimimo.com/v1": "tp-abc", Presets["xiaomi"]: "sk-abc", Presets["openai"]: "tp-abc",
	} {
		if hint := KeyHint(base, key); hint != "" {
			t.Errorf("KeyHint(%s, %s) no debería avisar: %s", base, key, hint)
		}
	}
}

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

func TestUpdateProfileEditsActiveAndInactiveProviders(t *testing.T) {
	cfg := Default()
	cfg.APIKey, cfg.Model = "lixbon_sk_a", "qwen"
	if err := cfg.AddProfile("local", Profile{BaseURL: "http://localhost:1234/v1", Generic: true}); err != nil {
		t.Fatal(err)
	}

	if err := cfg.UpdateProfile("local", func(p *Profile) { p.APIKey, p.Model = "sk-local", "llama" }); err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "lixbon_sk_a" || cfg.Model != "qwen" {
		t.Fatalf("editar un proveedor inactivo no debe tocar el activo: %q %q", cfg.APIKey, cfg.Model)
	}
	if got := cfg.Profiles()["local"]; got.APIKey != "sk-local" || got.Model != "llama" || !got.Generic {
		t.Fatalf("local: %+v", got)
	}

	if err := cfg.UpdateProfile("lixbon", func(p *Profile) { p.APIKey = "lixbon_sk_b" }); err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "lixbon_sk_b" {
		t.Fatalf("editar el activo debe llegar a los campos de nivel superior: %q", cfg.APIKey)
	}
	if err := cfg.UseProfile("local"); err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-local" || cfg.Profiles()["lixbon"].APIKey != "lixbon_sk_b" {
		t.Fatalf("tras cambiar: activa=%q lixbon=%q", cfg.APIKey, cfg.Profiles()["lixbon"].APIKey)
	}

	if err := cfg.UpdateProfile("nada", func(*Profile) {}); err == nil {
		t.Fatal("un proveedor inexistente debe fallar")
	}
}

func TestLoadPrefersTheStoredActiveProfileOverStaleTopLevelFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	stale := `{"base_url":"https://lixbon.com/v1","api_key":"clave-kilo","model":"laguna","context_window":256000,
	"profile":"kilo","profiles":{"kilo":{"base_url":"https://api.kilo.ai/api/gateway","api_key":"clave-kilo","model":"kilo/auto","context_window":8192,"generic":true}}}`
	if err := os.WriteFile(path, []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := Load(path)
	if cfg.BaseURL != "https://api.kilo.ai/api/gateway" || cfg.Model != "kilo/auto" || cfg.ContextWindow != 8192 || !cfg.IsGeneric() {
		t.Fatalf("debe mandar el perfil guardado: %+v", cfg)
	}

	cfg.APIKey = "clave-nueva"
	if err := Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	var saved struct {
		BaseURL  string `json:"base_url"`
		APIKey   string `json:"api_key"`
		Profiles map[string]Profile
	}
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	kilo := saved.Profiles["kilo"]
	if saved.BaseURL != kilo.BaseURL || saved.APIKey != kilo.APIKey || kilo.APIKey != "clave-nueva" {
		t.Fatalf("el archivo debe tener una sola versión del perfil activo: top=%q/%q perfil=%+v", saved.BaseURL, saved.APIKey, kilo)
	}
}

func TestSaveWithoutProfilesKeepsTheLegacyShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := Save(path, lixbonConfig()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), `"profiles"`) {
		t.Fatalf("un config de un solo proveedor no debe ganar un campo profiles:\n%s", raw)
	}
}
