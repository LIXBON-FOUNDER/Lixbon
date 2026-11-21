package cloudhost

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Datos de los paneles de la web (solo lectura): contenido de un archivo,
// commits de la rama y comandos en segundo plano.

const maxArchivo = 512 << 10

// rutaSegura resuelve una ruta relativa al repo sin salirse de él ni entrar en .git.
func rutaSegura(dir, rel string) (string, error) {
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	if rel == "" || strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) {
		return "", errors.New("ruta no válida")
	}
	limpia := filepath.Clean(filepath.FromSlash(rel))
	if limpia == "." || strings.HasPrefix(limpia, "..") {
		return "", errors.New("ruta fuera del repositorio")
	}
	partes := strings.Split(filepath.ToSlash(limpia), "/")
	if partes[0] == ".git" {
		return "", errors.New("ruta no válida")
	}
	abs := filepath.Join(dir, limpia)
	// Un enlace simbólico no puede sacar la lectura del repo.
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		base, _ := filepath.EvalSymlinks(dir)
		if base == "" {
			base = dir
		}
		if r, err := filepath.Rel(base, real); err != nil || strings.HasPrefix(r, "..") {
			return "", errors.New("ruta fuera del repositorio")
		}
	}
	return abs, nil
}

// leerArchivo devuelve el texto del archivo (recortado) o marca si es binario.
func leerArchivo(dir, rel string) map[string]any {
	out := map[string]any{"path": rel}
	abs, err := rutaSegura(dir, rel)
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		out["error"] = "no se encontró el archivo"
		return out
	}
	out["size"] = info.Size()
	f, err := os.Open(abs)
	if err != nil {
		out["error"] = "no se pudo leer"
		return out
	}
	defer f.Close()
	buf := make([]byte, maxArchivo+1)
	n, _ := f.Read(buf)
	buf = buf[:n]
	if bytes.IndexByte(buf[:min(n, 8000)], 0) >= 0 {
		out["binary"] = true
		return out
	}
	if n > maxArchivo {
		buf, out["truncated"] = buf[:maxArchivo], true
	}
	out["text"] = string(buf)
	return out
}

// commits de la rama desde la base, con si la rama ya está subida.
func commitsDeRama(ctx context.Context, dir, base string) map[string]any {
	rango := "origin/" + base + "..HEAD"
	raw, _ := runGit(ctx, dir, "log", "--format=%h%x1f%s%x1f%cI", "-n", "50", rango)
	items := []map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(raw), "\n") {
		p := strings.Split(l, "\x1f")
		if len(p) == 3 {
			items = append(items, map[string]string{"hash": p[0], "subject": p[1], "date": p[2]})
		}
	}
	rama := currentBranch(ctx, dir)
	subida := false
	if head, err := runGit(ctx, dir, "rev-parse", "HEAD"); err == nil && rama != "" {
		if remoto, err := runGit(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+rama); err == nil {
			subida = strings.TrimSpace(head) == strings.TrimSpace(remoto)
		}
	}
	return map[string]any{"items": items, "branch": rama, "base": base, "pushed": subida}
}

// procesos en segundo plano del agente (npm run dev, servidores…).
func (h *Host) procesos() []map[string]any {
	items := []map[string]any{}
	if h.chat == nil || h.chat.Toolbox == nil || h.chat.Toolbox.Procs == nil {
		return items
	}
	for _, p := range h.chat.Toolbox.Procs.List() {
		items = append(items, map[string]any{"id": p.ID, "command": p.Command, "alive": p.Alive,
			"started": p.Started.UTC().Format(time.RFC3339)})
	}
	return items
}

func (h *Host) emitProcesos() {
	h.emit("procs", map[string]any{"items": h.procesos()})
}
