package toolparse

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type textCase struct {
	Name               string `json:"name"`
	Text               string `json:"text"`
	ExtractAll         any    `json:"extract_all"`
	HasInvalidCall     bool   `json:"has_invalid_call"`
	Strip              string `json:"strip"`
	TruncateFabricated string `json:"truncate_fabricated"`
	CutUnclosed        string `json:"cut_unclosed"`
	HasUnclosed        bool   `json:"has_unclosed"`
	CleanProse         string `json:"clean_prose"`
}

type nativeCase struct {
	Name     string         `json:"name"`
	Call     map[string]any `json:"call"`
	Expected any            `json:"expected"`
}

func loadCorpus(t *testing.T) (texts []textCase, natives []nativeCase) {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/tool_parse_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		TextCases   []textCase   `json:"text_cases"`
		NativeCases []nativeCase `json:"native_cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.TextCases) == 0 || len(corpus.NativeCases) == 0 {
		t.Fatal("corpus vacío")
	}
	return corpus.TextCases, corpus.NativeCases
}

func normalize(t *testing.T, calls ...Call) any {
	t.Helper()
	list := make([]map[string]any, 0, len(calls))
	for _, c := range calls {
		list = append(list, map[string]any{"tool": c.Tool, "args": c.Args})
	}
	return roundTrip(t, list)
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTextCorpus(t *testing.T) {
	texts, _ := loadCorpus(t)
	for _, c := range texts {
		t.Run(c.Name, func(t *testing.T) {
			if got := normalize(t, ExtractAll(c.Text)...); !reflect.DeepEqual(got, c.ExtractAll) {
				t.Errorf("ExtractAll\n got: %v\nwant: %v", got, c.ExtractAll)
			}
			if got := HasInvalidCall(c.Text); got != c.HasInvalidCall {
				t.Errorf("HasInvalidCall = %v, want %v", got, c.HasInvalidCall)
			}
			if got := Strip(c.Text); got != c.Strip {
				t.Errorf("Strip = %q, want %q", got, c.Strip)
			}
			if got := TruncateFabricated(c.Text); got != c.TruncateFabricated {
				t.Errorf("TruncateFabricated = %q, want %q", got, c.TruncateFabricated)
			}
			if got := CutUnclosed(c.Text); got != c.CutUnclosed {
				t.Errorf("CutUnclosed = %q, want %q", got, c.CutUnclosed)
			}
			if got := HasUnclosed(c.Text); got != c.HasUnclosed {
				t.Errorf("HasUnclosed = %v, want %v", got, c.HasUnclosed)
			}
			if got := CleanProse(c.Text); got != c.CleanProse {
				t.Errorf("CleanProse = %q, want %q", got, c.CleanProse)
			}
		})
	}
}

func TestNativeCorpus(t *testing.T) {
	_, natives := loadCorpus(t)
	for _, c := range natives {
		t.Run(c.Name, func(t *testing.T) {
			call := Native(c.Call)
			got := roundTrip(t, map[string]any{"tool": call.Tool, "args": call.Args})
			if !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("got %v, want %v", got, c.Expected)
			}
		})
	}
}

// Mientras la apertura {"tool" no está completa el texto aún no parece una
// llamada (igual que en Python); desde ahí ningún prefijo debe filtrar JSON.
func TestStreamingPrefixesNeverLeakRawCalls(t *testing.T) {
	prose := "Voy a crearlo."
	call := `{"tool":"write_file","args":{"path":"a.txt","content":"hola \"mundo\" fin"}}`
	full := prose + "\n" + call
	opening := len(prose) + 1 + len(`{"tool"`)
	for i := opening; i < len(full); i++ {
		if got := CleanProse(full[:i]); got != prose {
			t.Fatalf("prefijo %d (%q) filtró %q", i, full[:i], got)
		}
	}
}
