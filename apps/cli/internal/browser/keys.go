package browser

import (
	"fmt"
	"strings"
)

const (
	modAlt   = 1
	modCtrl  = 2
	modMeta  = 4
	modShift = 8
)

type keyDef struct {
	Key     string
	Code    string
	KeyCode int
	Text    string
}

var namedKeys = map[string]keyDef{
	"enter":      {"Enter", "Enter", 13, "\r"},
	"tab":        {"Tab", "Tab", 9, ""},
	"escape":     {"Escape", "Escape", 27, ""},
	"backspace":  {"Backspace", "Backspace", 8, ""},
	"delete":     {"Delete", "Delete", 46, ""},
	"space":      {" ", "Space", 32, " "},
	"arrowup":    {"ArrowUp", "ArrowUp", 38, ""},
	"arrowdown":  {"ArrowDown", "ArrowDown", 40, ""},
	"arrowleft":  {"ArrowLeft", "ArrowLeft", 37, ""},
	"arrowright": {"ArrowRight", "ArrowRight", 39, ""},
	"home":       {"Home", "Home", 36, ""},
	"end":        {"End", "End", 35, ""},
	"pageup":     {"PageUp", "PageUp", 33, ""},
	"pagedown":   {"PageDown", "PageDown", 34, ""},
	"insert":     {"Insert", "Insert", 45, ""},
}

var keyAliases = map[string]string{
	"esc": "escape", "return": "enter", "del": "delete", "up": "arrowup", "down": "arrowdown",
	"left": "arrowleft", "right": "arrowright", " ": "space",
}

var modifierNames = map[string]int{
	"alt": modAlt, "option": modAlt, "control": modCtrl, "ctrl": modCtrl,
	"meta": modMeta, "cmd": modMeta, "command": modMeta, "shift": modShift,
}

// parseKey entiende «Enter», «Control+A», «Shift+Tab», «F5» o un carácter.
func parseKey(spec string) (keyDef, int, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return keyDef{}, 0, fmt.Errorf("falta key")
	}
	var parts []string
	switch {
	case spec == "+":
		parts = []string{"+"}
	case strings.HasSuffix(spec, "++"):
		parts = append(strings.Split(strings.TrimSuffix(spec, "++"), "+"), "+")
	default:
		parts = strings.Split(spec, "+")
	}
	mods := 0
	for _, p := range parts[:len(parts)-1] {
		m, ok := modifierNames[strings.ToLower(strings.TrimSpace(p))]
		if !ok {
			return keyDef{}, 0, fmt.Errorf("modificador desconocido: %s", p)
		}
		mods |= m
	}
	name := parts[len(parts)-1]
	if trimmed := strings.TrimSpace(name); trimmed != "" {
		name = trimmed
	}
	lower := strings.ToLower(name)
	if alias, ok := keyAliases[lower]; ok {
		lower = alias
	}
	if def, ok := namedKeys[lower]; ok {
		return withoutText(def, mods), mods, nil
	}
	if len(lower) >= 2 && lower[0] == 'f' {
		var n int
		if _, err := fmt.Sscanf(lower[1:], "%d", &n); err == nil && n >= 1 && n <= 12 && fmt.Sprint(n) == lower[1:] {
			key := fmt.Sprintf("F%d", n)
			return keyDef{key, key, 111 + n, ""}, mods, nil
		}
	}
	runes := []rune(name)
	if len(runes) != 1 {
		return keyDef{}, 0, fmt.Errorf("tecla desconocida: %s", name)
	}
	r := runes[0]
	def := keyDef{Key: string(r), Text: string(r)}
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		upper := strings.ToUpper(string(r))
		def.Code, def.KeyCode = "Key"+upper, int(upper[0])
		if mods&modShift != 0 {
			def.Key, def.Text = upper, upper
		} else {
			def.Key, def.Text = strings.ToLower(string(r)), strings.ToLower(string(r))
		}
	case r >= '0' && r <= '9':
		def.Code, def.KeyCode = "Digit"+string(r), int(r)
	}
	return withoutText(def, mods), mods, nil
}

// Con Ctrl, Alt o Meta la tecla es un atajo y no escribe texto.
func withoutText(def keyDef, mods int) keyDef {
	if mods&(modCtrl|modAlt|modMeta) != 0 {
		def.Text = ""
	}
	return def
}
