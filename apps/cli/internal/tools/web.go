package tools

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

const (
	maxFetchChars  = 12000
	maxFetchBytes  = 4 << 20
	fetchTimeout   = 30 * time.Second
	fetchUserAgent = "Mozilla/5.0 (compatible; lixbon-cli/1.0)"
)

var (
	scriptBlocks = func() []*regexp.Regexp {
		var out []*regexp.Regexp
		for _, tag := range []string{"script", "style", "noscript", "svg"} {
			out = append(out, regexp.MustCompile(`(?is)<`+tag+`\b[^>]*>.*?</`+tag+`>`))
		}
		return out
	}()
	blockTags   = regexp.MustCompile(`(?i)</?(p|div|br|li|tr|h[1-6]|section|article|pre|blockquote)\b[^>]*>`)
	anyTag      = regexp.MustCompile(`<[^>]+>`)
	inlineSpace = regexp.MustCompile(`[ \t\r\f\v]+`)
	spaceAround = regexp.MustCompile(` *\n *`)
	manyBreaks  = regexp.MustCompile(`\n{3,}`)
	charsetRe   = regexp.MustCompile(`charset=([\p{L}\p{N}_-]+)`)
)

// htmlToText extrae el texto legible de una página.
func htmlToText(page string) string {
	for _, re := range scriptBlocks {
		page = re.ReplaceAllString(page, " ")
	}
	page = blockTags.ReplaceAllString(page, "\n")
	text := html.UnescapeString(anyTag.ReplaceAllString(page, " "))
	text = inlineSpace.ReplaceAllString(text, " ")
	text = spaceAround.ReplaceAllString(text, "\n")
	return textutil.Strip(manyBreaks.ReplaceAllString(text, "\n\n"))
}

var cp1252High = [32]rune{
	0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
	0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
}

// decodeCharset admite UTF-8 y los juegos de un byte más habituales en la web;
// cualquier otro se lee como UTF-8 con sustitución.
func decodeCharset(raw []byte, charset string) string {
	switch strings.ToLower(charset) {
	case "iso-8859-1", "latin1", "latin-1", "windows-1252", "cp1252":
		var sb strings.Builder
		for _, b := range raw {
			switch {
			case b >= 0x80 && b < 0xA0 && strings.ToLower(charset) != "iso-8859-1":
				sb.WriteRune(cp1252High[b-0x80])
			default:
				sb.WriteRune(rune(b))
			}
		}
		return sb.String()
	}
	return textutil.DecodeLossy(raw)
}

func (tb *Toolbox) fetchURL(ctx context.Context, url string) (string, error) {
	url = textutil.Strip(url)
	if lower := strings.ToLower(url); !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return "[ERROR] La URL debe empezar por http:// o https://", nil
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Sprintf("[ERROR] No se pudo descargar %s: %v", url, err), nil
	}
	req.Header.Set("User-Agent", fetchUserAgent)
	req.Header.Set("Accept", "text/html,application/json,text/plain,*/*")
	client := tb.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", ctx.Err()
		}
		return fmt.Sprintf("[ERROR] No se pudo descargar %s: %v", url, err), nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Sprintf("[ERROR] HTTP %d al descargar %s", resp.StatusCode, url), nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes))
	if err != nil {
		return fmt.Sprintf("[ERROR] No se pudo descargar %s: %v", url, err), nil
	}
	ctype := resp.Header.Get("Content-Type")
	charset := "utf-8"
	if m := charsetRe.FindStringSubmatch(ctype); m != nil {
		charset = m[1]
	}
	text := decodeCharset(raw, charset)
	head := strings.ToLower(textutil.Head(strings.TrimLeftFunc(text, textutil.IsSpace), 15))
	switch {
	case strings.Contains(ctype, "html") || strings.HasPrefix(head, "<!doctype") || strings.HasPrefix(head, "<html"):
		text = htmlToText(text)
	case !containsAny(ctype, "text", "json", "xml", "javascript"):
		kind, _, _ := strings.Cut(ctype, ";")
		if kind == "" {
			kind = "tipo desconocido"
		}
		return fmt.Sprintf("[ERROR] %s no es texto (%s)", url, kind), nil
	}
	if n := utf8.RuneCountInString(text); n > maxFetchChars {
		text = textutil.Head(text, maxFetchChars) + fmt.Sprintf("\n…[recortado: %d caracteres más]", n-maxFetchChars)
	}
	if text == "" {
		return "(la página no tiene texto)", nil
	}
	return text, nil
}

func containsAny(s string, parts ...string) bool {
	for _, p := range parts {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

var snippetSpace = regexp.MustCompile(`\s+`)

func (tb *Toolbox) webSearch(ctx context.Context, query string, limitArg int) (string, error) {
	if tb.Web == nil {
		return "[ERROR] La búsqueda web no está disponible en esta sesión", nil
	}
	query = textutil.Strip(query)
	if query == "" {
		return "[ERROR] Falta query", nil
	}
	limit := 5
	if limitArg != 0 {
		limit = limitArg
	}
	results, err := tb.Web.WebSearch(ctx, query, max(1, min(limit, 10)))
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return fmt.Sprintf("[ERROR] Búsqueda web fallida: %v", err), nil
	}
	if len(results) == 0 {
		return "(sin resultados)", nil
	}
	parts := make([]string, len(results))
	for i, r := range results {
		title := pyStr(r["title"])
		if title == "" {
			title = "(sin título)"
		}
		snippet := textutil.Head(textutil.Strip(snippetSpace.ReplaceAllString(pyStr(r["snippet"]), " ")), 1500)
		parts[i] = fmt.Sprintf("%d. %s\n   %s\n   %s", i+1, title, pyStr(r["url"]), snippet)
	}
	return strings.Join(parts, "\n\n"), nil
}
