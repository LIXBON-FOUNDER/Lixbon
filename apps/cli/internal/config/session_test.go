package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func savedConfig(t *testing.T) Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := Save(path, Default()); err != nil {
		t.Fatal(err)
	}
	return Load(path)
}

func session(server string) StoredSession {
	return StoredSession{Server: server, Access: "lixbon_at_a", Refresh: "lixbon_rt_a", ExpiresAt: time.Now()}
}

func TestEachProfileKeepsItsOwnSession(t *testing.T) {
	cfg := savedConfig(t)
	path := cfg.SessionFile()
	if err := WriteSession(path, "lixbon", session("https://lixbon.com")); err != nil {
		t.Fatal(err)
	}
	if err := WriteSession(path, "staging", session("https://staging.lixbon.com")); err != nil {
		t.Fatal(err)
	}
	if s, ok := cfg.ActiveSession(); !ok || s.Server != "https://lixbon.com" {
		t.Fatalf("sesión activa: %+v %v", s, ok)
	}
	if err := RemoveSession(path, "lixbon"); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadSession(path, "staging"); !ok {
		t.Fatal("borrar un perfil no toca los demás")
	}
	if err := RemoveSession(path, "staging"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("sin sesiones el archivo desaparece: %v", err)
	}
}

func TestASessionForAnotherServerIsIgnored(t *testing.T) {
	cfg := savedConfig(t)
	_ = WriteSession(cfg.SessionFile(), cfg.ActiveProfile(), session("https://otro.example"))
	if _, ok := cfg.ActiveSession(); ok {
		t.Fatal("la sesión de otro servidor no vale para este perfil")
	}
}

func TestAConfigWithoutFileHasNoSessions(t *testing.T) {
	cfg := Default()
	if cfg.SessionFile() != "" {
		t.Fatal("sin archivo no hay sessions.json")
	}
	if err := WriteSession(cfg.SessionFile(), "lixbon", session("x")); err == nil {
		t.Fatal("no se puede guardar sin ruta")
	}
}

func TestTheSessionsFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("los permisos POSIX no aplican en Windows")
	}
	cfg := savedConfig(t)
	_ = WriteSession(cfg.SessionFile(), "lixbon", session("https://lixbon.com"))
	info, err := os.Stat(cfg.SessionFile())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("permisos %v err %v", info.Mode().Perm(), err)
	}
}
