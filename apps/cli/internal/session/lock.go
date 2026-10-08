package session

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	lockWait  = 5 * time.Second
	lockStale = 30 * time.Second
	lockPoll  = 15 * time.Millisecond
)

var errLockTimeout = errors.New("el índice de sesiones está ocupado")

// lock serializa las actualizaciones del índice entre procesos con un archivo
// creado en exclusiva, para que dos CLI guardando a la vez no se pisen. Un
// candado olvidado por un proceso muerto caduca a los 30 s.
func (s *Store) lock() (unlock func(), err error) {
	path := filepath.Join(s.Dir, ".index.lock")
	deadline := time.Now().Add(lockWait)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		// En Windows, crear el archivo mientras otro proceso lo está borrando da
		// «acceso denegado» en vez de «ya existe»: es el mismo caso, ocupado.
		if !os.IsExist(err) && !(runtime.GOOS == "windows" && os.IsPermission(err)) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > lockStale {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errLockTimeout
		}
		time.Sleep(lockPoll)
	}
}
