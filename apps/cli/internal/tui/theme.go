package tui

import (
	"image/color"
	"os"
	"runtime"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"

	"lixbon.com/cli/internal/config"
)

// palette son dos tintas (el fondo y la tinta, con los grises como tinta con
// menos fuerza) y una señal: el acento marca dónde estás, nunca decora. El
// verde, el ámbar y el coral solo pintan el glifo de un estado.
type palette struct {
	dark bool

	// surf es el fondo de los paneles y surf2 la banda: tu mensaje, la caja
	// y la fila elegida. rail es el riel del turno.
	bg, ink, body, soft, muted, faint, rule, surf, surf2, rail string
	acc, accDeep, olive, ivory, sand                           string
	ok, warn, err, info, code                                  string
	addBg, addFg, delBg, delFg                                 string
	kw, str, fn, ty, num, com                                  string
	f1, f2, f3, f4, spark, dot                                 string
	// shimmer: base, medio y pico del brillo que recorre la etiqueta viva.
	shBase, shMid, shHigh string
	// chipLive es el fondo de la etiqueta de una herramienta en marcha.
	chipLive string
	// shell: las órdenes que escribe el usuario con «!», en un rosa fluorescente que se ve de un vistazo.
	shell string
}

var darkPalette = palette{
	dark: true,
	bg:   "#0B0B0A", ink: "#EDECE6", body: "#D3D2CC", soft: "#B9B8B2", muted: "#85847F", faint: "#64635E",
	rule: "#262624", surf: "#141413", surf2: "#1F1F1D", rail: "#45453F",
	acc: "#C8E06A", accDeep: "#A9C04A", olive: "#2C2C29", ivory: "#EDECE6", sand: "#E4E3DD",
	ok: "#7FD38E", warn: "#E7C35A", err: "#F08A78", info: "#8EC5FF", code: "#E4E3DD",
	addBg: "#132317", addFg: "#7FD38E", delBg: "#2A1614", delFg: "#F08A78",
	kw: "#E59AD6", str: "#F2C98A", fn: "#8EC5FF", ty: "#C3B4FF", num: "#F5D98A", com: "#6A6A65",
	f1: "#ECEBE5", f2: "#ABAAA3", f3: "#53534E", f4: "#33332F", spark: "#FAF9F4", dot: "#151514",
	shBase: "#85847F", shMid: "#B9B8B2", shHigh: "#FAF9F4", chipLive: "#222220",
	shell: "#FF4FD8",
}

var lightPalette = palette{
	bg: "#F4F3EE", ink: "#141413", body: "#2E2E2B", soft: "#45443F", muted: "#75746D", faint: "#9A998F",
	rule: "#DCDBD2", surf: "#EBEAE4", surf2: "#E1E0D9", rail: "#B9B8AF",
	acc: "#5E7A10", accDeep: "#4C640C", olive: "#D6D5CC", ivory: "#141413", sand: "#1F1F1D",
	ok: "#2F8240", warn: "#946C0C", err: "#B3412B", info: "#2B63A6", code: "#1F1F1D",
	addBg: "#DDEED8", addFg: "#1F6B1A", delBg: "#F5DED8", delFg: "#9E1F14",
	kw: "#9B3D86", str: "#8A5A12", fn: "#2B63A6", ty: "#6046B0", num: "#7A6210", com: "#A3A39B",
	f1: "#1A1A18", f2: "#5A5954", f3: "#AFAEA6", f4: "#CDCCC3", spark: "#0B0B0A", dot: "#E2E1D9",
	shBase: "#75746D", shMid: "#45443F", shHigh: "#0B0B0A", chipLive: "#E1E0D9",
	shell: "#C0158F",
}

// pal es el tema en uso. themeVersion cambia con cada applyTheme para que
// las cachés que dependen de los colores (markdown) sepan que caducaron.
var (
	pal          palette
	themeVersion int
)

var (
	cCream, cAccent, cBeige, cDim, cDim2, cOK, cErr, cWarn, cPlan color.Color
	cAddBG, cDelBG, cAddFG, cDelFG, cBubble                       color.Color

	sDim, sDim2, sAccent, sBeige, sPrimary, sBold, sOK, sErr, sWarn, sPlan lipgloss.Style
	sAddNum, sDelNum, sInk, sSoft, sCode, sSelected, sTrack, sShell        lipgloss.Style
)

func init() {
	applyTheme(darkPalette)
	applyGlyphs(richGlyphs)
}

func applyTheme(p palette) {
	pal = p
	themeVersion++
	c := lipgloss.Color
	cCream, cAccent, cBeige, cDim, cDim2 = c(p.ink), c(p.acc), c(p.sand), c(p.muted), c(p.faint)
	cOK, cErr, cWarn, cPlan = c(p.ok), c(p.err), c(p.warn), c(p.info)
	cAddBG, cDelBG, cAddFG, cDelFG, cBubble = c(p.addBg), c(p.delBg), c(p.addFg), c(p.delFg), c(p.surf)

	fg := func(hex string) lipgloss.Style { return lipgloss.NewStyle().Foreground(c(hex)) }
	sDim, sDim2, sAccent, sBeige = fg(p.muted), fg(p.faint), fg(p.acc), fg(p.sand)
	sPrimary, sBold, sInk, sSoft = fg(p.body), fg(p.ink), fg(p.ink), fg(p.soft)
	sOK, sErr, sWarn, sPlan = fg(p.ok), fg(p.err), fg(p.warn), fg(p.info)
	sAddNum, sDelNum, sCode = fg(p.addFg), fg(p.delFg), fg(p.code)
	sTrack = fg(p.rail)
	sShell = fg(p.shell).Bold(true)
	sSelected = fg(p.ink).Background(c(p.olive))
}

// glyphSet: el rico para terminales modernas, el seguro para la consola
// clásica de Windows (fuentes sin ✦) y ASCII para LIXBON_ASCII=1. Las barras
// son ━ sobre una pista ─: las dos están en Consolas y Cascadia.
type glyphSet struct {
	rail, railHot, corner, sep, arrow, ellipsis, dot, spark, think, edge string
	brand, wait, thinkRail, gap, prompt, meterOn, meterOff, branch       string
	chip, info, todo, doing, done, minus, check, cross, rule             string
	boxTL, boxTR, boxBL, boxBR, boxH, boxV                               string
	turnRail, turnEnd, warn                                              string
	fold, unfold                                                         string
	spin                                                                 []string
	halfBlocks                                                           bool
}

var richGlyphs = glyphSet{
	rail: "│", railHot: "┃", corner: "└", sep: "·", arrow: "→", ellipsis: "…", dot: "●", spark: "✦", think: "✻", edge: "▌",
	brand: "◆", wait: "◌", thinkRail: "┊", gap: "⋯", prompt: "›", meterOn: "━", meterOff: "─", branch: "⎇",
	chip: "⧉", info: "◇", todo: "○", doing: "◔", done: "✓", minus: "−", check: "✓", cross: "✗", rule: "─",
	boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│",
	turnRail: "┃", turnEnd: "┗", warn: "▲", fold: "▸", unfold: "▾",
	spin: []string{"·", "⋄", "◇", "◈", "◆", "✦", "◆", "◈", "◇", "⋄"}, halfBlocks: true,
}

var safeGlyphs = glyphSet{
	rail: "│", railHot: "│", corner: "└", sep: "·", arrow: "→", ellipsis: "…", dot: "●", spark: "•", think: "*", edge: "▌",
	brand: "♦", wait: "○", thinkRail: "│", gap: "…", prompt: "›", meterOn: "━", meterOff: "─", branch: "≡",
	chip: "□", info: "◊", todo: "○", doing: "►", done: "√", minus: "−", check: "√", cross: "×", rule: "─",
	boxTL: "┌", boxTR: "┐", boxBL: "└", boxBR: "┘", boxH: "─", boxV: "│",
	turnRail: "│", turnEnd: "└", warn: "▲", fold: "►", unfold: "▼",
	spin: []string{"·", "•", "●", "•"}, halfBlocks: true,
}

var asciiGlyphs = glyphSet{
	rail: "|", railHot: "|", corner: "\\", sep: "-", arrow: "->", ellipsis: "...", dot: "*", spark: "*", think: "*", edge: "|",
	brand: "*", wait: "o", thinkRail: ":", gap: "...", prompt: ">", meterOn: "=", meterOff: "-", branch: "@",
	chip: "#", info: "i", todo: "-", doing: ">", done: "x", minus: "-", check: "v", cross: "x", rule: "-",
	boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|",
	turnRail: "|", turnEnd: "'", warn: "!", fold: ">", unfold: "v",
	spin: []string{".", "o", "O", "o"},
}

var (
	glyphs                                                                          glyphSet
	glyphRail, glyphRailHot, glyphCorner, glyphSep, glyphArrow, glyphEllipsis       string
	glyphDot, glyphSpark, glyphThink, glyphEdge, glyphBrand, glyphWait              string
	glyphThinkRail, glyphGap, glyphPrompt, glyphMeterOn, glyphMeterOff              string
	glyphBranch, glyphChip, glyphInfo, glyphTodo, glyphDoing, glyphDone, glyphMinus string
	glyphWarn                                                                       string
)

func applyGlyphs(g glyphSet) {
	glyphs = g
	glyphRail, glyphRailHot, glyphCorner, glyphSep, glyphArrow, glyphEllipsis = g.rail, g.railHot, g.corner, g.sep, g.arrow, g.ellipsis
	glyphDot, glyphSpark, glyphThink, glyphEdge, glyphBrand, glyphWait = g.dot, g.spark, g.think, g.edge, g.brand, g.wait
	glyphThinkRail, glyphGap, glyphPrompt, glyphMeterOn, glyphMeterOff = g.thinkRail, g.gap, g.prompt, g.meterOn, g.meterOff
	glyphBranch, glyphChip, glyphInfo, glyphTodo, glyphDoing, glyphDone, glyphMinus = g.branch, g.chip, g.info, g.todo, g.doing, g.done, g.minus
	glyphWarn = g.warn
}

func glyphsFor(getenv func(string) string, goos string) glyphSet {
	switch {
	case getenv("LIXBON_ASCII") == "1":
		return asciiGlyphs
	case goos == "windows" && getenv("WT_SESSION") == "" && getenv("TERM_PROGRAM") == "":
		return safeGlyphs
	}
	return richGlyphs
}

// themeFor decide el tema sin preguntar a la terminal. decided=false deja la
// decisión a la consulta del color de fondo.
func themeFor(getenv func(string) string, configured string) (dark, decided bool) {
	for _, v := range []string{getenv("LIXBON_THEME"), configured} {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "dark", "oscuro":
			return true, true
		case "light", "claro":
			return false, true
		}
	}
	if v := getenv("COLORFGBG"); v != "" {
		parts := strings.Split(v, ";")
		if bg, err := strconv.Atoi(parts[len(parts)-1]); err == nil {
			return bg < 7 || bg == 8, true
		}
	}
	if getenv("TERM") == "dumb" || getenv("INSIDE_EMACS") != "" {
		return true, true
	}
	return true, false
}

// setupAppearance elige tema y glifos al arrancar. Solo se llama con una
// terminal de verdad: la consulta del fondo lee stdin en crudo hasta 2 s.
func setupAppearance(cfg config.Config) {
	applyGlyphs(glyphsFor(os.Getenv, runtime.GOOS))
	dark, decided := themeFor(os.Getenv, cfg.ExtraString("theme"))
	if !decided {
		lipgloss.EnableLegacyWindowsANSI(os.Stdout)
		dark = lipgloss.HasDarkBackground(os.Stdin, os.Stdout)
	}
	applyTheme(paletteFor(dark))
}

func paletteFor(dark bool) palette {
	if dark {
		return darkPalette
	}
	return lightPalette
}
