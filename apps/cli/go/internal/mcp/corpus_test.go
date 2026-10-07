package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type corpus struct {
	Workspace    string `json:"workspace_placeholder"`
	FormatResult []struct {
		Result json.RawMessage `json:"result"`
		Text   string          `json:"text"`
	} `json:"format_result"`
	Slug []struct {
		Text string `json:"text"`
		Slug string `json:"slug"`
	} `json:"slug"`
	Schemas []struct {
		Server  string            `json:"server"`
		Tools   []Tool            `json:"tools"`
		Schemas []json.RawMessage `json:"schemas"`
	} `json:"schemas"`
	PromptText []struct {
		Result json.RawMessage `json:"result"`
		Text   string          `json:"text"`
	} `json:"prompt_text"`
	Config []struct {
		Name     string          `json:"name"`
		User     json.RawMessage `json:"user"`
		Project  json.RawMessage `json:"project"`
		Expected []struct {
			Name    string            `json:"name"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
			Cwd     string            `json:"cwd"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"expected"`
	} `json:"config"`
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/mcp_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCorpusFormatToolResult(t *testing.T) {
	for i, c := range loadCorpus(t).FormatResult {
		if got := FormatToolResult(c.Result); got != c.Text {
			t.Errorf("caso %d %s\n got %q\nwant %q", i, c.Result, got, c.Text)
		}
	}
}

func TestCorpusSlug(t *testing.T) {
	for _, c := range loadCorpus(t).Slug {
		if got := slug(c.Text); got != c.Slug {
			t.Errorf("slug(%q) = %q, Python %q", c.Text, got, c.Slug)
		}
	}
}

func TestCorpusPromptText(t *testing.T) {
	for i, c := range loadCorpus(t).PromptText {
		if got := PromptText(c.Result); got != c.Text {
			t.Errorf("caso %d %s\n got %q\nwant %q", i, c.Result, got, c.Text)
		}
	}
}

// Los schemas se comparan decodificados: el orden de las claves del objeto no
// importa, el de las propiedades se comprueba aparte en mcp_test.go.
func TestCorpusToolSchemasExceptTheOnesWithoutType(t *testing.T) {
	for _, c := range loadCorpus(t).Schemas {
		taken := map[string]toolRef{}
		for i, tool := range c.Tools {
			name := uniqueName(taken, c.Server, tool.Name)
			taken[name] = toolRef{}
			got, _ := toolSchema(name, c.Server, tool)
			var have, want any
			_ = json.Unmarshal(got, &have)
			_ = json.Unmarshal(c.Schemas[i], &want)
			if !reflect.DeepEqual(have, want) {
				t.Errorf("herramienta %q\n got %s\nwant %s", tool.Name, got, c.Schemas[i])
			}
		}
	}
}

func TestCorpusConfig(t *testing.T) {
	c := loadCorpus(t)
	for _, tc := range c.Config {
		home, ws := t.TempDir(), t.TempDir()
		if tc.User != nil && string(tc.User) != "null" {
			writeFile(t, filepath.Join(home, FileName), string(tc.User))
		}
		if tc.Project != nil && string(tc.Project) != "null" {
			writeFile(t, filepath.Join(ws, ".lixbon", FileName), string(tc.Project))
		}
		got := LoadSpecs(ws, home)
		if len(got) != len(tc.Expected) {
			t.Errorf("%s: %d servidores, Python %d", tc.Name, len(got), len(tc.Expected))
			continue
		}
		for i, want := range tc.Expected {
			spec := got[i]
			cwd := strings.Replace(spec.Cwd, ws, c.Workspace, 1)
			args := spec.Args
			if args == nil {
				args = []string{}
			}
			if spec.Remote() {
				args, cwd = nil, ""
			}
			if spec.Name != want.Name || spec.Command != want.Command || spec.URL != want.URL ||
				!reflect.DeepEqual(args, orEmpty(want.Args, spec.Remote())) ||
				!reflect.DeepEqual(spec.Env, orNil(want.Env)) || !reflect.DeepEqual(spec.Headers, orNil(want.Headers)) ||
				cwd != want.Cwd {
				t.Errorf("%s [%d]\n got %+v (cwd %q)\nwant %+v", tc.Name, i, spec, cwd, want)
			}
		}
	}
}

func orNil(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	return m
}

func orEmpty(args []string, remote bool) []string {
	if remote {
		return nil
	}
	if args == nil {
		return []string{}
	}
	return args
}
