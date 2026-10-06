// Package toolparse extrae llamadas a herramientas embebidas en el texto del
// modelo (protocolo de texto) y limpia la prosa. Contrato fijado por
// validation/fixtures/tool_parse_corpus.json.
//
// Las posiciones son índices de byte: los delimitadores son ASCII, así que el
// resultado coincide con los índices de carácter del código Python.
package toolparse

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolspec"
)

type Call struct {
	Tool string
	Args map[string]any
}

// ws replica \s de Python para str: espacios Unicode, \x1c-\x1f y \x85.
const ws = `[\t-\r\x{1c}-\x{1f}\x{85}\p{Z}]`

var (
	toolStart       = regexp.MustCompile(`\{` + ws + `*"(tool|name)"`)
	repairHead      = regexp.MustCompile(`^\{` + ws + `*"tool"` + ws + `*:` + ws + `*"([^"]*)"` + ws + `*,` + ws + `*"args"` + ws + `*:` + ws + `*\{`)
	repairKey       = regexp.MustCompile(`^"([a-zA-Z_]+)"` + ws + `*:` + ws + `*`)
	repairPrimitive = regexp.MustCompile(`^(true|false|null|-?[0-9]+(?:\.[0-9]+)?)`)
	basicEscape     = regexp.MustCompile(`\\(["\\/nrt])`)
	emptyFence      = regexp.MustCompile("```[\\p{L}\\p{N}_-]*" + ws + "*```")
)

const repairHeadWindow = 200

// Native convierte un tool_call nativo (arguments como string u objeto).
func Native(call map[string]any) Call {
	fn, _ := call["function"].(map[string]any)
	name, _ := fn["name"].(string)
	out := Call{Tool: name, Args: map[string]any{}}
	switch args := fn["arguments"].(type) {
	case string:
		if args == "" {
			args = "{}"
		}
		var parsed map[string]any
		if json.Unmarshal([]byte(args), &parsed) == nil && parsed != nil {
			out.Args = parsed
		}
	case map[string]any:
		out.Args = args
	}
	return out
}

func validate(value any) *Call {
	data, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	if tool, _ := data["tool"].(string); tool != "" {
		args, _ := data["args"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		return &Call{Tool: tool, Args: args}
	}
	name, _ := data["name"].(string)
	raw, present := data["arguments"]
	if name == "" || !present || raw == nil {
		return nil
	}
	call := Call{Tool: name, Args: map[string]any{}}
	switch args := raw.(type) {
	case string:
		var parsed map[string]any
		if json.Unmarshal([]byte(args), &parsed) == nil && parsed != nil {
			call.Args = parsed
		}
	case map[string]any:
		call.Args = args
	}
	return &call
}

// scanObject devuelve el fin exclusivo del objeto que empieza en start, o -1.
// Reconoce strings con comilla doble y simple.
func scanObject(text string, start int) int {
	depth := 0
	var quote byte
	escapeNext := false
	for j := start; j < len(text); j++ {
		ch := text[j]
		switch {
		case escapeNext:
			escapeNext = false
		case quote != 0:
			if ch == '\\' {
				escapeNext = true
			} else if ch == quote {
				quote = 0
			}
		case ch == '"' || ch == '\'':
			quote = ch
		case ch == '{':
			depth++
		case ch == '}':
			depth--
			if depth == 0 {
				return j + 1
			}
		}
	}
	return -1
}

// quotesToJSON reescribe los strings con comilla simple como strings JSON.
func quotesToJSON(text string) string {
	var out strings.Builder
	n := len(text)
	for i := 0; i < n; {
		switch ch := text[i]; ch {
		case '"':
			j := i + 1
			for j < n {
				if text[j] == '\\' {
					j += 2
					continue
				}
				if text[j] == '"' {
					break
				}
				j++
			}
			out.WriteString(text[i:min(j+1, n)])
			i = j + 1
		case '\'':
			out.WriteByte('"')
			j := i + 1
			for j < n {
				c := text[j]
				if c == '\\' {
					if j+1 < n && text[j+1] == '\'' {
						out.WriteString(`\"`)
					} else {
						out.WriteString(text[j:min(j+2, n)])
					}
					j += 2
					continue
				}
				if c == '\'' {
					break
				}
				switch c {
				case '"':
					out.WriteString(`\"`)
				case '\n':
					out.WriteString(`\n`)
				case '\r':
					out.WriteString(`\r`)
				case '\t':
					out.WriteString(`\t`)
				default:
					out.WriteByte(c)
				}
				j++
			}
			out.WriteByte('"')
			i = j + 1
		default:
			out.WriteByte(ch)
			i++
		}
	}
	return out.String()
}

// escapeControlChars equivale a json.loads(strict=False): admite caracteres
// de control sin escapar dentro de strings.
func escapeControlChars(text string) string {
	var out strings.Builder
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case escaped:
			escaped = false
			out.WriteByte(c)
		case inString && c == '\\':
			escaped = true
			out.WriteByte(c)
		case c == '"':
			inString = !inString
			out.WriteByte(c)
		case inString && c < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte("0123456789abcdef"[c>>4])
			out.WriteByte("0123456789abcdef"[c&0xf])
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

func loadsNonStrict(text string) (any, error) {
	var value any
	err := json.Unmarshal([]byte(escapeControlChars(text)), &value)
	return value, err
}

func loadsLenient(text string) (any, error) {
	if value, err := loadsNonStrict(text); err == nil {
		return value, nil
	}
	return loadsNonStrict(quotesToJSON(text))
}

func unescapeBasic(s string) string {
	return basicEscape.ReplaceAllStringFunc(s, func(m string) string {
		switch m[1] {
		case 'n':
			return "\n"
		case 'r':
			return "\r"
		case 't':
			return "\t"
		}
		return m[1:]
	})
}

func headWindow(text string, start int) string {
	end := start
	for count := 0; count < repairHeadWindow && end < len(text); count++ {
		_, size := utf8.DecodeRuneInString(text[end:])
		end += size
	}
	return text[start:end]
}

// repairBySchema repara {"tool":..,"args":{..}} campo a campo cuando el valor
// largo trae comillas sin escapar; el delimitador de cada campo es el nombre
// literal de otra clave de la misma herramienta o el cierre del objeto.
func repairBySchema(text string, start int) (*Call, int, bool) {
	head := repairHead.FindStringSubmatch(headWindow(text, start))
	if head == nil {
		return nil, 0, false
	}
	tool := head[1]
	keys := toolspec.ArgKeys(tool)
	if len(keys) == 0 {
		return nil, 0, false
	}
	i := start + len(head[0])
	args := map[string]any{}
	remaining := slices.Clone(keys)
	n := len(text)
	for {
		for i < n && strings.IndexByte(" \t\r\n,", text[i]) >= 0 {
			i++
		}
		if i < n && text[i] == '}' {
			i++
			break
		}
		keyMatch := repairKey.FindStringSubmatch(text[i:])
		if keyMatch == nil {
			return nil, 0, false
		}
		key := keyMatch[1]
		idx := slices.Index(remaining, key)
		if idx < 0 {
			return nil, 0, false
		}
		i += len(keyMatch[0])
		remaining = slices.Delete(remaining, idx, idx+1)
		if i < n && text[i] == '"' {
			i++
			stop := stopPattern(remaining)
			loc := stop.FindStringIndex(text[i:])
			if loc == nil {
				return nil, 0, false
			}
			args[key] = unescapeBasic(text[i : i+loc[0]])
			i += loc[0] + 1
			continue
		}
		prim := repairPrimitive.FindString(text[i:])
		if prim == "" {
			return nil, 0, false
		}
		var value any
		if json.Unmarshal([]byte(prim), &value) != nil {
			return nil, 0, false
		}
		args[key] = value
		i += len(prim)
	}
	for i < n && strings.IndexByte(" \t\r\n", text[i]) >= 0 {
		i++
	}
	if i >= n || text[i] != '}' {
		return nil, 0, false
	}
	return &Call{Tool: tool, Args: args}, i + 1, true
}

func stopPattern(otherKeys []string) *regexp.Regexp {
	if len(otherKeys) == 0 {
		return regexp.MustCompile(`"` + ws + `*\}`)
	}
	quoted := make([]string, len(otherKeys))
	for i, k := range otherKeys {
		quoted[i] = regexp.QuoteMeta(k)
	}
	return regexp.MustCompile(`"` + ws + `*,` + ws + `*"(?:` + strings.Join(quoted, "|") + `)"` + ws + `*:|"` + ws + `*\}`)
}

// findCallEnd devuelve la llamada (nil si el JSON no se pudo interpretar) y su
// fin exclusivo; ok=false si el objeto sigue abierto.
func findCallEnd(text string, start int) (call *Call, end int, ok bool) {
	if call, end, ok := repairBySchema(text, start); ok {
		return call, end, true
	}
	end = scanObject(text, start)
	if end == -1 {
		return nil, 0, false
	}
	value, err := loadsLenient(text[start:end])
	if err != nil {
		return nil, end, true
	}
	return validate(value), end, true
}

type span struct {
	call       *Call
	start, end int
}

func spans(text string) []span {
	var out []span
	for i := 0; i < len(text); {
		loc := toolStart.FindStringIndex(text[i:])
		if loc == nil {
			break
		}
		start := i + loc[0]
		call, end, ok := findCallEnd(text, start)
		if !ok {
			break
		}
		out = append(out, span{call, start, end})
		i = end
	}
	return out
}

func ExtractAll(text string) []Call {
	calls := []Call{}
	for _, s := range spans(text) {
		if s.call != nil {
			calls = append(calls, *s.call)
		}
	}
	return calls
}

func HasInvalidCall(text string) bool {
	return slices.ContainsFunc(spans(text), func(s span) bool { return s.call == nil })
}

func Strip(text string) string {
	all := spans(text)
	for i := len(all) - 1; i >= 0; i-- {
		text = text[:all[i].start] + text[all[i].end:]
	}
	return text
}

func TruncateFabricated(text string) string {
	idx := strings.Index(text, "TOOL_RESULT")
	if idx == -1 {
		return text
	}
	if lineStart := strings.LastIndex(text[:idx], "\n"); lineStart != -1 {
		return text[:lineStart]
	}
	return text[:idx]
}

func CutUnclosed(text string) string {
	matches := toolStart.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	last := matches[len(matches)-1][0]
	if _, _, ok := findCallEnd(text, last); ok {
		return text
	}
	return text[:last]
}

func HasUnclosed(text string) bool { return len(CutUnclosed(text)) < len(text) }

// CleanProse devuelve la prosa mostrable: sin llamadas (completas o
// truncadas), sin TOOL_RESULT fabricados y sin vallas de código vacías.
func CleanProse(text string) string {
	text = CutUnclosed(Strip(TruncateFabricated(text)))
	text = emptyFence.ReplaceAllString(text, "")
	return textutil.Strip(text)
}
