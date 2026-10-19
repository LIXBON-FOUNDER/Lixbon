package events

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// FileStore guarda el último cursor confirmado de un seguimiento. Es estado
// propio del cliente (una línea con el seq), no del Core.
type FileStore struct{ Path string }

// StorePath separa los cursores por tarea y por filtros: un cursor solo vale
// para la misma consulta. `limit` no cambia qué eventos se leen.
func StorePath(dir, taskID string, params map[string]string) string {
	names := make([]string, 0, len(params))
	for name := range params {
		if name != "limit" {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	var key strings.Builder
	key.WriteString(taskID)
	for _, name := range names {
		fmt.Fprintf(&key, "\x00%s=%s", name, params[name])
	}
	sum := sha256.Sum256([]byte(key.String()))
	return filepath.Join(dir, hex.EncodeToString(sum[:8])+".cursor")
}

func (s FileStore) Load() (int64, bool, error) {
	raw, err := os.ReadFile(s.Path)
	if os.IsNotExist(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	cursor, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || cursor < 0 {
		return 0, false, fmt.Errorf("%s no contiene un cursor válido", filepath.Base(s.Path))
	}
	return cursor, true, nil
}

func (s FileStore) Save(cursor int64) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.Path), ".cursor-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = fmt.Fprintf(tmp, "%d\n", cursor)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, s.Path)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}
