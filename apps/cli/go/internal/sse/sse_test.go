package sse

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

type corpusCase struct {
	Name      string              `json:"name"`
	Stream    string              `json:"stream"`
	StreamB64 string              `json:"stream_b64"`
	Events    [][]json.RawMessage `json:"events"`
}

func loadCorpus(t *testing.T) []corpusCase {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/sse_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Cases []corpusCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("corpus vacío")
	}
	return corpus.Cases
}

func (c corpusCase) bytes(t *testing.T) []byte {
	if c.StreamB64 == "" {
		return []byte(c.Stream)
	}
	b, err := base64.StdEncoding.DecodeString(c.StreamB64)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func normalize(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func collect(t *testing.T, r io.Reader) [][2]any {
	t.Helper()
	var got [][2]any
	for ev, err := range Events(r) {
		if err != nil {
			t.Fatalf("error de lectura: %v", err)
		}
		var value any
		switch ev.Kind {
		case Reasoning, Content:
			value = ev.Text
		case Sources, ToolCalls, Usage:
			value = normalize(t, ev.Value)
		}
		got = append(got, [2]any{string(ev.Kind), value})
	}
	return got
}

func expected(t *testing.T, c corpusCase) [][2]any {
	var want [][2]any
	for _, pair := range c.Events {
		want = append(want, [2]any{normalize(t, pair[0]), normalize(t, pair[1])})
	}
	return want
}

func TestCorpus(t *testing.T) {
	readers := map[string]func(b []byte) io.Reader{
		"completo": func(b []byte) io.Reader { return bytes.NewReader(b) },
		"un_byte":  func(b []byte) io.Reader { return iotest.OneByteReader(bytes.NewReader(b)) },
		"mitad":    func(b []byte) io.Reader { return iotest.HalfReader(bytes.NewReader(b)) },
		"data_err": func(b []byte) io.Reader { return iotest.DataErrReader(bytes.NewReader(b)) },
	}
	for _, c := range loadCorpus(t) {
		for name, mk := range readers {
			t.Run(c.Name+"/"+name, func(t *testing.T) {
				got := collect(t, mk(c.bytes(t)))
				if want := expected(t, c); !reflect.DeepEqual(got, want) {
					t.Fatalf("eventos distintos\n got: %v\nwant: %v", got, want)
				}
			})
		}
	}
}

func TestReasoningFieldFromOpenRouterAndKilo(t *testing.T) {
	stream := `data: {"choices":[{"delta":{"reasoning":"pienso"}}]}` + "\n\n" +
		`data: {"choices":[{"delta":{"reasoning_content":"también","reasoning":"ignorado"}}]}` + "\n\n" +
		`data: {"choices":[{"delta":{"content":"391"}}]}` + "\n\n" +
		"data: [DONE]\n\n"
	want := [][2]any{
		{"reasoning", "pienso"}, {"reasoning", "también"}, {"content", "391"}, {"done", nil},
	}
	if got := collect(t, strings.NewReader(stream)); !reflect.DeepEqual(got, want) {
		t.Fatalf("eventos distintos\n got: %v\nwant: %v", got, want)
	}
}

func TestLineTooLong(t *testing.T) {
	stream := "data: " + strings.Repeat("x", maxLineBytes+1)
	for _, err := range Events(strings.NewReader(stream)) {
		if !errors.Is(err, ErrLineTooLong) {
			t.Fatalf("esperaba ErrLineTooLong, obtuve %v", err)
		}
		return
	}
	t.Fatal("no hubo error")
}

func TestReadErrorHasNoDone(t *testing.T) {
	boom := errors.New("corte de red")
	r := io.MultiReader(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n"), iotest.ErrReader(boom))
	var kinds []Kind
	var last error
	for ev, err := range Events(r) {
		if err != nil {
			last = err
			continue
		}
		kinds = append(kinds, ev.Kind)
	}
	if !errors.Is(last, boom) || len(kinds) != 1 || kinds[0] != Content {
		t.Fatalf("kinds=%v err=%v", kinds, last)
	}
}

func TestEarlyBreakStopsReading(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	go pw.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n"))
	for ev := range Events(pr) {
		if ev.Kind == Content {
			break
		}
	}
}

func TestSilentStreamCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	go func() {
		<-ctx.Done()
		pw.CloseWithError(ctx.Err())
	}()
	done := make(chan error, 1)
	go func() {
		for _, err := range Events(pr) {
			if err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	time.AfterFunc(50*time.Millisecond, cancel)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error inesperado: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("la lectura no terminó tras cancelar")
	}
}
