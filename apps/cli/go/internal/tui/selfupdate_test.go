package tui

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"lixbon.com/cli/internal/update"
)

func fakeUpdater(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	previous := newUpdater
	newUpdater = func(string) (*update.Updater, error) {
		return &update.Updater{
			HTTP: srv.Client(), ManifestURL: srv.URL, Current: "2.3.0", GOOS: "linux", GOARCH: "amd64",
			Exe: t.TempDir() + "/lixbon",
		}, nil
	}
	t.Cleanup(func() { newUpdater = previous })
}

func TestUpdateReportsUpToDate(t *testing.T) {
	fakeUpdater(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"version":"2.3.0","assets":{"linux-amd64":{"url":"https://x/y.tar.gz","sha256":"` +
			"0000000000000000000000000000000000000000000000000000000000000000" + `"}}}`))
	})
	h := newHarness(t, nil)
	h.send("/update")
	h.settle()
	contains(t, h.out(), "lixbon ya está actualizado (v2.3.0).")
}

func TestUpdateShowsFailure(t *testing.T) {
	fakeUpdater(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "caído", http.StatusBadGateway) })
	h := newHarness(t, nil)
	h.send("/update")
	h.settle()
	contains(t, h.out(), "no se pudo consultar la versión más reciente")
}
