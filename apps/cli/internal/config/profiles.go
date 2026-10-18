package config

import (
	"encoding/json"
	"fmt"
	"net/url"
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
	"kilo":       "https://api.kilo.ai/api/gateway",
	"groq":       "https://api.groq.com/openai/v1",
	"deepseek":   "https://api.deepseek.com/v1",
	"mistral":    "https://api.mistral.ai/v1",
	"gemini":     "https://generativelanguage.googleapis.com/v1beta/openai",
	// xiaomi es el pago por uso de MiMo; el Token Plan tiene su propia URL
	// por región (token-plan-sgp.xiaomimimo.com/v1, token-plan-cn…).
	"xiaomi": "https://api.xiaomimimo.com/v1",
}

// mimoContext es prudente: los modelos MiMo de chat admiten bastante más, y
// con 8192 el prompt y las herramientas del agente casi llenan la ventana.
const mimoContext = 128000

// IsMiMo: la API de Xiaomi MiMo (api.xiaomimimo.com y los token-plan-*).
func IsMiMo(baseURL string) bool {
	_, ok := mimoHost(baseURL)
	return ok
}

func mimoHost(baseURL string) (host string, ok bool) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", false
	}
	host = strings.ToLower(u.Hostname())
	return host, host == "xiaomimimo.com" || strings.HasSuffix(host, ".xiaomimimo.com")
}

// DefaultContext es la ventana de un proveedor genérico nuevo: la conocida
// del servidor o, si no, DefaultGenericContext.
func DefaultContext(baseURL string) int {
	if IsMiMo(baseURL) {
		return mimoContext
	}
	return DefaultGenericContext
}

// KeyHint avisa de una clave que no va con esa URL: las del Token Plan de MiMo
// (tp-…) solo valen en la URL del Token Plan, no en la de pago por uso.
func KeyHint(baseURL, key string) string {
	if host, ok := mimoHost(baseURL); ok && strings.HasPrefix(key, "tp-") && !strings.HasPrefix(host, "token-plan-") {
		return "Las claves del Token Plan de MiMo (tp-…) van con la URL de tu Token Plan, " +
			"p. ej. https://token-plan-sgp.xiaomimimo.com/v1: cámbiala con /provider o lixbon profile set --base-url."
	}
	return ""
}

// LocalPresets no piden clave.
var LocalPresets = []string{"lmstudio", "ollama"}

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

// adoptActiveProfile resuelve un archivo desajustado: si los campos de nivel
// superior no son los del perfil activo (algo los cambió sin cambiar de perfil),
// manda el perfil guardado. Un perfil sin URL es una entrada incompleta, hecha
// a mano, y no se toma como referencia.
func (c *Config) adoptActiveProfile() {
	if p, ok := c.storedProfiles()[c.ActiveProfile()]; ok && p.BaseURL != "" {
		c.applyTopLevel(p)
	}
}

// syncActiveProfile guarda los campos de nivel superior en el perfil activo
// para que el archivo nunca quede con dos versiones distintas del mismo perfil.
func (c *Config) syncActiveProfile() {
	if _, ok := c.Extra["profiles"]; ok {
		c.storeProfiles(c.Profiles())
	}
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
	c.applyTopLevel(target)
	c.SetExtraString("profile", name)
	c.storeProfiles(profiles)
	return nil
}

func (c *Config) applyTopLevel(p Profile) {
	c.BaseURL, c.APIKey, c.Model, c.KeyModel = p.BaseURL, p.APIKey, p.Model, p.KeyModel
	if p.ContextWindow > 0 {
		c.ContextWindow = p.ContextWindow
	}
	c.FixMiMoWindow()
}

// knownWindows son las ventanas máximas de modelos cuyo proveedor no las
// informa al listar los modelos.
var knownWindows = map[string]int{
	"mimo-v2.6-pro":            1048576,
	"mimo-v2.6-pro-ultraspeed": 1048576,
}

// KnownWindow es la ventana máxima de un modelo conocido por su id, o 0.
func KnownWindow(model string) int {
	id := strings.ToLower(strings.TrimSpace(model))
	return knownWindows[id[strings.LastIndex(id, "/")+1:]]
}

// MiMoWindow es la ventana de un modelo MiMo, o mimoContext si no se conoce.
func MiMoWindow(model string) int {
	if w := KnownWindow(model); w > 0 {
		return w
	}
	return mimoContext
}

// FixMiMoWindow: un perfil MiMo con una ventana que puso el CLI (la genérica
// de antes, la prudente de mimoContext o la de otro modelo MiMo) pasa a la de
// su modelo. Con la genérica, el agente recortaba la conversación desde el
// primer paso; una ventana que eligió el usuario no se toca.
func (c *Config) FixMiMoWindow() {
	if !IsMiMo(c.BaseURL) {
		return
	}
	auto := c.ContextWindow == DefaultGenericContext || c.ContextWindow == mimoContext
	for _, w := range knownWindows {
		auto = auto || c.ContextWindow == w
	}
	if auto {
		c.ContextWindow = MiMoWindow(c.Model)
	}
}

// UpdateProfile edita un proveedor existente, sea el activo o no. Cambiar la
// URL, la clave o el modelo del activo también actualiza los campos de nivel
// superior, que son los que usa el cliente.
func (c *Config) UpdateProfile(name string, edit func(*Profile)) error {
	profiles := c.Profiles()
	p, ok := profiles[name]
	if !ok {
		return fmt.Errorf("No existe el proveedor «%s».", name)
	}
	edit(&p)
	profiles[name] = p
	if name == c.ActiveProfile() {
		c.applyTopLevel(p)
	}
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
