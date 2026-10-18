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

func TestNoticeReportsNewerVersionOncePerInterval(t *testing.T) {
	u, dir, now := noticeUpdater(t), t.TempDir(), time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)

	if version, ok := CheckNotice(context.Background(), u, dir, now); !ok || version != "2.4.0" {
		t.Fatalf("primera comprobación: %q, %v", version, ok)
	}
	if _, ok := CheckNotice(context.Background(), u, dir, now.Add(noticeInterval-time.Hour)); ok {
		t.Fatal("dentro del intervalo no debe volver a comprobar")
	}
	if version, ok := CheckNotice(context.Background(), u, dir, now.Add(noticeInterval+time.Hour)); !ok || version != "2.4.0" {
		t.Fatalf("pasado el intervalo debe volver a avisar: %q, %v", version, ok)
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
	if !NoticeEnabled(generic) {
		t.Fatal("con un proveedor genérico también se consulta, al gateway por defecto")
	}
	t.Setenv(DisableEnv, "1")
	if NoticeEnabled(cfg) {
		t.Fatalf("%s lo desactiva", DisableEnv)
	}
}

func TestAutoUpdateInstallsOnceAndWaitsForTheRestart(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("binario-nuevo")), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, exe := setup(t, f, "linux")
	dir, now := t.TempDir(), time.Now()

	out, ok := AutoUpdate(context.Background(), u, dir, now)
	if !ok || !out.Installed || out.Version != "2.4.0" || out.Err != nil {
		t.Fatalf("primera comprobación: %+v, %v", out, ok)
	}
	if got, _ := os.ReadFile(exe); string(got) != "binario-nuevo" {
		t.Fatalf("el binario no se sustituyó: %q", got)
	}
	f.archive = nil
	out, ok = AutoUpdate(context.Background(), u, dir, now.Add(time.Minute))
	if !ok || !out.Installed || out.Version != "2.4.0" {
		t.Fatalf("otra ventana sin reiniciar ve que ya está instalada, sin descargar: %+v, %v", out, ok)
	}
	u.Current = "2.4.0"
	if out, ok := AutoUpdate(context.Background(), u, dir, now.Add(2*time.Minute)); ok {
		t.Fatalf("tras reiniciar en la versión nueva no hay nada que decir: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(dir, installedStamp)); err == nil {
		t.Fatal("la marca de instalada se borra al arrancar la versión nueva")
	}
}

func TestAutoUpdateReportsAFailedInstall(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("x")), "lixbon-2.4.0-linux-amd64.tar.gz")
	f.gwDigest = digest([]byte("otra cosa"))
	u, exe := setup(t, f, "linux")
	out, ok := AutoUpdate(context.Background(), u, t.TempDir(), time.Now())
	if !ok || out.Installed || out.Err == nil || out.Version != "2.4.0" {
		t.Fatalf("un digest que no cuadra no instala y lo dice: %+v, %v", out, ok)
	}
	assertUntouched(t, exe)
}
