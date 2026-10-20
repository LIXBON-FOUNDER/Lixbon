package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func press(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func typed(s string) tea.KeyPressMsg { return tea.KeyPressMsg{Code: []rune(s)[0], Text: s} }

func TestPickerNavigationFilterAndCancel(t *testing.T) {
	var chosen string
	var cancelled bool
	p := newPicker("Elige", []option{
		{Label: "Grupo", Disabled: true},
		{Label: "Alfa", Value: "a", Desc: "primera"},
		{Label: "Beta", Value: "b"},
		{Label: "Gamma", Value: "g"},
	}, func(v string, c bool) tea.Cmd { chosen, cancelled = v, c; return nil })
	p.cancel = "no"
	if p.cursor != 1 {
		t.Fatalf("el cursor salta las cabeceras: %d", p.cursor)
	}
	for i := 0; i < 3; i++ {
		p.key(press(tea.KeyDown))
	}
	if p.cursor != 1 {
		t.Fatalf("la navegación es circular y salta cabeceras: %d", p.cursor)
	}
	p.key(press(tea.KeyUp))
	if p.cursor != 3 {
		t.Fatalf("arriba desde el primero va al último: %d", p.cursor)
	}
	if _, closed := p.key(press(tea.KeyEnter)); !closed || chosen != "g" || cancelled {
		t.Fatalf("enter: %q cancelado=%v", chosen, cancelled)
	}
	if _, closed := p.key(press(tea.KeyEscape)); !closed || chosen != "no" || !cancelled {
		t.Fatalf("esc: %q cancelado=%v", chosen, cancelled)
	}

	p.key(typed("b"))
	if len(p.visible()) != 4 {
		t.Fatal("sin modo búsqueda, teclear no filtra")
	}
	p.search = true
	p.key(typed("b"))
	p.key(typed("e"))
	if v := p.visible(); len(v) != 1 || v[0].Label != "Beta" {
		t.Fatalf("filtro: %+v", v)
	}
	p.key(press(tea.KeyBackspace))
	p.key(press(tea.KeyBackspace))
	if len(p.visible()) != 4 || p.cursor != 1 {
		t.Fatalf("borrar el filtro restaura la lista: %d filas, cursor %d", len(p.visible()), p.cursor)
	}
	view := ansi.Strip(strings.Join(p.view(60, 12), "\n"))
	contains(t, view, "Elige")
	contains(t, view, "› Alfa")
	contains(t, view, "primera")
}

func TestPickerEnterIgnoresDisabledAndEmpty(t *testing.T) {
	called := false
	p := newPicker("x", []option{{Label: "solo cabecera", Disabled: true}}, func(string, bool) tea.Cmd { called = true; return nil })
	if _, closed := p.key(press(tea.KeyEnter)); closed || called {
		t.Fatal("no se puede elegir una cabecera")
	}
	p.search, p.filter = true, "zzz"
	if _, closed := p.key(press(tea.KeyEnter)); closed || called {
		t.Fatal("sin coincidencias no se elige nada")
	}
	contains(t, ansi.Strip(strings.Join(p.view(40, 12), "\n")), "sin coincidencias")
}

func TestPickerNumbersAndClicksChoose(t *testing.T) {
	var chosen string
	p := newPicker("¿Aplicar este cambio?", []option{
		{Label: "Sí", Value: "yes"}, {Label: "Sí, y no preguntar más", Value: "always"}, {Label: "No", Value: "no"},
	}, func(v string, _ bool) tea.Cmd { chosen = v; return nil })
	p.body = []string{"a.go · el diff está justo encima"}
	view := ansi.Strip(strings.Join(p.view(60, 12), "\n"))
	contains(t, view, "¿Aplicar este cambio?")
	contains(t, view, "1  Sí")
	contains(t, view, "3  No")
	contains(t, ansi.Strip(p.hints()), "1–3 elegir")
	if _, closed := p.key(typed("2")); !closed || chosen != "always" {
		t.Fatalf("el número elige: %q", chosen)
	}
	p.view(60, 12)
	if _, closed := p.click(p.optionTop + 2); !closed || chosen != "no" {
		t.Fatalf("el clic elige la fila: %q", chosen)
	}
	if _, closed := p.click(0); closed {
		t.Fatal("un clic en el borde no elige nada")
	}
	p.search = true
	if p.numbered() {
		t.Fatal("con filtro los números se escriben, no eligen")
	}
}

func TestInputHistoryUsesPromptToolkitFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "history")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := "\n# 2026-01-01 10:00:00.000001\n+primera\n\n# 2026-01-01 10:01:00.000002\n+multi\n+línea\n\n# 2026-01-01 10:02:00.000003\n+tercera\n"
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	h := loadInputHistory(path)
	if got := h.entries; len(got) != 3 || got[0] != "primera" || got[1] != "multi\nlínea" || got[2] != "tercera" {
		t.Fatalf("lectura: %q", got)
	}
	h.add("tercera")
	h.add("   ")
	h.add("nueva\ncon salto")
	if len(h.entries) != 4 {
		t.Fatalf("entradas: %q", h.entries)
	}
	again := loadInputHistory(path)
	if got := again.entries; len(got) != 4 || got[3] != "nueva\ncon salto" {
		t.Fatalf("ida y vuelta: %q", got)
	}
	data, _ := os.ReadFile(path)
	contains(t, string(data), "\n# 20")
	contains(t, string(data), "+nueva\n+con salto\n")
}

func TestInputHistoryMissingFileAndLimit(t *testing.T) {
	h := loadInputHistory(filepath.Join(t.TempDir(), "no-existe", "history"))
	if len(h.entries) != 0 {
		t.Fatal("un historial inexistente empieza vacío")
	}
	h.add("hola")
	if len(h.entries) != 1 {
		t.Fatal("se puede añadir aunque el directorio no exista aún")
	}
	path := filepath.Join(t.TempDir(), "history")
	big := ""
	for i := 0; i < maxInputHistory+50; i++ {
		big += "\n# t\n+línea " + string(rune('a'+i%26)) + "\n"
	}
	os.WriteFile(path, []byte(big), 0o600)
	if got := loadInputHistory(path).entries; len(got) != maxInputHistory {
		t.Fatalf("tope: %d", len(got))
	}
}
