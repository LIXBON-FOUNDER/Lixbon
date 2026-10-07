package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
)

func noticeUpdater(t *testing.T) *Updater {
	t.Helper()
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("x")), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, _ := setup(t, f, "linux")
	return u
}

func TestNoticeReportsNewerVersionOncePerDay(t *testing.T) {
	u, dir, now := noticeUpdater(t), t.TempDir(), time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)

	if version, ok := CheckNotice(context.Background(), u, dir, now); !ok || version != "2.4.0" {
		t.Fatalf("primera comprobación: %q, %v", version, ok)
	}
	if _, ok := CheckNotice(context.Background(), u, dir, now.Add(23*time.Hour)); ok {
		t.Fatal("dentro de las 24 horas no debe volver a comprobar")
	}
	if version, ok := CheckNotice(context.Background(), u, dir, now.Add(25*time.Hour)); !ok || version != "2.4.0" {
		t.Fatalf("pasadas 24 horas debe volver a avisar: %q, %v", version, ok)
	}
}

func TestNoticeSilentWhenUpToDate(t *testing.T) {
	u := noticeUpdater(t)
	u.Current = "2.4.0"
	if version, ok := CheckNotice(context.Background(), u, t.TempDir(), time.Now()); ok {
		t.Fatalf("no debe avisar si está al día: %q", version)
	}
}

func TestNoticeSilentWhenGatewayIsDown(t *testing.T) {
	u, dir := noticeUpdater(t), t.TempDir()
	u.ManifestURL = "http://127.0.0.1:1/api/updates/cli/beta"
	start := time.Now()
	if _, ok := CheckNotice(context.Background(), u, dir, time.Now()); ok {
		t.Fatal("un gateway caído no puede producir aviso")
	}
	if time.Since(start) > noticeTimeout+time.Second {
		t.Fatalf("la comprobación tardó %v", time.Since(start))
	}
	if _, err := os.Stat(filepath.Join(dir, noticeStamp)); err != nil {
		t.Fatal("el intento debe quedar anotado para no reintentar en cada arranque")
	}
}

func TestNoticeSkipsLocalBuilds(t *testing.T) {
	u, dir := noticeUpdater(t), t.TempDir()
	u.Current = config.DevVersion
	if _, ok := CheckNotice(context.Background(), u, dir, time.Now()); ok {
		t.Fatal("una compilación local no avisa")
	}
	if _, err := os.Stat(filepath.Join(dir, noticeStamp)); err == nil {
		t.Fatal("una compilación local no debe consultar ni anotar nada")
	}
}

func TestNoticeEnabled(t *testing.T) {
	cfg := config.Default()
	if !NoticeEnabled(cfg) {
		t.Fatal("debe estar activo por defecto")
	}
	off := config.Default()
	off.Extra["update_check"] = []byte("false")
	if NoticeEnabled(off) {
		t.Fatal("update_check=false lo desactiva")
	}
	generic := config.Default()
	if err := generic.AddProfile("local", config.Profile{BaseURL: "http://localhost:1234/v1", Generic: true}); err != nil {
		t.Fatal(err)
	}
	if err := generic.UseProfile("local"); err != nil {
		t.Fatal(err)
	}
	if NoticeEnabled(generic) {
		t.Fatal("un proveedor genérico no publica binarios")
	}
	t.Setenv(DisableEnv, "1")
	if NoticeEnabled(cfg) {
		t.Fatalf("%s lo desactiva", DisableEnv)
	}
}
