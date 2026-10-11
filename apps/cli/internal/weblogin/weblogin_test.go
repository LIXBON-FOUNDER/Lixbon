package weblogin

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func start(t *testing.T) (*Session, string) {
	t.Helper()
	s, err := Start("https://lixbon.com/")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	u, _ := url.Parse(s.URL)
	return s, u.Query().Get("redirect_uri")
}

func TestStartBuildsTheConnectURLWithPKCE(t *testing.T) {
	s, redirect := start(t)
	u, err := url.Parse(s.URL)
	if err != nil || u.Host != "lixbon.com" || u.Path != "/ide/connect" {
		t.Fatalf("URL: %s", s.URL)
	}
	q := u.Query()
	if q.Get("client") != "cli" || q.Get("method") != "S256" || q.Get("state") != s.State {
		t.Fatalf("parámetros: %v", q)
	}
	if q.Get("challenge") != challenge(s.Verifier) || strings.Contains(q.Get("challenge"), "=") {
		t.Fatal("el challenge es el SHA-256 en base64url sin relleno")
	}
	if !strings.HasPrefix(redirect, "http://127.0.0.1:") || !strings.HasSuffix(redirect, "/callback") {
		t.Fatalf("vuelta: %s", redirect)
	}
}

func get(t *testing.T, target string) int {
	t.Helper()
	resp, err := http.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func TestCallbackDeliversTheTokenOnlyWithTheRightState(t *testing.T) {
	s, redirect := start(t)
	if code := get(t, redirect+"?token=robado&state=otro"); code != http.StatusBadRequest {
		t.Fatalf("state ajeno: %d", code)
	}
	if code := get(t, redirect+"?token=tok123&state="+url.QueryEscape(s.State)); code != http.StatusOK {
		t.Fatalf("vuelta buena: %d", code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	token, err := s.Wait(ctx)
	if err != nil || token != "tok123" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestCallbackReportsTheCancelFromTheBrowser(t *testing.T) {
	s, redirect := start(t)
	get(t, redirect+"?error=access_denied&state="+url.QueryEscape(s.State))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := s.Wait(ctx); err != ErrCancelled {
		t.Fatalf("err = %v", err)
	}
}

func TestWaitTimesOut(t *testing.T) {
	s, _ := start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := s.Wait(ctx); err != ErrTimeout {
		t.Fatalf("err = %v", err)
	}
}

func TestParseCallbackURL(t *testing.T) {
	cases := []struct {
		raw   string
		token string
		err   error
	}{
		{"http://127.0.0.1:53121/callback?token=abc&state=s1", "abc", nil},
		{`"http://127.0.0.1:53121/callback?token=abc"`, "abc", nil},
		{"http://127.0.0.1:53121/callback?token=abc&state=otro", "", ErrState},
		{"http://127.0.0.1:53121/callback?error=access_denied&state=s1", "", ErrCancelled},
		{"http://127.0.0.1:53121/callback", "", ErrNoToken},
		{"no es una dirección", "", ErrNoToken},
	}
	for _, c := range cases {
		token, err := ParseCallbackURL(c.raw, "s1")
		if token != c.token || err != c.err {
			t.Errorf("%q: token=%q err=%v", c.raw, token, err)
		}
	}
}
