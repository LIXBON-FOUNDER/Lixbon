package history

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"lixbon.com/cli/internal/toolspec"
)

type corpus struct {
	History struct {
		Clip []struct {
			Name   string `json:"name"`
			Text   string `json:"text"`
			Limit  *int   `json:"limit"`
			Output string `json:"output"`
		} `json:"clip"`
		Shrink []struct {
			Name       string    `json:"name"`
			Messages   []Message `json:"messages"`
			KeepRecent int       `json:"keep_recent"`
			Limit      *int      `json:"limit"`
			Output     []Message `json:"output"`
		} `json:"shrink"`
		Estimate []struct {
			Name         string    `json:"name"`
			Messages     []Message `json:"messages"`
			Calibrated   *float64  `json:"calibrated"`
			PayloadChars int       `json:"payload_chars"`
			Tokens       int       `json:"tokens"`
			Images       int       `json:"images"`
		} `json:"estimate"`
		PayloadWithTools []struct {
			Name     string    `json:"name"`
			Messages []Message `json:"messages"`
			Tools    string    `json:"tools"`
			Chars    int       `json:"chars"`
		} `json:"payload_with_tools"`
		Budget []struct {
			Window       int      `json:"window"`
			Tools        *string  `json:"tools"`
			SystemTokens int      `json:"system_tokens"`
			Calibrated   *float64 `json:"calibrated"`
			ToolsTokens  int      `json:"tools_tokens"`
			Budget       int      `json:"budget"`
		} `json:"budget"`
		CompactionNeeded []struct {
			Name     string    `json:"name"`
			Messages []Message `json:"messages"`
			Window   int       `json:"window"`
			Output   bool      `json:"output"`
		} `json:"compaction_needed"`
		Fit []struct {
			Name       string    `json:"name"`
			Messages   []Message `json:"messages"`
			Budget     int       `json:"budget"`
			KeepRecent int       `json:"keep_recent"`
			Output     []Message `json:"output"`
			Pruned     bool      `json:"pruned"`
		} `json:"fit"`
		Compact []struct {
			Name        string    `json:"name"`
			Messages    []Message `json:"messages"`
			KeepRecent  int       `json:"keep_recent"`
			Summary     string    `json:"summary"`
			Output      []Message `json:"output"`
			Error       string    `json:"error"`
			AskReceived []Message `json:"ask_received"`
		} `json:"compact"`
		Constants map[string]any `json:"constants"`
	} `json:"history"`
}

func load(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/agent_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.History.Fit) == 0 {
		t.Fatal("corpus vacío")
	}
	return c
}

func estimator(calibrated *float64) *Estimator {
	e := &Estimator{}
	if calibrated != nil {
		e.calibrated = *calibrated
	}
	return e
}

func tools(ref string) []map[string]any {
	switch ref {
	case "all":
		return toolspec.Schemas()
	case "sample":
		return toolspec.Schemas()[:3]
	}
	return nil
}

func sameMessages(t *testing.T, got, want []Message) {
	t.Helper()
	norm := func(m []Message) any {
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var v any
		_ = json.Unmarshal(raw, &v)
		return v
	}
	if !reflect.DeepEqual(norm(got), norm(want)) {
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		t.Fatalf("mensajes distintos\n got: %.600s\nwant: %.600s", g, w)
	}
}

func TestClip(t *testing.T) {
	for _, c := range load(t).History.Clip {
		t.Run(c.Name, func(t *testing.T) {
			limit := MaxToolOutputChars
			if c.Limit != nil {
				limit = *c.Limit
			}
			if got := ClipToolOutput(c.Text, limit); got != c.Output {
				t.Fatalf("got %q, want %q", got, c.Output)
			}
		})
	}
}

func TestShrink(t *testing.T) {
	for _, c := range load(t).History.Shrink {
		t.Run(c.Name, func(t *testing.T) {
			limit := MaxOldToolOutputChar
			if c.Limit != nil {
				limit = *c.Limit
			}
			sameMessages(t, ShrinkOldResults(c.Messages, c.KeepRecent, limit), c.Output)
		})
	}
}

func TestEstimate(t *testing.T) {
	for _, c := range load(t).History.Estimate {
		t.Run(c.Name, func(t *testing.T) {
			if got := PayloadChars(c.Messages, nil); got != c.PayloadChars {
				t.Errorf("PayloadChars = %d, want %d", got, c.PayloadChars)
			}
			if got := estimator(c.Calibrated).EstimateTokens(c.Messages); got != c.Tokens {
				t.Errorf("EstimateTokens = %d, want %d", got, c.Tokens)
			}
			if got := ImageCount(c.Messages); got != c.Images {
				t.Errorf("ImageCount = %d, want %d", got, c.Images)
			}
		})
	}
}

func TestPayloadWithTools(t *testing.T) {
	for _, c := range load(t).History.PayloadWithTools {
		t.Run(c.Name, func(t *testing.T) {
			if got := PayloadChars(c.Messages, tools(c.Tools)); got != c.Chars {
				t.Fatalf("got %d, want %d", got, c.Chars)
			}
		})
	}
}

func TestBudget(t *testing.T) {
	for _, c := range load(t).History.Budget {
		ref := ""
		if c.Tools != nil {
			ref = *c.Tools
		}
		e := estimator(c.Calibrated)
		if got := e.ToolsTokens(tools(ref)); got != c.ToolsTokens {
			t.Errorf("ToolsTokens(%q, cal=%v) = %d, want %d", ref, c.Calibrated, got, c.ToolsTokens)
		}
		if got := e.PromptBudget(c.Window, tools(ref), c.SystemTokens); got != c.Budget {
			t.Errorf("PromptBudget(%d, %q, %d, cal=%v) = %d, want %d", c.Window, ref, c.SystemTokens, c.Calibrated, got, c.Budget)
		}
	}
}

func TestNeedsCompaction(t *testing.T) {
	for _, c := range load(t).History.CompactionNeeded {
		if got := (&Estimator{}).NeedsCompaction(c.Messages, c.Window); got != c.Output {
			t.Errorf("%s window=%d: got %v, want %v", c.Name, c.Window, got, c.Output)
		}
	}
}

func TestFit(t *testing.T) {
	for _, c := range load(t).History.Fit {
		t.Run(c.Name, func(t *testing.T) {
			got, pruned := (&Estimator{}).FitHistory(c.Messages, c.Budget, c.KeepRecent)
			if pruned != c.Pruned {
				t.Errorf("pruned = %v, want %v", pruned, c.Pruned)
			}
			sameMessages(t, got, c.Output)
		})
	}
}

func TestCompact(t *testing.T) {
	for _, c := range load(t).History.Compact {
		t.Run(c.Name, func(t *testing.T) {
			var received []Message
			ask := func(m []Message) (string, error) {
				received = m
				return c.Summary, nil
			}
			got, err := CompactMessages(c.Messages, ask, c.KeepRecent)
			if c.Error != "" {
				if err == nil || err.Error() != c.Error || !errors.Is(err, ErrEmptySummary) {
					t.Fatalf("error: %v, want %q", err, c.Error)
				}
			} else if err != nil {
				t.Fatal(err)
			} else {
				sameMessages(t, got, c.Output)
			}
			if c.AskReceived != nil {
				sameMessages(t, received, c.AskReceived)
			} else if received != nil {
				t.Errorf("no debía llamar a ask: %v", received)
			}
		})
	}
}

func TestCompactPropagatesAskError(t *testing.T) {
	boom := errors.New("gateway caído")
	msgs := []Message{User("a"), Assistant("b"), User("c"), Assistant("d"), User("e"), Assistant("f")}
	if _, err := CompactMessages(msgs, func([]Message) (string, error) { return "", boom }, 2); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
}

func TestConstantsMatchPython(t *testing.T) {
	consts := load(t).History.Constants
	numbers := map[string]float64{
		"PROMPT_BUDGET_RATIO": PromptBudgetRatio, "CHARS_PER_TOKEN": CharsPerToken, "TOKENS_PER_IMAGE": TokensPerImage,
		"MAX_TOOL_OUTPUT_CHARS": MaxToolOutputChars, "MAX_OLD_TOOL_OUTPUT_CHARS": MaxOldToolOutputChar,
		"KEEP_RECENT": KeepRecent, "AUTO_COMPACT_RATIO": AutoCompactRatio, "COMPACT_KEEP_RECENT": CompactKeepRecent,
	}
	for name, want := range numbers {
		if got, _ := consts[name].(float64); math.Abs(got-want) > 1e-12 {
			t.Errorf("%s = %v, Python %v", name, want, consts[name])
		}
	}
	if consts["PRUNE_NOTE"] != PruneNote || consts["COMPACT_PROMPT"] != CompactPrompt {
		t.Error("textos de PruneNote/CompactPrompt distintos")
	}
	if got := strings.ReplaceAll(clipMark, "%d", "{omitted}"); consts["CLIP_MARK"] != got {
		t.Errorf("CLIP_MARK: %q vs %q", got, consts["CLIP_MARK"])
	}
}

func TestCalibrate(t *testing.T) {
	e := &Estimator{}
	e.Calibrate(100, 1000)
	if e.CharsPerToken() != CharsPerToken {
		t.Error("una muestra pequeña no debe calibrar")
	}
	e.Calibrate(4000, 1000)
	if e.CharsPerToken() != 4 {
		t.Errorf("chars/token = %v", e.CharsPerToken())
	}
	e.Calibrate(1_000_000, 100)
	if e.CharsPerToken() != 8 {
		t.Errorf("tope superior: %v", e.CharsPerToken())
	}
	e.Calibrate(300, 200)
	if e.CharsPerToken() != 1.5 {
		t.Errorf("tope inferior: %v", e.CharsPerToken())
	}
}

func TestMessageJSONKeepsToolFields(t *testing.T) {
	raw, _ := json.Marshal(Message{Role: "tool", Content: "r"})
	if string(raw) != `{"content":"r","name":"","role":"tool","tool_call_id":""}` {
		t.Fatalf("got %s", raw)
	}
	raw, _ = json.Marshal(User("hola"))
	if string(raw) != `{"content":"hola","role":"user"}` {
		t.Fatalf("got %s", raw)
	}
}
