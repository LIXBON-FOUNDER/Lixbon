package tui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

func verbCell(verb string) string { return fmt.Sprintf("%-*s", verbWidth, verb) }

func TestRenderActionAlignsMetaToTheRight(t *testing.T) {
	read := ansi.Strip(renderAction(agent.Event{Tool: "read_file", Text: "src/app.py", ReadOnly: true, Meta: "128 líneas"}, 60))
	if !strings.HasPrefix(read, "│ "+verbCell("leyó")+"src/app.py") || !strings.HasSuffix(read, "128 líneas") || ansi.StringWidth(read) != 60 {
		t.Fatalf("lectura: %q (%d)", read, ansi.StringWidth(read))
	}
	edit := ansi.Strip(renderAction(agent.Event{Tool: "edit_file", Change: &agent.Change{Kind: "update", Path: "a.go"}, Adds: 12, Dels: 3}, 60))
	if !strings.HasPrefix(edit, "┃ "+verbCell("editó")+"a.go") || !strings.HasSuffix(edit, "+12 -3") {
		t.Fatalf("edición: %q", edit)
	}
	rename := ansi.Strip(renderAction(agent.Event{Tool: "rename_file", Change: &agent.Change{Kind: "rename", Path: "a", Detail: "b"}}, 60))
	contains(t, rename, verbCell("movió")+"a → b")
	command := ansi.Strip(renderAction(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: "npm test"}}, 60))
	contains(t, command, verbCell("ejecutó")+"npm test")
	mcp := ansi.Strip(renderAction(agent.Event{Tool: "MCP", Text: "git.status"}, 60))
	contains(t, mcp, verbCell("MCP")+"git.status")
	long := ansi.Strip(renderAction(agent.Event{Tool: "read_file", Text: strings.Repeat("x", 100), ReadOnly: true, Meta: "5 líneas"}, 40))
	if ansi.StringWidth(long) > 40 || !strings.HasSuffix(long, "5 líneas") {
		t.Fatalf("recorte: %q", long)
	}
}

func TestRenderResultErrorsFillTheRow(t *testing.T) {
	ok := ansi.Strip(renderResult("1 reemplazo", false, "0.4 s", 50))
	if !strings.HasPrefix(ok, "│ └ 1 reemplazo") || !strings.HasSuffix(ok, "0.4 s") || ansi.StringWidth(ok) != 50 {
		t.Fatalf("ok: %q", ok)
	}
	bad := ansi.Strip(renderResult("old_text no coincide", true, "", 50))
	if !strings.HasPrefix(bad, "│ └ old_text no coincide") || ansi.StringWidth(bad) != 50 {
		t.Fatalf("error: %q (%d)", bad, ansi.StringWidth(bad))
	}
	if long := ansi.Strip(renderResult(strings.Repeat("e", 200), true, "", 50)); ansi.StringWidth(long) != 50 || !strings.Contains(long, "…") {
		t.Fatalf("error largo: %q", long)
	}
}

func TestRenderDiffNumbersSignsAndTruncation(t *testing.T) {
	rows := []agent.DiffRow{
		{Kind: "ctx", OldNo: 9, NewNo: 9, Text: "igual"},
		{Kind: "del", OldNo: 10, Text: "viejo\tcon tab"},
		{Kind: "add", NewNo: 10, Text: "nuevo"},
		{Kind: "gap"},
		{Kind: "ctx", OldNo: 100, NewNo: 100, Text: strings.Repeat("z", 200)},
	}
	lines := renderDiff(rows, 50, diffMaxRows)
	if len(lines) != 5 {
		t.Fatalf("filas: %d", len(lines))
	}
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = ansi.Strip(l)
		if ansi.StringWidth(plain[i]) > 50 {
			t.Fatalf("fila demasiado ancha: %q", plain[i])
		}
	}
	contains(t, plain[1], " 10 -viejo    con tab")
	contains(t, plain[2], " 10 +nuevo")
	if !strings.HasPrefix(plain[3], "│ ") || !strings.Contains(plain[3], "…") {
		t.Fatalf("hueco: %q", plain[3])
	}
	capped := renderDiff(rows, 50, 2)
	if len(capped) != 3 || !strings.Contains(ansi.Strip(capped[2]), "3 líneas más") {
		t.Fatalf("tope de filas: %q", capped)
	}
	if renderDiff(nil, 50, diffMaxRows) != nil {
		t.Fatal("sin filas no hay nada que pintar")
	}
}

func TestRenderOutputShowsHeadAndCountsTheRest(t *testing.T) {
	lines, last := renderOutput("uno\ndos\n\ntres\ncuatro\ncinco\n", 60)
	if last != "cinco" || len(lines) != 4 {
		t.Fatalf("last=%q lines=%d", last, len(lines))
	}
	contains(t, ansi.Strip(lines[3]), "… 1 líneas más")
	if l, last := renderOutput("  \n", 60); l != nil || last != "" {
		t.Fatal("salida vacía")
	}
	if l, last := renderOutput("solo una", 60); l != nil || last != "solo una" {
		t.Fatalf("una línea: %v %q", l, last)
	}
}

func TestRenderUserMessageWrapsInABubble(t *testing.T) {
	out := ansi.Strip(renderUserMessage("una frase bastante larga que no cabe en una sola fila de la burbuja", 40))
	rows := strings.Split(out, "\n")
	if len(rows) < 2 || !strings.Contains(rows[0], "●") || strings.Contains(rows[1], "●") {
		t.Fatalf("burbuja: %q", rows)
	}
	for _, r := range rows {
		if ansi.StringWidth(r) > 40 {
			t.Fatalf("fila de %d celdas: %q", ansi.StringWidth(r), r)
		}
	}
	short := strings.Split(ansi.Strip(renderUserMessage("sí", 80)), "\n")
	if len(short) != 1 || ansi.StringWidth(short[0]) > 12 {
		t.Fatalf("un «sí» no debe dibujar una banda de punta a punta: %q", short)
	}
}

func TestTurnSummaryAndFormatting(t *testing.T) {
	if renderTurnSummary(0, 0, 0, 0, 1, 80) != "" {
		t.Fatal("sin acciones no hay resumen")
	}
	if got := ansi.Strip(renderTurnSummary(3, 1, 12, 4, 2.5, 80)); got != "│ 3 acciones · 1 archivo · +12 -4 · 2.5 s" {
		t.Fatalf("resumen: %q", got)
	}
	if got := ansi.Strip(renderTurnSummary(1, 2, 0, 0, 0, 80)); got != "│ 1 acción · 2 archivos" {
		t.Fatalf("singular: %q", got)
	}
	for in, want := range map[int]string{0: "0", 999: "999", 1000: "1.0k", 15300: "15.3k", 2_500_000: "2.5M"} {
		if got := fmtTokens(in); got != want {
			t.Errorf("fmtTokens(%d) = %q, want %q", in, got, want)
		}
	}
	for pct, want := range map[float64]string{0: "░░░░░░░░", 50: "▓▓▓▓░░░░", 100: "▓▓▓▓▓▓▓▓", 150: "▓▓▓▓▓▓▓▓", -5: "░░░░░░░░"} {
		if got := contextBar(pct); got != want {
			t.Errorf("contextBar(%v) = %q, want %q", pct, got, want)
		}
	}
}
