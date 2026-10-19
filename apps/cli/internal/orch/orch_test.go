package orch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDiscovery(t *testing.T, dir string, d discovery) {
	t.Helper()
	raw, _ := json.Marshal(d)
	if err := os.WriteFile(filepath.Join(dir, discoveryFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func fakeLxo(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "lxo.exe")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func isolate(t *testing.T, listening bool) {
	t.Helper()
	t.Setenv(envLxo, "")
	t.Setenv("PATH", t.TempDir())
	previous := dialPort
	dialPort = func(int) bool { return listening }
	t.Cleanup(func() { dialPort = previous })
}

func TestDiscoverDisponible(t *testing.T) {
	isolate(t, true)
	dir, lxo := t.TempDir(), fakeLxo(t)
	writeDiscovery(t, dir, discovery{Port: 4000, Lxo: lxo})
	info := Discover(dir)
	if !info.Available() || info.Lxo != lxo || info.Problem != "" {
		t.Fatalf("debería estar disponible: %+v", info)
	}
}

func TestDiscoverSinDesktopAbierto(t *testing.T) {
	isolate(t, false)
	info := Discover(t.TempDir())
	if info.Available() || info.Problem != problemClosed {
		t.Fatalf("sin orch.json: %+v", info)
	}
}

func TestDiscoverArchivoViejoSinServidor(t *testing.T) {
	isolate(t, false)
	dir := t.TempDir()
	writeDiscovery(t, dir, discovery{Port: 4000, Lxo: fakeLxo(t)})
	info := Discover(dir)
	if info.Available() || info.Running || info.Problem != problemStale {
		t.Fatalf("orch.json sin servidor: %+v", info)
	}
}

func TestDiscoverSinLxo(t *testing.T) {
	isolate(t, true)
	dir := t.TempDir()
	writeDiscovery(t, dir, discovery{Port: 4000, Lxo: filepath.Join(dir, "no-existe")})
	info := Discover(dir)
	if info.Available() || info.Problem != problemNoLxo {
		t.Fatalf("lxo publicado que no existe: %+v", info)
	}
}

func TestDiscoverVariableDeEntornoGana(t *testing.T) {
	isolate(t, true)
	dir, published, custom := t.TempDir(), fakeLxo(t), fakeLxo(t)
	t.Setenv(envLxo, custom)
	writeDiscovery(t, dir, discovery{Port: 4000, Lxo: published})
	if got := Discover(dir).Lxo; got != custom {
		t.Fatalf("LXO_BIN debe mandar: %q", got)
	}
}

func TestDiscoverJSONCorruptoNoRompe(t *testing.T) {
	isolate(t, true)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, discoveryFile), []byte("{no es json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if info := Discover(dir); info.Available() || info.Problem != problemClosed {
		t.Fatalf("json corrupto: %+v", info)
	}
}

func TestIsLxoCommand(t *testing.T) {
	info := Info{Lxo: `C:\Program Files\Lixbon\lxo.exe`}
	cases := map[string]bool{
		`"C:\Program Files\Lixbon\lxo.exe" list`:           true,
		`"c:\program files\lixbon\LXO.EXE" spawn --role x`: true,
		`lxo wait --timeout-ms 540000`:                     true,
		`  lxo list  `:                                     true,
		`lxo list && rm -rf x`:                             false,
		`lxo list | findstr a`:                             false,
		`lxo list; del x`:                                  false,
		`lxo spawn --spec "$(whoami)"`:                     false,
		"lxo list\nrm x":                                   false,
		`lxo spawn --spec "a > b"`:                         false,
		`lxox list`:                                        false,
		`npm test`:                                         false,
		``:                                                 false,
	}
	for command, want := range cases {
		if got := info.IsLxoCommand(command); got != want {
			t.Errorf("IsLxoCommand(%q) = %v, quería %v", command, got, want)
		}
	}
	if (Info{}).IsLxoCommand("lxo list") {
		t.Error("sin lxo encontrado no se aprueba nada")
	}
}

func TestPromptSectionCitaLaRutaYLaAprobacionHumana(t *testing.T) {
	text := PromptSection(Info{Lxo: `C:\x y\lxo.exe`})
	for _, want := range []string{`"C:\x y\lxo.exe" guide coordinator`, "/orchestrate", "aprueba una persona", "sin encadenar"} {
		if !strings.Contains(text, want) {
			t.Errorf("falta %q en:\n%s", want, text)
		}
	}
}
