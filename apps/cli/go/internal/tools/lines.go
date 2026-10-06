package tools

import (
	"bufio"
	"io"

	"lixbon.com/cli/internal/textutil"
)

// lineReader recorre un archivo sin cargarlo entero. Una línea más larga que
// maxLine se recorta y se marca; el resto del texto se descarta.
//
// Con universal=false imita str.splitlines() de Python (que parte también en
// \v, \f, \x1c-\x1e, U+0085, U+2028 y U+2029); con universal=true imita
// read_text().split("\n"): solo \n, \r\n y \r separan, y siempre hay un último
// segmento, aunque sea vacío.
type lineReader struct {
	br        *bufio.Reader
	maxLine   int
	universal bool
	done      bool
	err       error
}

func newLineReader(r io.Reader, maxLine int, universal bool) *lineReader {
	return &lineReader{br: bufio.NewReaderSize(r, 64<<10), maxLine: maxLine, universal: universal}
}

func (l *lineReader) next() (line string, truncated, ok bool) {
	if l.done {
		return "", false, false
	}
	var buf []byte
	started := false
	finish := func() (string, bool, bool) {
		return textutil.DecodeLossy(buf), truncated, true
	}
	for {
		b, err := l.br.ReadByte()
		if err != nil {
			l.done = true
			if err != io.EOF {
				l.err = err
			}
			if started || l.universal {
				return finish()
			}
			return "", false, false
		}
		started = true
		switch b {
		case '\n':
			return finish()
		case '\r':
			if peek, err := l.br.Peek(1); err == nil && peek[0] == '\n' {
				_, _ = l.br.Discard(1)
			}
			return finish()
		case '\v', '\f', 0x1c, 0x1d, 0x1e:
			if !l.universal {
				return finish()
			}
		case 0xC2:
			if peek, err := l.br.Peek(1); !l.universal && err == nil && peek[0] == 0x85 {
				_, _ = l.br.Discard(1)
				return finish()
			}
		case 0xE2:
			if peek, err := l.br.Peek(2); !l.universal && err == nil && peek[0] == 0x80 && (peek[1] == 0xA8 || peek[1] == 0xA9) {
				_, _ = l.br.Discard(2)
				return finish()
			}
		}
		if len(buf) < l.maxLine {
			buf = append(buf, b)
		} else {
			truncated = true
		}
	}
}
