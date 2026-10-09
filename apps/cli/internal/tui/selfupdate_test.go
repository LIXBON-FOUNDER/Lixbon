package tui

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"lixbon.com/cli/internal/config"
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

func TestUpdateNoticePrintsWhenThereIsANewVersion(t *testing.T) {
	h := newHarness(t, nil)
	h.m.opts.UpdateNotice = func(context.Context) (string, bool) { return "9.9.9", true }
	h.update(h.m.updateNoticeCmd()())
	contains(t, h.out(), "Hay una versión nueva (v9.9.9). Ejecuta /update.")
}

func TestUpdateNoticeIsSilentWithoutNewVersion(t *testing.T) {
	h := newHarness(t, nil)
	if h.m.updateNoticeCmd() != nil {
		t.Fatal("sin comprobación configurada no hay comando")
	}
	h.m.opts.UpdateNotice = func(context.Context) (string, bool) { return "", false }
	if msg := h.m.updateNoticeCmd()(); msg != nil {
		t.Fatalf("sin versión nueva no hay mensaje: %v", msg)
	}
}

func TestUpdateNoticeCanBeDisabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if updateNotice(config.Default(), path) == nil {
		t.Fatal("debe estar activo por defecto")
	}
	off := config.Default()
	off.Extra["update_check"] = []byte("false")
	if updateNotice(off, path) != nil {
		t.Fatal("update_check=false debe desactivar el aviso")
	}
	t.Setenv(update.DisableEnv, "1")
	if updateNotice(config.Default(), path) != nil {
		t.Fatalf("%s debe desactivar el aviso", update.DisableEnv)
	}
}

func TestUpdateNoticeNeverRunsWithAGenericProvider(t *testing.T) {
	cfg := config.Default()
	if err := cfg.AddProfile("local", config.Profile{BaseURL: "http://localhost:1234/v1", Generic: true}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.UseProfile("local"); err != nil {
		t.Fatal(err)
	}
	if updateNotice(cfg, filepath.Join(t.TempDir(), "config.json")) != nil {
		t.Fatal("un proveedor genérico no consulta el gateway")
	}
}
