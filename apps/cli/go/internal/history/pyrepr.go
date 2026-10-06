package history

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

// reprLen devuelve len(str(valor)) tal como lo calcula Python para el valor
// JSON equivalente. El estimador de tokens se calibra contra esa medida, así
// que conservarla mantiene las mismas decisiones de poda que el CLI Python.
func reprLen(v any) int {
	switch x := v.(type) {
	case nil:
		return 4 // None
	case bool:
		if x {
			return 4
		}
		return 5
	case json.Number:
		return len(numberRepr(x))
	case float64:
		return len(floatRepr(x))
	case string:
		return strReprLen(x)
	case []any:
		return seqLen(len(x), func(i int) int { return reprLen(x[i]) })
	case []map[string]any:
		return seqLen(len(x), func(i int) int { return reprLen(x[i]) })
	case map[string]any:
		n := 2
		first := true
		for k, val := range x {
			if !first {
				n += 2
			}
			first = false
			n += strReprLen(k) + 2 + reprLen(val)
		}
		return n
	}
	return len(fmt.Sprint(v))
}

func seqLen(n int, item func(int) int) int {
	total := 2
	for i := 0; i < n; i++ {
		if i > 0 {
			total += 2
		}
		total += item(i)
	}
	return total
}

func strReprLen(s string) int {
	quote := '\''
	if strings.ContainsRune(s, '\'') && !strings.ContainsRune(s, '"') {
		quote = '"'
	}
	n := 2
	for _, r := range s {
		switch {
		case r == '\\', r == quote, r == '\n', r == '\r', r == '\t':
			n += 2
		case r < 0x20 || r == 0x7f:
			n += 4
		case r < 0x7f:
			n++
		case unicode.IsPrint(r):
			n++
		case r <= 0xff:
			n += 4
		case r <= 0xffff:
			n += 6
		default:
			n += 10
		}
	}
	return n
}

func numberRepr(n json.Number) string {
	text := n.String()
	if !strings.ContainsAny(text, ".eE") {
		if text == "-0" {
			return "0"
		}
		return text
	}
	f, err := n.Float64()
	if err != nil {
		return text
	}
	return floatRepr(f)
}

// floatRepr replica repr(float): notación decimal para exponentes entre -4 y
// 15 y científica fuera de ese rango.
func floatRepr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "nan"
	case math.IsInf(f, 1):
		return "inf"
	case math.IsInf(f, -1):
		return "-inf"
	}
	sci := strconv.FormatFloat(f, 'e', -1, 64)
	sign := ""
	if strings.HasPrefix(sci, "-") {
		sign, sci = "-", sci[1:]
	}
	mantissa, expText, _ := strings.Cut(sci, "e")
	exp, _ := strconv.Atoi(expText)
	digits := strings.Replace(mantissa, ".", "", 1)
	if exp < -4 || exp >= 16 {
		out := digits[:1]
		if len(digits) > 1 {
			out += "." + digits[1:]
		}
		expSign := "+"
		if exp < 0 {
			expSign, exp = "-", -exp
		}
		return sign + out + "e" + expSign + leftPad(strconv.Itoa(exp), 2)
	}
	if exp >= 0 {
		if len(digits) <= exp+1 {
			return sign + digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
		}
		return sign + digits[:exp+1] + "." + digits[exp+1:]
	}
	return sign + "0." + strings.Repeat("0", -exp-1) + digits
}

func leftPad(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return strings.Repeat("0", width-len(s)) + s
}

func decodeJSON(raw []byte) any {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return nil
	}
	return v
}
