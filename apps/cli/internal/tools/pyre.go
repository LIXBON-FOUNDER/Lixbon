package tools

import (
	"regexp"
	"runtime"
	"strings"
)

const (
	wordInner  = `\p{L}\p{N}_`
	spaceInner = `\t-\r\x{1c}-\x{1f}\x{85}\p{Z}`
	digitInner = `\p{Nd}`
)

// translatePy adapta una expresión regular de Python (clases Unicode para \w,
// \s y \d) a la sintaxis de RE2.
func translatePy(pattern string) string {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		if c == '\\' && i+1 < len(pattern) {
			i++
			n := pattern[i]
			inner := map[byte]string{'w': wordInner, 's': spaceInner, 'd': digitInner}
			negated := map[byte]string{'W': wordInner, 'S': spaceInner, 'D': digitInner}
			switch {
			case inner[n] != "":
				if inClass {
					b.WriteString(inner[n])
				} else {
					b.WriteString("[" + inner[n] + "]")
				}
			case negated[n] != "" && !inClass:
				b.WriteString("[^" + negated[n] + "]")
			default:
				b.WriteByte('\\')
				b.WriteByte(n)
			}
			continue
		}
		switch {
		case c == '[' && !inClass:
			inClass = true
		case c == ']' && inClass:
			inClass = false
		}
		b.WriteByte(c)
	}
	return b.String()
}

// matchStart equivale a re.match: ancla el patrón al inicio de la línea.
func matchStart(pattern string) *regexp.Regexp {
	return regexp.MustCompile(`\A(?:` + translatePy(pattern) + `)`)
}

// foldCase: pathlib y fnmatch comparan sin distinguir mayúsculas en Windows.
var foldCase = runtime.GOOS == "windows"

// translateFnmatch porta fnmatch.translate de Python a RE2.
func translateFnmatch(pattern string) *regexp.Regexp {
	runes := []rune(pattern)
	var b strings.Builder
	for i, n := 0, len(runes); i < n; {
		c := runes[i]
		i++
		switch c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		case '[':
			j := i
			if j < n && runes[j] == '!' {
				j++
			}
			if j < n && runes[j] == ']' {
				j++
			}
			for j < n && runes[j] != ']' {
				j++
			}
			if j >= n {
				b.WriteString(`\[`)
				continue
			}
			stuff := string(runes[i:j])
			i = j + 1
			stuff = strings.NewReplacer(`\`, `\\`, `[`, `\[`).Replace(stuff)
			switch {
			case stuff == "":
				b.WriteString("(?:$^)")
				continue
			case stuff[0] == '!':
				stuff = "^" + stuff[1:]
			case stuff[0] == '^':
				stuff = `\` + stuff
			}
			b.WriteString("[" + stuff + "]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	prefix := `(?s)\A`
	if foldCase {
		prefix = `(?is)\A`
	}
	return regexp.MustCompile(prefix + b.String() + `\z`)
}
