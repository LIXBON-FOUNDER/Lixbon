package tui

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/sse"
)

// longReply arma un texto con Unicode ancho y emoji del tamaño pedido (en runas).
func longReply(n int) string {
	seed := []rune("Lixbon responde con texto largo: 漢字かな交じり文と emoji 🚀✨🎉 mezclados con ASCII normal para medir el envuelto. Línea con acentos ñáéíóú.\n")
	out := make([]rune, 0, n)
	for len(out) < n {
		out = append(out, seed...)
	}
	return string(out[:n])
}

// streamInto alimenta la respuesta en fragmentos de 64 runas y dibuja tras
// cada uno, como hace el programa con cada mensaje.
func streamInto(h *harness, text string) {
	r := []rune(text)
	for i := 0; i < len(r); i += 64 {
		j := min(len(r), i+64)
		h.m.Update(deltaMsg{turn: h.m.turn, kind: sse.Content, text: string(r[i:j])})
		_ = h.m.View()
	}
}

func timeStream(t *testing.T, size int) time.Duration {
	h := newHarness(t, nil)
	h.update(tea.WindowSizeMsg{Width: 120, Height: 40})
	h.m.running = true
	text := longReply(size)
	start := time.Now()
	streamInto(h, text)
	return time.Since(start)
}

// TestLiveTailIsBoundedByScreen falla si el texto que se envuelve en cada
// View vuelve a depender del tamaño total de la respuesta (TERM-02).
func TestLiveTailIsBoundedByScreen(t *testing.T) {
	width := 118
	limit := (liveTailRows + 1) * width * 4
	for _, n := range []int{100, 20_000, 1_000_000} {
		text := longReply(n)
		tail := liveTail(text, liveTailRows, width)
		if len(tail) > limit {
			t.Fatalf("%d runas: se envuelven %d bytes, máximo %d", n, len(tail), limit)
		}
		if !strings.HasSuffix(text, tail) || !utf8.ValidString(tail) {
			t.Fatalf("%d runas: el recorte no es un sufijo UTF-8 válido", n)
		}
	}
	// Una sola línea gigante, sin saltos.
	one := strings.Repeat("palabra 漢字 🚀 ", 100_000)
	if tail := liveTail(one, liveTailRows, width); len(tail) > limit {
		t.Fatalf("línea única: %d bytes", len(tail))
	}
}

// TestLiveTailKeepsVisibleRows comprueba que lo dibujado coincide con las
// últimas filas del envuelto completo cuando hay saltos de línea.
func TestLiveTailKeepsVisibleRows(t *testing.T) {
	text := strings.TrimSpace(longReply(50_000))
	width := 118
	full := strings.Split(ansi.Wrap(text, width, ""), "\n")
	part := strings.Split(ansi.Wrap(liveTail(text, liveTailRows, width), width, ""), "\n")
	want := full[len(full)-liveTailRows:]
	got := part[max(0, len(part)-liveTailRows):]
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("filas visibles distintas:\n%q\n%q", got, want)
	}
}

// TestLiveRenderCostIsLinear compara el costo por fragmento con 20k y 200k
// runas. Antes del arreglo la relación era ~4x y crecía con el tamaño; con
// margen holgado, 2.5x detecta la vuelta al envuelto completo.
func TestLiveRenderCostIsLinear(t *testing.T) {
	if testing.Short() {
		t.Skip("mide tiempos")
	}
	perFrame := func(n int) float64 {
		best := time.Duration(1 << 62)
		for range 2 {
			best = min(best, timeStream(t, n))
		}
		return float64(best) / float64((n+63)/64)
	}
	small, big := perFrame(20_000), perFrame(200_000)
	t.Logf("por fragmento: 20k=%.0fµs 200k=%.0fµs", small/1e3, big/1e3)
	if big > small*2.5 {
		t.Fatalf("el dibujo por fragmento crece con el tamaño: %.1fx", big/small)
	}
}
