package config

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const (
	DefaultProfile = "lixbon"
	// DefaultGenericContext es prudente: un modelo local suele cargarse con
	// menos contexto que el del gateway.
	DefaultGenericContext = 8192
)

// Presets son servidores con API compatible con OpenAI que se pueden elegir
// por nombre en lugar de escribir la URL.
var Presets = map[string]string{
	"lmstudio":   "http://localhost:1234/v1",
	"ollama":     "http://localhost:11434/v1",
	"openai":     "https://api.openai.com/v1",
	"openrouter": "https://openrouter.ai/api/v1",
}

// Profile es un proveedor de modelos. Generic marca un servidor compatible con
// OpenAI que no es un gateway Lixbon: no se le envían los campos propios de
// Lixbon ni se consultan sus endpoints /api.
type Profile struct {
	BaseURL       string `json:"base_url"`
	APIKey        string `json:"api_key"`
	Model         string `json:"model"`
	KeyModel      string `json:"key_model"`
	ContextWindow int    `json:"context_window"`
	Generic       bool   `json:"generic,omitempty"`
}

var profileName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

func NormalizeProfileName(name string) (string, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !profileName.MatchString(name) {
		return "", fmt.Errorf("Nombre no válido: usa letras, números, punto, guion o guion bajo (máximo 32).")
	}
	return name, nil
}

// NormalizeBaseURL acepta un preset (lmstudio, ollama…) o una URL http(s).
func NormalizeBaseURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if url, ok := Presets[strings.ToLower(value)]; ok {
		return url, nil
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		return "", fmt.Errorf("La URL debe empezar por http:// o https:// (o ser un preset: %s).", strings.Join(PresetNames(), ", "))
	}
	return strings.TrimRight(value, "/"), nil
}

func PresetNames() []string {
	names := make([]string, 0, len(Presets))
	for name := range Presets {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func (c Config) ActiveProfile() string {
	if name := c.ExtraString("profile"); name != "" {
		return name
	}
	return DefaultProfile
}

func (c Config) storedProfiles() map[string]Profile {
	profiles := map[string]Profile{}
	if raw, ok := c.Extra["profiles"]; ok {
		_ = json.Unmarshal(raw, &profiles)
	}
	return profiles
}

func (c Config) IsGeneric() bool { return c.storedProfiles()[c.ActiveProfile()].Generic }

// Profiles devuelve todos los perfiles. Los campos de nivel superior del
// config (los que lee el CLI Python) pertenecen siempre al perfil activo, así
// que el activo se toma de ahí y no de la copia guardada.
func (c Config) Profiles() map[string]Profile {
	profiles := c.storedProfiles()
	profiles[c.ActiveProfile()] = Profile{
		BaseURL: c.BaseURL, APIKey: c.APIKey, Model: c.Model, KeyModel: c.KeyModel,
		ContextWindow: c.ContextWindow, Generic: c.IsGeneric(),
	}
	return profiles
}

func (c Config) ProfileNames() []string {
	profiles := c.Profiles()
	names := make([]string, 0, len(profiles))
	for name := range profiles {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func (c *Config) storeProfiles(profiles map[string]Profile) {
	raw, _ := marshalNoEscape(profiles)
	c.Extra["profiles"] = raw
}

func (c *Config) AddProfile(name string, p Profile) error {
	profiles := c.Profiles()
	if _, exists := profiles[name]; exists {
		return fmt.Errorf("Ya existe el proveedor «%s».", name)
	}
	profiles[name] = p
	c.storeProfiles(profiles)
	return nil
}

// UseProfile vuelca el perfil elegido en los campos de nivel superior y deja
// guardado el que se abandona.
func (c *Config) UseProfile(name string) error {
	profiles := c.Profiles()
	target, ok := profiles[name]
	if !ok {
		return fmt.Errorf("No existe el proveedor «%s».", name)
	}
	c.BaseURL, c.APIKey, c.Model, c.KeyModel = target.BaseURL, target.APIKey, target.Model, target.KeyModel
	if target.ContextWindow > 0 {
		c.ContextWindow = target.ContextWindow
	}
	c.SetExtraString("profile", name)
	c.storeProfiles(profiles)
	return nil
}

func (c *Config) RemoveProfile(name string) error {
	if name == c.ActiveProfile() {
		return fmt.Errorf("«%s» es el proveedor activo: cambia a otro antes de eliminarlo.", name)
	}
	profiles := c.Profiles()
	if _, ok := profiles[name]; !ok {
		return fmt.Errorf("No existe el proveedor «%s».", name)
	}
	delete(profiles, name)
	c.storeProfiles(profiles)
	return nil
}
