// Package toolspec expone el catálogo de herramientas del agente. catalog.json
// es el contrato congelado de las herramientas.
package toolspec

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
)

//go:embed catalog.json
var raw []byte

type Spec struct {
	Name        string `json:"name"`
	Args        string `json:"args"`
	Description string `json:"description"`
}

type catalog struct {
	Schemas  []json.RawMessage   `json:"schemas"`
	Specs    []Spec              `json:"specs"`
	ReadOnly []string            `json:"read_only"`
	Mutating []string            `json:"mutating"`
	Edit     []string            `json:"edit"`
	ArgKeys  map[string][]string `json:"arg_keys"`
}

var cat = func() catalog {
	var c catalog
	if err := json.Unmarshal(raw, &c); err != nil {
		panic("catalog.json inválido: " + err.Error())
	}
	return c
}()

// Schemas devuelve las definiciones de función (formato OpenAI) que se envían
// en el campo tools de la petición.
func Schemas() []map[string]any {
	out := make([]map[string]any, len(cat.Schemas))
	for i, s := range cat.Schemas {
		_ = json.Unmarshal(s, &out[i])
	}
	return out
}

// Schema es la definición de una sola herramienta (nil si no existe).
func Schema(name string) map[string]any {
	for _, s := range Schemas() {
		if fn, _ := s["function"].(map[string]any); fn["name"] == name {
			return s
		}
	}
	return nil
}

func Specs() []Spec { return slices.Clone(cat.Specs) }

func Names() []string {
	names := make([]string, len(cat.Specs))
	for i, s := range cat.Specs {
		names[i] = s.Name
	}
	return names
}

func IsReadOnly(name string) bool { return slices.Contains(cat.ReadOnly, name) }
func IsMutating(name string) bool { return slices.Contains(cat.Mutating, name) }
func IsEdit(name string) bool     { return slices.Contains(cat.Edit, name) }
func IsBrowser(name string) bool {
	return strings.HasPrefix(name, "browser_") && slices.Contains(Names(), name)
}

// ArgKeys son los campos de args por herramienta, en el orden del prompt.
func ArgKeys(tool string) []string { return cat.ArgKeys[tool] }
