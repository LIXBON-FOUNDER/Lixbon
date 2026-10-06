package tui

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type catalogCorpus struct {
	Catalog struct {
		Groups    []string            `json:"groups"`
		Specs     [][]string          `json:"specs"`
		Ordered   []string            `json:"ordered"`
		NameWidth int                 `json:"name_width"`
		Matches   map[string][]string `json:"matches"`
	} `json:"catalog"`
}

func loadCatalog(t *testing.T) catalogCorpus {
	t.Helper()
	raw, err := os.ReadFile("../../../validation/fixtures/state_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var c catalogCorpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func names(specs []Spec) []string {
	out := make([]string, len(specs))
	for i, s := range specs {
		out[i] = s.Name
	}
	return out
}

func TestCatalogMatchesPython(t *testing.T) {
	c := loadCatalog(t).Catalog
	if !reflect.DeepEqual(Groups, c.Groups) {
		t.Fatalf("grupos: %v vs %v", Groups, c.Groups)
	}
	if len(Specs) != len(c.Specs) {
		t.Fatalf("comandos: %d vs %d", len(Specs), len(c.Specs))
	}
	for i, want := range c.Specs {
		got := Specs[i]
		if got.Name != want[0] || got.Args != want[1] || got.Desc != want[2] || got.Group != want[3] {
			t.Errorf("comando %d: %+v vs %v", i, got, want)
		}
	}
	if !reflect.DeepEqual(names(Ordered()), c.Ordered) {
		t.Fatalf("orden:\n got: %v\nwant: %v", names(Ordered()), c.Ordered)
	}
	if NameWidth != c.NameWidth {
		t.Fatalf("NameWidth %d vs %d", NameWidth, c.NameWidth)
	}
	longest := 0
	for _, s := range Specs {
		longest = max(longest, len(s.Name))
	}
	if NameWidth != longest+1 {
		t.Fatalf("NameWidth debe ser la longitud del nombre más largo + 1 (%d)", longest+1)
	}
}

func TestMatchMatchesPython(t *testing.T) {
	for prefix, want := range loadCatalog(t).Catalog.Matches {
		got := names(Match(prefix))
		if len(got) == 0 && len(want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Match(%q) = %v, want %v", prefix, got, want)
		}
	}
}
