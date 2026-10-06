// Package sse lee el stream SSE del gateway y lo convierte en los eventos
// tipados del CLI. Contrato fijado por validation/fixtures/sse_corpus.json.
package sse

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"iter"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

type Kind string

const (
	Sources   Kind = "sources"
	Reasoning Kind = "reasoning"
	Content   Kind = "content"
	ToolCalls Kind = "tool_calls"
	Usage     Kind = "usage"
	Done      Kind = "done"
)

// Event lleva Text para reasoning/content y Value (JSON crudo) para
// sources/tool_calls/usage.
type Event struct {
	Kind  Kind
	Text  string
	Value json.RawMessage
}

const maxLineBytes = 8 << 20

var ErrLineTooLong = errors.New("línea SSE demasiado larga")

type chunk struct {
	Sources json.RawMessage `json:"lixbon_sources"`
	Choices []struct {
		Delta *struct {
			ReasoningContent string          `json:"reasoning_content"`
			ToolCalls        json.RawMessage `json:"tool_calls"`
			Content          string          `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Usage json.RawMessage `json:"usage"`
}

// Events itera los eventos de r hasta [DONE] o EOF y cierra con Done. Un error
// de lectura (incluida la cancelación del contexto de la petición) se entrega
// como último elemento, sin Done.
func Events(r io.Reader) iter.Seq2[Event, error] {
	return func(yield func(Event, error) bool) {
		var filter ThinkFilter
		br := bufio.NewReaderSize(r, 64<<10)
		for {
			line, err := readLine(br)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				yield(Event{}, err)
				return
			}
			payload, ok := dataPayload(line)
			if !ok {
				continue
			}
			if payload == "[DONE]" {
				break
			}
			var c chunk
			if json.Unmarshal([]byte(payload), &c) != nil {
				continue
			}
			for _, ev := range classify(&c, &filter) {
				if !yield(ev, nil) {
					return
				}
			}
		}
		for _, ev := range filter.Flush() {
			if !yield(ev, nil) {
				return
			}
		}
		yield(Event{Kind: Done}, nil)
	}
}

func classify(c *chunk, filter *ThinkFilter) []Event {
	if c.Sources != nil {
		return []Event{{Kind: Sources, Value: c.Sources}}
	}
	var out []Event
	if len(c.Choices) > 0 && c.Choices[0].Delta != nil {
		d := c.Choices[0].Delta
		if d.ReasoningContent != "" {
			out = append(out, Event{Kind: Reasoning, Text: d.ReasoningContent})
		}
		if truthy(d.ToolCalls) {
			out = append(out, Event{Kind: ToolCalls, Value: d.ToolCalls})
		}
		if d.Content != "" {
			out = append(out, filter.Feed(d.Content)...)
		}
	}
	if truthy(c.Usage) {
		out = append(out, Event{Kind: Usage, Value: c.Usage})
	}
	return out
}

func truthy(raw json.RawMessage) bool {
	switch string(bytes.TrimSpace(raw)) {
	case "", "null", "false", "0", `""`, "[]", "{}":
		return false
	}
	return true
}

func dataPayload(line []byte) (string, bool) {
	text := strings.TrimSpace(textutil.DecodeLossy(line))
	rest, ok := strings.CutPrefix(text, "data:")
	if !ok {
		return "", false
	}
	return strings.TrimSpace(rest), true
}

func readLine(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := br.ReadSlice('\n')
		line = append(line, part...)
		if len(line) > maxLineBytes {
			return nil, ErrLineTooLong
		}
		switch {
		case err == nil:
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) > 0:
			return line, nil
		default:
			return nil, err
		}
	}
}
