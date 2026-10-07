package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2.3.0", "2.3.0", 0},
		{"2.3.1", "2.3.0", 1},
		{"2.2.9", "2.3.0", -1},
		{"2.10.0", "2.9.0", 1},
		{"2.3.0-go.0", "2.3.0", -1},
		{"2.3.0", "2.3.0-go.0", 1},
		{"2.3.0-go.1", "2.3.0-go.0", 1},
		{"2.3.0-go.2", "2.3.0-go.10", -1},
		{"2.3.0-go", "2.3.0-go.0", -1},
		{"2.3.0-alpha", "2.3.0-1", 1},
		{"v2.3.0", "2.3.0", 0},
		{"2.3.0+build5", "2.3.0", 0},
	}
	for _, c := range cases {
		got, err := compareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, %v; quería %d", c.a, c.b, got, err, c.want)
		}
	}
	for _, bad := range []string{"", "2.3", "a.b.c", "2.3.-1"} {
		if _, err := compareVersions(bad, "1.0.0"); err == nil {
			t.Errorf("compareVersions(%q) debería fallar", bad)
		}
	}
}

func TestManifestURLFor(t *testing.T) {
	for in, want := range map[string]string{
		"https://lixbon.com/v1":  "https://lixbon.com/api/updates/cli/beta",
		"https://lixbon.com/v1/": "https://lixbon.com/api/updates/cli/beta",
		"https://lixbon.com":     "https://lixbon.com/api/updates/cli/beta",
	} {
		if got := ManifestURLFor(in); got != want {
			t.Errorf("ManifestURLFor(%q) = %q; quería %q", in, got, want)
		}
	}
}

func tarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		name string
		body []byte
	}{{"lixbon-2.4.0-linux-amd64/README.md", []byte("readme")}, {"lixbon-2.4.0-linux-amd64/" + name, content}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(f.body); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipFile(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("lixbon-2.4.0-windows-amd64/" + name)
	if err != nil {
		t.Fatal(err)
	}
	w.Write(content)
	zw.Close()
	return buf.Bytes()
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type fakeRelease struct {
	t        *testing.T
	archive  []byte
	assetKey string
	assetNm  string
	version  string
	gwDigest string
	sums     string
	assetErr int
	cutAsset bool
}

func (f *fakeRelease) serve() *httptest.Server {
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/api/updates/cli/beta", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version": f.version, "channel": "beta",
			"assets": map[string]any{f.assetKey: map[string]string{
				"url": srv.URL + "/dl/" + f.assetNm, "sha256": f.gwDigest,
			}},
		})
	})
	mux.HandleFunc("/dl/"+f.assetNm, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case f.assetErr != 0:
			http.Error(w, "x", f.assetErr)
		case f.cutAsset:
			w.Header().Set("Content-Length", fmt.Sprint(len(f.archive)))
			w.Write(f.archive[:len(f.archive)/2])
			if h, ok := w.(http.Hijacker); ok {
				conn, _, _ := h.Hijack()
				conn.Close()
			}
		default:
			w.Write(f.archive)
		}
	})
	mux.HandleFunc("/dl/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, f.sums)
	})
	srv = httptest.NewServer(mux)
	f.t.Cleanup(srv.Close)
	return srv
}

func newFake(t *testing.T, goos string, archive []byte, name string) *fakeRelease {
	d := digest(archive)
	return &fakeRelease{
		t: t, archive: archive, assetKey: goos + "-amd64", assetNm: name, version: "2.4.0",
		gwDigest: d, sums: d + "  " + name + "\n" + digest([]byte("otro")) + "  otro.tar.gz\n",
	}
}

func setup(t *testing.T, f *fakeRelease, goos string) (*Updater, string) {
	t.Helper()
	srv := f.serve()
	exe := filepath.Join(t.TempDir(), binaryNameFor(goos))
	if err := os.WriteFile(exe, []byte("version-vieja"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Updater{
		HTTP: srv.Client(), ManifestURL: srv.URL + "/api/updates/cli/beta",
		Current: "2.3.0-go.0", GOOS: goos, GOARCH: "amd64", Exe: exe,
	}, exe
}

func binaryNameFor(goos string) string {
	if goos == "windows" {
		return "lixbon.exe"
	}
	return "lixbon"
}

func assertUntouched(t *testing.T, exe string) {
	t.Helper()
	got, err := os.ReadFile(exe)
	if err != nil || string(got) != "version-vieja" {
		t.Fatalf("el binario actual cambió: %q, %v", got, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(exe))
	if len(entries) != 1 {
		t.Fatalf("quedaron archivos temporales o .old: %v", entries)
	}
}

func TestApplyTarGz(t *testing.T) {
	nuevo := []byte("binario-nuevo")
	f := newFake(t, "linux", tarGz(t, "lixbon", nuevo), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, exe := setup(t, f, "linux")
	rel, err := u.Check(context.Background())
	if err != nil || !rel.Newer || rel.Version != "2.4.0" {
		t.Fatalf("Check = %+v, %v", rel, err)
	}
	if err := u.Apply(context.Background(), rel); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(exe)
	if !bytes.Equal(got, nuevo) {
		t.Fatalf("contenido = %q", got)
	}
	if info, _ := os.Stat(exe); info.Mode()&0o100 == 0 && os.PathSeparator == '/' {
		t.Fatalf("sin permiso de ejecución: %v", info.Mode())
	}
	if entries, _ := os.ReadDir(filepath.Dir(exe)); len(entries) != 1 {
		t.Fatalf("archivos sobrantes: %v", entries)
	}
}

func TestApplyZipWindowsReplacesAndLeavesNoOld(t *testing.T) {
	nuevo := []byte("exe-nuevo")
	f := newFake(t, "windows", zipFile(t, "lixbon.exe", nuevo), "lixbon-2.4.0-windows-amd64.zip")
	u, exe := setup(t, f, "windows")
	rel, err := u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(context.Background(), rel); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(exe)
	if !bytes.Equal(got, nuevo) {
		t.Fatalf("contenido = %q", got)
	}
}

func TestCheckVersions(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("x")), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, _ := setup(t, f, "linux")
	for current, wantNewer := range map[string]bool{"2.3.0-go.0": true, "2.4.0": false, "2.5.0": false} {
		u.Current = current
		rel, err := u.Check(context.Background())
		if err != nil || rel.Newer != wantNewer {
			t.Errorf("Current %s: Newer = %v, %v; quería %v", current, rel.Newer, err, wantNewer)
		}
	}
}

func TestCheckRejectsOtherPlatform(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("x")), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, _ := setup(t, f, "linux")
	u.GOOS = "darwin"
	if _, err := u.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "darwin-amd64") {
		t.Fatalf("err = %v", err)
	}
}

func TestApplyRejectsTamperedArtifacts(t *testing.T) {
	valid := tarGz(t, "lixbon", []byte("binario-nuevo"))
	name := "lixbon-2.4.0-linux-amd64.tar.gz"
	cases := map[string]func(f *fakeRelease){
		"digest del gateway distinto": func(f *fakeRelease) { f.gwDigest = digest([]byte("otro")) },
		"digest de SHA256SUMS distinto": func(f *fakeRelease) {
			f.sums = digest([]byte("otro")) + "  " + name + "\n"
		},
		"SHA256SUMS sin el archivo": func(f *fakeRelease) { f.sums = digest(valid) + "  otro.tar.gz\n" },
		"archivo alterado tras publicar": func(f *fakeRelease) {
			f.archive = tarGz(t, "lixbon", []byte("malicioso"))
		},
		"archivo sin el binario": func(f *fakeRelease) {
			f.archive = tarGz(t, "otra-cosa", []byte("x"))
			f.gwDigest = digest(f.archive)
			f.sums = f.gwDigest + "  " + name + "\n"
		},
		"archivo corrupto": func(f *fakeRelease) {
			f.archive = []byte("no es un tar.gz")
			f.gwDigest = digest(f.archive)
			f.sums = f.gwDigest + "  " + name + "\n"
		},
		"descarga con error HTTP": func(f *fakeRelease) { f.assetErr = http.StatusNotFound },
		"descarga cortada":        func(f *fakeRelease) { f.cutAsset = true },
	}
	for label, mutate := range cases {
		t.Run(label, func(t *testing.T) {
			f := newFake(t, "linux", valid, name)
			mutate(f)
			u, exe := setup(t, f, "linux")
			rel, err := u.Check(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if err := u.Apply(context.Background(), rel); err == nil {
				t.Fatal("Apply debería fallar")
			}
			assertUntouched(t, exe)
		})
	}
}

func TestApplyKeepsBinaryWhenVerifyFails(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("binario-nuevo")), "lixbon-2.4.0-linux-amd64.tar.gz")
	u, exe := setup(t, f, "linux")
	u.Verify = func(context.Context, string, string) error { return fmt.Errorf("no arranca") }
	rel, _ := u.Check(context.Background())
	if err := u.Apply(context.Background(), rel); err == nil || !strings.Contains(err.Error(), "no arranca") {
		t.Fatalf("err = %v", err)
	}
	assertUntouched(t, exe)
}

func TestReplaceWindowsRestoresWhenInstallFails(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "lixbon.exe")
	if err := os.WriteFile(exe, []byte("version-vieja"), 0o755); err != nil {
		t.Fatal(err)
	}
	u := &Updater{GOOS: "windows", Exe: exe}
	if err := u.replace(filepath.Join(filepath.Dir(exe), "no-existe")); err == nil {
		t.Fatal("replace debería fallar")
	}
	assertUntouched(t, exe)
}

func TestInsecureURLsAreRejected(t *testing.T) {
	u := &Updater{HTTP: http.DefaultClient, ManifestURL: "http://example.com/api/updates/cli/beta"}
	if _, err := u.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckRejectsBadDigest(t *testing.T) {
	f := newFake(t, "linux", tarGz(t, "lixbon", []byte("x")), "lixbon-2.4.0-linux-amd64.tar.gz")
	f.gwDigest = "xyz"
	u, _ := setup(t, f, "linux")
	if _, err := u.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("err = %v", err)
	}
}
