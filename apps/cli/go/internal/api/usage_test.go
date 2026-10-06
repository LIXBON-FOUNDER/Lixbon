package api

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestResetIn(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	cases := map[string]string{
		"":                          "",
		"basura":                    "",
		"2026-10-06T11:00:00+00:00": "en 1 min",
		"2026-10-06T12:00:30Z":      "en 1 min",
		"2026-10-06T12:45:00Z":      "en 45 min",
		"2026-10-06T14:14:00Z":      "en 2h 14min",
		"2026-10-06T14:14:00":       "en 2h 14min",
		"2026-10-07T12:00:00Z":      "en 1 día",
		"2026-10-09T13:00:00Z":      "en 3 días",
		"2026-10-06T08:00:00-04:00": "en 1 min",
	}
	for in, want := range cases {
		if got := ResetIn(in, now); got != want {
			t.Errorf("ResetIn(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUsageNodesKeyInfo(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/account/usage":
			io.WriteString(w, `{"plan":{"name":"Pro"},"buckets":{"session":{"percent":42.4,"reset_at":"2026-10-06T14:00:00Z"},"week":{"unlimited":true}}}`)
		case "/api/nodes":
			io.WriteString(w, `{"nodos":[{"id":"n1","name":"gpu-1","online":true,"score":0.9,"modelos":["a","b"]},{"id":"n2","online":false,"circuit_breaker":true}]}`)
		case "/api/key/info":
			io.WriteString(w, `{"plan":{"name":"Advance"},"key_model":"qwen"}`)
		default:
			http.NotFound(w, r)
		}
	})
	u, err := c.Usage(context.Background())
	if err != nil || u.Plan.Name != "Pro" || u.Buckets.Session.Percent != 42.4 || !u.Buckets.Week.Unlimited {
		t.Fatalf("usage: %+v %v", u, err)
	}
	nodes, err := c.Nodes(context.Background())
	if err != nil || len(nodes) != 2 || nodes[0].Name != "gpu-1" || len(nodes[0].Models) != 2 || !nodes[1].CircuitBreaker {
		t.Fatalf("nodes: %+v %v", nodes, err)
	}
	info, err := c.KeyInfo(context.Background())
	if err != nil || info.PlanName != "Advance" || info.KeyModel != "qwen" {
		t.Fatalf("key info: %+v %v", info, err)
	}
}
