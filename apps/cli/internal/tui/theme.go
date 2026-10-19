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

// palette son los tokens de lixbon.com. El acento es solo para estado.
type palette struct {
	dark bool

	bg, ink, body, soft, muted, faint, rule, surf, surf2 string
	acc, accDeep, olive, ivory, sand                     string
	ok, warn, err, info, code                            string
	addBg, addFg, delBg, delFg                           string
	kw, str, fn, ty, num, com                            string
	f1, f2, f3, f4, spark, dot                           string
	// shimmer: base, medio y pico del brillo que recorre la etiqueta viva.
	shBase, shMid, shHigh string
	// chipLive es el fondo de la etiqueta de una herramienta en marcha.
	chipLive string
}

var darkPalette = palette{
	dark: true,
	bg:   "#0E0E0E", ink: "#F2F2F0", body: "#D6D6D3", soft: "#B0B0AD", muted: "#7C7C79", faint: "#5E5E5C",
	rule: "#2A2A2A", surf: "#1C1C1C", surf2: "#262626",
	acc: "#B4C64E", accDeep: "#8CA038", olive: "#66733A", ivory: "#DCD6BC", sand: "#C7BE9F",
	ok: "#86D694", warn: "#E8C872", err: "#F08C7C", info: "#8EC5FF", code: "#CBD69B",
	addBg: "#0D3A17", addFg: "#7EE08F", delBg: "#4A1214", delFg: "#FF9C92",
	kw: "#E59AD6", str: "#F2C98A", fn: "#8EC5FF", ty: "#C3B4FF", num: "#F5D98A", com: "#6A6A65",
	f1: "#DCD6BC", f2: "#C7BE9F", f3: "#4B5327", f4: "#333A1C", spark: "#FCFAEF", dot: "#FCFAEF",
	shBase: "#9E9681", shMid: "#D8CFAD", shHigh: "#FCFAEF", chipLive: "#2A2F18",
}

var lightPalette = palette{
	bg: "#F5F4EE", ink: "#191917", body: "#2E2E2B", soft: "#5B5B55", muted: "#8A8A82", faint: "#9A9A92",
	rule: "#DEDCD2", surf: "#ECEAE1", surf2: "#E3E1D7",
	acc: "#7E9430", accDeep: "#6A7D28", olive: "#A3B068", ivory: "#4B5327", sand: "#6A6346",
	ok: "#5E8A32", warn: "#A8842A", err: "#B8462F", info: "#2B63A6", code: "#4F6320",
	addBg: "#CDEFC4", addFg: "#1F6B1A", delBg: "#FAC9C4", delFg: "#9E1F14",
	kw: "#9B3D86", str: "#8A5A12", fn: "#2B63A6", ty: "#6046B0", num: "#7A6210", com: "#A3A39B",
	f1: "#BDB38E", f2: "#A89D76", f3: "#4B5327", f4: "#333A1C", spark: "#FCFAEF", dot: "#4B5327",
	shBase: "#8A8574", shMid: "#5E594B", shHigh: "#1B1A17", chipLive: "#DCE5C4",
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
	sAddNum, sDelNum, sInk, sSoft, sCode, sSelected, sTrack                lipgloss.Style
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
	sTrack = fg(p.rule)
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
	turnRail, turnEnd                                                    string
	fold, unfold                                                         string
	spin                                                                 []string
	halfBlocks                                                           bool
}

var richGlyphs = glyphSet{
	rail: "│", railHot: "┃", corner: "└", sep: "·", arrow: "→", ellipsis: "…", dot: "●", spark: "✦", think: "✻", edge: "▌",
	brand: "◆", wait: "◌", thinkRail: "┊", gap: "⋯", prompt: "›", meterOn: "━", meterOff: "─", branch: "⎇",
	chip: "⧉", info: "◇", todo: "○", doing: "▸", done: "✓", minus: "−", check: "✓", cross: "✗", rule: "─",
	boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│",
	turnRail: "┃", turnEnd: "┗", fold: "▸", unfold: "▾",
	spin: []string{"·", "⋄", "◇", "◈", "◆", "✦", "◆", "◈", "◇", "⋄"}, halfBlocks: true,
}

var safeGlyphs = glyphSet{
	rail: "│", railHot: "│", corner: "└", sep: "·", arrow: "→", ellipsis: "…", dot: "●", spark: "•", think: "*", edge: "▌",
	brand: "♦", wait: "○", thinkRail: "│", gap: "…", prompt: "›", meterOn: "━", meterOff: "─", branch: "≡",
	chip: "□", info: "◊", todo: "○", doing: "►", done: "√", minus: "−", check: "√", cross: "×", rule: "─",
	boxTL: "┌", boxTR: "┐", boxBL: "└", boxBR: "┘", boxH: "─", boxV: "│",
	turnRail: "│", turnEnd: "└", fold: "►", unfold: "▼",
	spin: []string{"·", "•", "●", "•"}, halfBlocks: true,
}

var asciiGlyphs = glyphSet{
	rail: "|", railHot: "|", corner: "\\", sep: "-", arrow: "->", ellipsis: "...", dot: "*", spark: "*", think: "*", edge: "|",
	brand: "*", wait: "o", thinkRail: ":", gap: "...", prompt: ">", meterOn: "=", meterOff: "-", branch: "@",
	chip: "#", info: "i", todo: "-", doing: ">", done: "x", minus: "-", check: "v", cross: "x", rule: "-",
	boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|",
	turnRail: "|", turnEnd: "'", fold: ">", unfold: "v",
	spin: []string{".", "o", "O", "o"},
}

var (
	glyphs                                                                          glyphSet
	glyphRail, glyphRailHot, glyphCorner, glyphSep, glyphArrow, glyphEllipsis       string
	glyphDot, glyphSpark, glyphThink, glyphEdge, glyphBrand, glyphWait              string
	glyphThinkRail, glyphGap, glyphPrompt, glyphMeterOn, glyphMeterOff              string
	glyphBranch, glyphChip, glyphInfo, glyphTodo, glyphDoing, glyphDone, glyphMinus string
)

func applyGlyphs(g glyphSet) {
	glyphs = g
	glyphRail, glyphRailHot, glyphCorner, glyphSep, glyphArrow, glyphEllipsis = g.rail, g.railHot, g.corner, g.sep, g.arrow, g.ellipsis
	glyphDot, glyphSpark, glyphThink, glyphEdge, glyphBrand, glyphWait = g.dot, g.spark, g.think, g.edge, g.brand, g.wait
	glyphThinkRail, glyphGap, glyphPrompt, glyphMeterOn, glyphMeterOff = g.thinkRail, g.gap, g.prompt, g.meterOn, g.meterOff
	glyphBranch, glyphChip, glyphInfo, glyphTodo, glyphDoing, glyphDone, glyphMinus = g.branch, g.chip, g.info, g.todo, g.doing, g.done, g.minus
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
