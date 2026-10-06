package agent

import (
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
