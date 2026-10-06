package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type corpus struct {
	Project []struct {
		Name     string            `json:"name"`
		Files    map[string]string `json:"files"`
		RawBytes map[string][]int  `json:"raw_bytes"`
		Output   string            `json:"output"`
	} `json:"project"`
	Commands struct {
		Files    map[string]string `json:"files"`
		Reserved []string          `json:"reserved"`
		Found    map[string]struct {
			Desc string `json:"desc"`
			Body string `json:"body"`
			File string `json:"file"`
		} `json:"found"`
		Expand []struct {
			Body      string `json:"body"`
			Arguments string `json:"arguments"`
			Output    string `json:"output"`
		} `json:"expand"`
	} `json:"commands"`
}

func load(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/state_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestProjectContextCorpus(t *testing.T) {
	for _, c := range load(t).Project {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			for rel, text := range c.Files {
				data := []byte(text)
				if raw, ok := c.RawBytes[rel]; ok {
					data = data[:0]
					for _, b := range raw {
						data = append(data, byte(b))
					}
				}
				if err := os.WriteFile(filepath.Join(root, rel), data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := ProjectContext(root); got != c.Output {
				t.Fatalf("got %q, want %q", got, c.Output)
			}
		})
	}
}

func TestCustomCommandsCorpus(t *testing.T) {
	c := load(t).Commands
	root := t.TempDir()
	for rel, text := range c.Files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	found := LoadCommands(filepath.Join(root, "ws"), filepath.Join(root, "home"), c.Reserved)
	if len(found) != len(c.Found) {
		t.Fatalf("comandos: %d, esperaba %d (%v)", len(found), len(c.Found), keys(found))
	}
	for name, want := range c.Found {
		got, ok := found[name]
		if !ok {
			t.Errorf("falta el comando %q", name)
			continue
		}
		if got.Description != want.Desc || got.Body != want.Body || filepath.Base(got.Path) != want.File {
			t.Errorf("%s: got {%q %q %s}, want {%q %q %s}", name, got.Description, got.Body, filepath.Base(got.Path), want.Desc, want.Body, want.File)
		}
	}
}

func keys(m map[string]Command) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestExpandCorpus(t *testing.T) {
	for _, c := range load(t).Commands.Expand {
		if got := Expand(c.Body, c.Arguments); got != c.Output {
			t.Errorf("Expand(%q, %q) = %q, want %q", c.Body, c.Arguments, got, c.Output)
		}
	}
}

func TestProjectCommandOverridesUserCommand(t *testing.T) {
	root := t.TempDir()
	for rel, text := range map[string]string{
		"home/commands/x.md":        "# del usuario\nA",
		"ws/.lixbon/commands/x.md":  "# del proyecto\nB",
		"ws/.lixbon/commands/ok.md": "C",
	} {
		path := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(path), 0o755)
		os.WriteFile(path, []byte(text), 0o644)
	}
	found := LoadCommands(filepath.Join(root, "ws"), filepath.Join(root, "home"), nil)
	if found["x"].Description != "del proyecto" || found["x"].Body != "B" || !strings.HasPrefix(found["ok"].Description, "prompt de ok.md") {
		t.Fatalf("%+v", found)
	}
}
