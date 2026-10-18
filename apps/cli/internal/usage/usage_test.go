package usage

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestSummariesGroupByProviderAndModelAndPeriod(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	l := Open(filepath.Join(t.TempDir(), FileName))
	add := func(ago time.Duration, provider, model string, prompt, completion, cached int) {
		t.Helper()
		if err := l.Add(Record{At: now.Add(-ago).Unix(), Provider: provider, Model: model, Prompt: prompt, Completion: completion, Cached: cached}); err != nil {
			t.Fatal(err)
		}
	}
	add(time.Hour, "xiaomi", "mimo-v2.6-pro", 1000, 100, 800)
	add(2*time.Hour, "xiaomi", "mimo-v2.6-pro", 2000, 200, 0)
	add(3*24*time.Hour, "xiaomi", "mimo-v2.6-pro", 4000, 400, 0)
	add(20*24*time.Hour, "openrouter", "qwen", 50, 5, 0)
	add(40*24*time.Hour, "openrouter", "qwen", 9999, 9999, 0)
	add(time.Minute, "xiaomi", "nada", 0, 0, 0)

	got, err := l.Summaries(now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Model != "mimo-v2.6-pro" || got[1].Provider != "openrouter" {
		t.Fatalf("resúmenes: %+v", got)
	}
	mimo := got[0]
	if mimo.Today.Requests != 2 || mimo.Today.Tokens() != 3300 || mimo.Today.Cached != 800 {
		t.Errorf("hoy: %+v", mimo.Today)
	}
	if mimo.Week.Tokens() != 7700 || mimo.Month.Requests != 3 {
		t.Errorf("semana %+v, mes %+v", mimo.Week, mimo.Month)
	}
	if q := got[1]; q.Today.Requests != 0 || q.Week.Requests != 0 || q.Month.Tokens() != 55 {
		t.Errorf("lo de hace 40 días no cuenta: %+v", q)
	}
}

func TestSummariesSkipBrokenLinesAndMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if got, err := Open(path).Summaries(time.Now()); err != nil || got != nil {
		t.Fatalf("sin archivo: %v %v", got, err)
	}
	now := time.Now()
	line := `{"at":` + strconv.FormatInt(now.Unix(), 10) + `,"provider":"p","model":"m","prompt":10,"completion":1}`
	if err := os.WriteFile(path, []byte("basura\n"+line+"\n{\"at\":\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Open(path).Summaries(now)
	if err != nil || len(got) != 1 || got[0].Today.Tokens() != 11 {
		t.Fatalf("con líneas rotas: %+v %v", got, err)
	}
}
