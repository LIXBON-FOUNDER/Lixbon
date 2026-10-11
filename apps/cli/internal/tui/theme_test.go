package tui

import (
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

func envOf(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestThemeOverridesFollowTheirOrder(t *testing.T) {
	cases := []struct {
		name       string
		env        map[string]string
		configured string
		dark       bool
		decided    bool
	}{
		{"variable gana a config", map[string]string{"LIXBON_THEME": "light"}, "dark", false, true},
		{"config en español", nil, "claro", false, true},
		{"auto deja paso a COLORFGBG", map[string]string{"LIXBON_THEME": "auto", "COLORFGBG": "0;15"}, "", false, true},
		{"COLORFGBG oscuro", map[string]string{"COLORFGBG": "15;0"}, "", true, true},
		{"COLORFGBG con tres partes", map[string]string{"COLORFGBG": "15;default;8"}, "", true, true},
		{"terminal tonta", map[string]string{"TERM": "dumb"}, "", true, true},
		{"emacs", map[string]string{"INSIDE_EMACS": "29.1,comint"}, "", true, true},
		{"sin pistas pregunta a la terminal", nil, "auto", true, false},
	}
	for _, c := range cases {
		dark, decided := themeFor(envOf(c.env), c.configured)
		if dark != c.dark || decided != c.decided {
			t.Errorf("%s: dark=%v decided=%v, se esperaba %v %v", c.name, dark, decided, c.dark, c.decided)
		}
	}
}

func TestGlyphSetDependsOnTheTerminal(t *testing.T) {
	if g := glyphsFor(envOf(map[string]string{"LIXBON_ASCII": "1", "WT_SESSION": "x"}), "windows"); g.brand != asciiGlyphs.brand {
		t.Error("LIXBON_ASCII=1 debe elegir ASCII")
	}
	if g := glyphsFor(envOf(nil), "windows"); g.brand != safeGlyphs.brand {
		t.Error("la consola clásica de Windows debe usar el set seguro")
	}
	if g := glyphsFor(envOf(map[string]string{"WT_SESSION": "x"}), "windows"); g.brand != richGlyphs.brand {
		t.Error("Windows Terminal debe usar el set rico")
	}
	if g := glyphsFor(envOf(nil), "linux"); g.brand != richGlyphs.brand {
		t.Error("Linux debe usar el set rico")
	}
}

func TestASCIIGlyphsAreASCII(t *testing.T) {
	v := reflect.ValueOf(asciiGlyphs)
	for i := 0; i < v.NumField(); i++ {
		var texts []string
		switch f := v.Field(i); f.Kind() {
		case reflect.String:
			texts = []string{f.String()}
		case reflect.Slice:
			for j := 0; j < f.Len(); j++ {
				texts = append(texts, f.Index(j).String())
			}
		}
		for _, s := range texts {
			for _, r := range s {
				if r > unicode.MaxASCII {
					t.Errorf("%s: %q no es ASCII", v.Type().Field(i).Name, s)
				}
			}
		}
	}
}

func luminance(hex string) float64 {
	hex = strings.TrimPrefix(hex, "#")
	channel := func(s string) float64 {
		n, _ := strconv.ParseUint(s, 16, 8)
		c := float64(n) / 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(hex[0:2]) + 0.7152*channel(hex[2:4]) + 0.0722*channel(hex[4:6])
}

func contrast(a, b string) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func TestTokensKeepTheirContrast(t *testing.T) {
	for name, p := range map[string]palette{"oscuro": darkPalette, "claro": lightPalette} {
		checks := []struct {
			token, hex string
			min        float64
		}{
			{"ink", p.ink, 4.5}, {"body", p.body, 4.5}, {"soft", p.soft, 4.5},
			{"muted", p.muted, 3}, {"acc", p.acc, 3}, {"ok", p.ok, 3}, {"warn", p.warn, 3}, {"err", p.err, 3}, {"info", p.info, 3},
			{"faint", p.faint, 2.5},
		}
		for _, c := range checks {
			if got := contrast(c.hex, p.bg); got < c.min {
				t.Errorf("%s: %s %s tiene contraste %.2f (< %.1f)", name, c.token, c.hex, got, c.min)
			}
		}
	}
}

func TestMarkdownUsesTheLixbonCodeTheme(t *testing.T) {
	defer applyTheme(darkPalette)
	for _, p := range []palette{darkPalette, lightPalette} {
		applyTheme(p)
		cfg := markdownStyle(p, markdownMargin)
		if cfg.CodeBlock.Chroma != nil || cfg.CodeBlock.Theme != chromaTheme(p) {
			t.Fatalf("el bloque de código debe usar %s sin Chroma propio", chromaTheme(p))
		}
		r, err := newMarkdownRenderer(60, "")
		if err != nil {
			t.Fatal(err)
		}
		out, err := r.Render("```go\nfunc main() {}\n```\n")
		if err != nil {
			t.Fatal(err)
		}
		r8, g8, b8 := hexBytes(p.kw)
		if want := "38;2;" + r8 + ";" + g8 + ";" + b8; !strings.Contains(out, want) {
			t.Errorf("tema %v: la palabra clave no sale con el color %s:\n%q", p.dark, p.kw, out)
		}
	}
}

func hexBytes(hex string) (string, string, string) {
	hex = strings.TrimPrefix(hex, "#")
	part := func(s string) string {
		n, _ := strconv.ParseUint(s, 16, 8)
		return strconv.FormatUint(n, 10)
	}
	return part(hex[0:2]), part(hex[2:4]), part(hex[4:6])
}
