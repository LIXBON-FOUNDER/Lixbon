package agent

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/tools"
)

type agentCorpus struct {
	Policy struct {
		Prefix []struct {
			Command string `json:"command"`
			Prefix  string `json:"prefix"`
		} `json:"prefix"`
		Allowed []struct {
			Command string   `json:"command"`
			Allowed []string `json:"allowed"`
			Output  bool     `json:"output"`
		} `json:"allowed"`
	} `json:"policy"`
	Tree []struct {
		Name       string            `json:"name"`
		Files      map[string]string `json:"files"`
		EmptyDirs  []string          `json:"empty_dirs"`
		MaxEntries *int              `json:"max_entries"`
		Output     string            `json:"output"`
	} `json:"tree"`
	Prompts struct {
		Files     map[string]string `json:"files"`
		EmptyDirs []string          `json:"empty_dirs"`
		Native    string            `json:"native"`
		Text      string            `json:"text"`
	} `json:"prompts"`
	Diff []struct {
		Name        string  `json:"name"`
		Old         string  `json:"old"`
		New         string  `json:"new"`
		Rows        [][]any `json:"rows"`
		ContextRows [][]any `json:"context_rows"`
		Adds        int     `json:"adds"`
		Dels        int     `json:"dels"`
	} `json:"diff"`
	Change struct {
		Files map[string]struct {
			Text string `json:"text"`
			B64  string `json:"b64"`
		} `json:"files"`
		Cases []struct {
			Name   string         `json:"name"`
			Tool   string         `json:"tool"`
			Args   map[string]any `json:"args"`
			Change *struct {
				Kind    string `json:"kind"`
				Path    string `json:"path"`
				OldText string `json:"old_text"`
				NewText string `json:"new_text"`
				Detail  string `json:"detail"`
			} `json:"change"`
		} `json:"cases"`
	} `json:"change"`
	Summary struct {
		Args []struct {
			Tool   string         `json:"tool"`
			Args   map[string]any `json:"args"`
			Output string         `json:"output"`
		} `json:"args"`
		Result []struct {
			Result string `json:"result"`
			Output string `json:"output"`
		} `json:"result"`
	} `json:"summary"`
	Misc struct {
		Constants map[string]any `json:"constants"`
		Sanitize  []struct {
			Name     string            `json:"name"`
			Messages []history.Message `json:"messages"`
			Output   []history.Message `json:"output"`
		} `json:"sanitize"`
		MCP struct {
			Schemas []json.RawMessage `json:"schemas"`
			Output  string            `json:"output"`
		} `json:"mcp_text_prompt"`
	} `json:"misc"`
}

func loadCorpus(t *testing.T) agentCorpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/agent_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c agentCorpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Policy.Allowed) == 0 {
		t.Fatal("corpus vacío")
	}
	return c
}

func materialize(t *testing.T, root string, files map[string]string, emptyDirs []string) {
	t.Helper()
	for rel, data := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range emptyDirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCommandPrefixCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Policy.Prefix {
		if got := CommandPrefix(c.Command); got != c.Prefix {
			t.Errorf("CommandPrefix(%q) = %q, want %q", c.Command, got, c.Prefix)
		}
	}
}

func TestCommandAllowedCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Policy.Allowed {
		if got := CommandAllowed(c.Command, c.Allowed); got != c.Output {
			t.Errorf("CommandAllowed(%q, %q) = %v, want %v", c.Command, c.Allowed, got, c.Output)
		}
	}
}

func TestCommandAllowedChainsNeedEverySegment(t *testing.T) {
	allowed := []string{"npm test"}
	for command, want := range map[string]bool{
		"npm test":                 true,
		"npm test --watch":         true,
		"npm test && rm -rf x":     false,
		"npm test; rm x":           false,
		"npm test | tee log":       false,
		"npm test || npm test":     true,
		"npm testing":              false,
		"npm":                      false,
		"echo $(rm x) && npm test": false,
	} {
		if got := CommandAllowed(command, allowed); got != want {
			t.Errorf("%q = %v, want %v", command, got, want)
		}
	}
}

func TestWhitespaceOnlyPrefixAllowsNothing(t *testing.T) {
	if CommandAllowed("rm -rf /", []string{"   ", ""}) {
		t.Fatal("un prefijo vacío no debe permitir comandos")
	}
}

func TestTreeCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Tree {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			materialize(t, root, c.Files, c.EmptyDirs)
			limit := tools.MaxTreeEntries
			if c.MaxEntries != nil {
				limit = *c.MaxEntries
			}
			if got := tools.WorkspaceTree(root, limit); got != c.Output {
				t.Fatalf("got:\n%s\nwant:\n%s", got, c.Output)
			}
		})
	}
}

func TestPromptsCorpus(t *testing.T) {
	c := loadCorpus(t).Prompts
	root := t.TempDir()
	materialize(t, root, c.Files, c.EmptyDirs)
	for name, got := range map[string]string{
		"native": strings.ReplaceAll(NativeSystemPrompt(root), root, "<WS>"),
		"text":   strings.ReplaceAll(TextSystemPrompt(root), root, "<WS>"),
	} {
		want := c.Native
		if name == "text" {
			want = c.Text
		}
		if got != want {
			t.Errorf("prompt %s distinto", name)
			for i := 0; i < min(len(got), len(want)); i++ {
				if got[i] != want[i] {
					t.Errorf("primera diferencia en el byte %d:\n got: …%q\nwant: …%q", i,
						got[max(0, i-40):min(len(got), i+60)], want[max(0, i-40):min(len(want), i+60)])
					break
				}
			}
			if len(got) != len(want) {
				t.Errorf("longitudes: got %d, want %d", len(got), len(want))
			}
		}
	}
}

func TestConstantsMatchPython(t *testing.T) {
	consts := loadCorpus(t).Misc.Constants
	texts := map[string]string{
		"NUDGE_PROMPT": NudgePrompt, "NATIVE_NUDGE_PROMPT": NativeNudgePrompt, "NO_OUTPUT_PROMPT": NoOutputPrompt,
		"TRUNCATED_PROMPT": TruncatedPrompt, "PLAN_MODE_PROMPT": PlanModePrompt, "TODO_PROMPT": TodoPrompt,
		"TOOL_IMAGES_PROMPT": ToolImagesPrompt,
	}
	for name, got := range texts {
		if consts[name] != got {
			t.Errorf("%s distinto:\n got: %q\nwant: %q", name, got, consts[name])
		}
	}
	if consts["MAX_AGENT_STEPS"] != float64(MaxSteps) || consts["MAX_REPEATED_CALLS"] != float64(MaxRepeatedCalls) {
		t.Errorf("límites: %v %v", consts["MAX_AGENT_STEPS"], consts["MAX_REPEATED_CALLS"])
	}
}

func TestSanitizeCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Misc.Sanitize {
		t.Run(c.Name, func(t *testing.T) {
			got := SanitizeForPlainChat(c.Messages)
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(c.Output)
			if !reflect.DeepEqual(g, w) {
				t.Fatalf("got %s\nwant %s", g, w)
			}
		})
	}
}

func TestMCPTextPromptCorpus(t *testing.T) {
	c := loadCorpus(t).Misc.MCP
	if got := MCPTextPrompt(c.Schemas); got != c.Output {
		for i := 0; i < min(len(got), len(c.Output)); i++ {
			if got[i] != c.Output[i] {
				t.Fatalf("difiere en %d:\n got: …%q\nwant: …%q", i, got[max(0, i-60):min(len(got), i+80)],
					c.Output[max(0, i-60):min(len(c.Output), i+80)])
			}
		}
		t.Fatalf("longitudes: got %d, want %d", len(got), len(c.Output))
	}
}

func rowsToAny(rows []DiffRow) [][]any {
	out := make([][]any, len(rows))
	for i, r := range rows {
		out[i] = []any{r.Kind, float64(r.OldNo), float64(r.NewNo), r.Text}
	}
	return out
}

func TestDiffCorpus(t *testing.T) {
	for _, c := range loadCorpus(t).Diff {
		t.Run(c.Name, func(t *testing.T) {
			change := Change{Kind: "update", Path: "f.txt", OldText: c.Old, NewText: c.New}
			if got := rowsToAny(DiffRows(change, DiffContext)); !reflect.DeepEqual(append([][]any{}, got...), append([][]any{}, c.Rows...)) {
				t.Errorf("filas (contexto 3)\n got: %v\nwant: %v", got, c.Rows)
			}
			if got := rowsToAny(DiffRows(change, 1)); !reflect.DeepEqual(append([][]any{}, got...), append([][]any{}, c.ContextRows...)) {
				t.Errorf("filas (contexto 1)\n got: %v\nwant: %v", got, c.ContextRows)
			}
			if adds, dels := DiffCounts(change); adds != c.Adds || dels != c.Dels {
				t.Errorf("conteo +%d -%d, esperaba +%d -%d", adds, dels, c.Adds, c.Dels)
			}
		})
	}
}

func TestComputeChangeCorpus(t *testing.T) {
	c := loadCorpus(t).Change
	root := t.TempDir()
	for rel, f := range c.Files {
		data := []byte(f.Text)
		if f.B64 != "" {
			data, _ = base64.StdEncoding.DecodeString(f.B64)
		}
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range c.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := ComputeChange(root, tc.Tool, tc.Args)
			if tc.Change == nil {
				if got != nil {
					t.Fatalf("esperaba nil, obtuve %+v", got)
				}
				return
			}
			want := Change{Kind: tc.Change.Kind, Path: tc.Change.Path, OldText: tc.Change.OldText, NewText: tc.Change.NewText, Detail: tc.Change.Detail}
			if got == nil || *got != want {
				t.Fatalf("got %+v\nwant %+v", got, want)
			}
		})
	}
}

func TestSummaryCorpus(t *testing.T) {
	c := loadCorpus(t).Summary
	for _, a := range c.Args {
		if got := ArgsSummary(a.Tool, a.Args); got != a.Output {
			t.Errorf("ArgsSummary(%s, %v) = %q, want %q", a.Tool, a.Args, got, a.Output)
		}
	}
	for _, r := range c.Result {
		if got := ResultSummary(r.Result); got != r.Output {
			t.Errorf("ResultSummary(%.30q) = %q, want %q", r.Result, got, r.Output)
		}
	}
}
