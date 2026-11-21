package cloudhost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const (
	branchPrefix = "lixbon/"
	maxTree      = 5000
	maxDiffBytes = 400 << 10
)

// runGit ejecuta git en dir y devuelve la salida. La autenticación con el
// proxy git del gateway llega por entorno (GIT_CONFIG_*), nunca por argumentos.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errOut.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), errors.New(msg)
	}
	return out.String(), nil
}

// clone deja el repo en dir. Si ya está (una sesión que se reanuda), no hace nada.
func clone(ctx context.Context, remoteURL, dir string) error {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	// blob:none: la historia entera sin los archivos viejos; rápido en repos grandes.
	_, err := runGit(ctx, filepath.Dir(dir), "clone", "--filter=blob:none", "--no-tags", remoteURL, filepath.Base(dir))
	return err
}

func currentBranch(ctx context.Context, dir string) string {
	out, err := runGit(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

var noSlug = regexp.MustCompile(`[^a-z0-9]+`)

// branchName es la rama de trabajo a partir del primer mensaje:
// «Añade códigos de descuento al carrito» → lixbon/anade-codigos-de-descuento.
func branchName(prompt string) string {
	t := norm.NFD.String(strings.ToLower(prompt))
	t = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Mn, r) {
			return -1
		}
		return r
	}, t)
	t = strings.Trim(noSlug.ReplaceAllString(t, "-"), "-")
	words := strings.Split(t, "-")
	slug := ""
	for _, w := range words {
		if w == "" {
			continue
		}
		next := w
		if slug != "" {
			next = slug + "-" + w
		}
		if len(next) > 40 {
			break
		}
		slug = next
	}
	if slug == "" {
		slug = "sesion-" + strconv.FormatInt(time.Now().Unix()%100000, 10)
	}
	return branchPrefix + slug
}

// limpiarNombreRama se queda con la primera línea útil de lo que propuso el
// modelo (sin razonamiento, comillas ni prefijo). Vacía o larguísima → la tarea.
func limpiarNombreRama(propuesta, tarea string) string {
	if i := strings.LastIndex(propuesta, "</think>"); i >= 0 {
		propuesta = propuesta[i+len("</think>"):]
	}
	for _, l := range strings.Split(propuesta, "\n") {
		l = strings.Trim(strings.TrimSpace(l), "`'\"*. ")
		l = strings.TrimPrefix(strings.ToLower(l), branchPrefix)
		if l == "" {
			continue
		}
		if len(strings.Fields(l)) > 6 || len(l) > 60 {
			break
		}
		return l
	}
	return tarea
}

// ensureBranch deja el repo en una rama lixbon/…: la actual si ya lo es (al
// reanudar) o una nueva a partir del primer mensaje. Si el nombre ya existe en
// el remoto, añade un sufijo.
func ensureBranch(ctx context.Context, dir, prompt string) (string, error) {
	if b := currentBranch(ctx, dir); strings.HasPrefix(b, branchPrefix) {
		return b, nil
	}
	base := branchName(prompt)
	name := base
	for i := 2; i < 50; i++ {
		if _, err := runGit(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+name); err != nil {
			break
		}
		name = fmt.Sprintf("%s-%d", base, i)
	}
	if _, err := runGit(ctx, dir, "switch", "-c", name); err != nil {
		return "", err
	}
	return name, nil
}

// push sube la rama de trabajo. El proxy git del gateway rechaza cualquier
// otra cosa que no sea refs/heads/lixbon/….
func push(ctx context.Context, dir string) (string, error) {
	b := currentBranch(ctx, dir)
	if !strings.HasPrefix(b, branchPrefix) {
		return "", fmt.Errorf("la rama actual (%s) no es una rama de la sesión", b)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if _, err := runGit(ctx, dir, "push", "-u", "origin", "HEAD:refs/heads/"+b); err != nil {
		return "", err
	}
	return b, nil
}

// diffFiles son los cambios de la sesión respecto a la rama por defecto
// (commits de la rama + lo que aún no está en un commit), para el panel Cambios.
func diffFiles(ctx context.Context, dir, defaultBranch string) ([]map[string]any, bool) {
	base := "origin/" + defaultBranch
	if mb, err := runGit(ctx, dir, "merge-base", "HEAD", base); err == nil {
		base = strings.TrimSpace(mb)
	}
	// Lo nuevo sin seguimiento también cuenta: intent-to-add no toca el contenido.
	_, _ = runGit(ctx, dir, "add", "--intent-to-add", "--all")
	stat, _ := runGit(ctx, dir, "diff", "--numstat", base)
	names, _ := runGit(ctx, dir, "diff", "--name-status", base)
	status := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(names), "\n") {
		if f := strings.Fields(l); len(f) >= 2 {
			status[f[len(f)-1]] = string(f[0][0])
		}
	}
	files := []map[string]any{}
	total := 0
	truncated := false
	for _, l := range strings.Split(strings.TrimSpace(stat), "\n") {
		f := strings.SplitN(l, "\t", 3)
		if len(f) != 3 {
			continue
		}
		adds, _ := strconv.Atoi(f[0])
		dels, _ := strconv.Atoi(f[1])
		path := f[2]
		patch := ""
		if total < maxDiffBytes {
			patch, _ = runGit(ctx, dir, "diff", "--no-color", "-U3", base, "--", path)
			if total+len(patch) > maxDiffBytes {
				patch = patch[:maxDiffBytes-total]
				truncated = true
			}
			total += len(patch)
		} else {
			truncated = true
		}
		files = append(files, map[string]any{"path": path, "status": firstNonEmpty(status[path], "M"),
			"adds": adds, "dels": dels, "binary": f[0] == "-", "patch": patch})
	}
	return files, truncated
}

// treeEntries son los archivos del workspace que ve git (con los nuevos sin
// seguimiento y sin los ignorados), marcados si cambiaron.
func treeEntries(ctx context.Context, dir string) ([]map[string]string, bool) {
	out, _ := runGit(ctx, dir, "ls-files", "--cached", "--others", "--exclude-standard")
	changed := map[string]string{}
	if st, err := runGit(ctx, dir, "status", "--porcelain"); err == nil {
		for _, l := range strings.Split(st, "\n") {
			if len(l) > 3 {
				code := strings.TrimSpace(l[:2])
				if code == "??" {
					code = "A"
				}
				changed[strings.TrimSpace(l[3:])] = code[:1]
			}
		}
	}
	var entries []map[string]string
	for _, p := range strings.Split(strings.TrimSpace(out), "\n") {
		if p == "" {
			continue
		}
		if len(entries) == maxTree {
			return entries, true
		}
		entries = append(entries, map[string]string{"path": p, "status": changed[p]})
	}
	return entries, false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// PushBranch sube la rama de trabajo de la sesión (lixbon pr).
func PushBranch(ctx context.Context, o Options) (string, error) {
	return push(ctx, filepath.Join(o.Root, repoName(o.Repo)))
}
