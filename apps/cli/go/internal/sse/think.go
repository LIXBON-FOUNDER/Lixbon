package sse

import "strings"

const (
	thinkOpen  = "<think>"
	thinkClose = "</think>"
)

// ThinkFilter reclasifica como razonamiento el texto entre <think> y </think>.
// Las etiquetas pueden llegar partidas entre chunks: la cola que podría ser el
// inicio de una etiqueta se retiene hasta poder decidir.
type ThinkFilter struct {
	inside bool
	buffer string
}

func (f *ThinkFilter) tag() string {
	if f.inside {
		return thinkClose
	}
	return thinkOpen
}

func (f *ThinkFilter) kind() Kind {
	if f.inside {
		return Reasoning
	}
	return Content
}

func partialTail(text, tag string) int {
	for size := min(len(text), len(tag)-1); size > 0; size-- {
		if strings.HasSuffix(text, tag[:size]) {
			return size
		}
	}
	return 0
}

func (f *ThinkFilter) Feed(text string) []Event {
	f.buffer += text
	var out []Event
	for {
		tag := f.tag()
		pos := strings.Index(f.buffer, tag)
		if pos == -1 {
			keep := partialTail(f.buffer, tag)
			emit := f.buffer[:len(f.buffer)-keep]
			f.buffer = f.buffer[len(f.buffer)-keep:]
			if emit != "" {
				out = append(out, Event{Kind: f.kind(), Text: emit})
			}
			return out
		}
		if pos > 0 {
			out = append(out, Event{Kind: f.kind(), Text: f.buffer[:pos]})
		}
		f.buffer = f.buffer[pos+len(tag):]
		f.inside = !f.inside
	}
}

func (f *ThinkFilter) Flush() []Event {
	emit := f.buffer
	f.buffer = ""
	if emit == "" {
		return nil
	}
	return []Event{{Kind: f.kind(), Text: emit}}
}
