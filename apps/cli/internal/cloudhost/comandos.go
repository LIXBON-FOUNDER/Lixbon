package cloudhost

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/remote"
	"lixbon.com/cli/internal/tools"
)

// Comandos «/» de la sesión en la nube: los del CLI que tienen sentido sin
// terminal, con los mismos nombres. mode, model y diff los resuelve la web
// (guardan el cambio en el gateway o abren un panel); si llegan aquí se
// aplican igual.
type comando struct{ Name, Args, Desc, Group string }

var comandos = []comando{
	{"help", "", "Muestra los comandos", "Conversación"},
	{"model", "<modelo>", "Cambia el modelo", "Conversación"},
	{"mode", "<auto|manual|ask|plan>", "Cambia el modo del agente", "Conversación"},
	{"effort", "<auto|off|low|medium|high>", "Cuánto razona el modelo antes de responder", "Conversación"},
	{"compact", "", "Compacta la conversación para liberar contexto", "Conversación"},
	{"clear", "", "El agente empieza de cero (el hilo sigue a la vista)", "Conversación"},
	{"cost", "", "Contexto usado en esta sesión", "Conversación"},
	{"diff", "", "Abre los cambios de la rama", "Agente"},
	{"status", "", "Rama, commits y cambios sin guardar", "Agente"},
	{"undo", "", "Deshace los archivos que tocó el último turno", "Agente"},
	{"commit", "[mensaje]", "Hace commit; si no das mensaje, lo escribe el modelo", "Agente"},
	{"push", "", "Sube la rama a GitHub", "Agente"},
	{"pr", "[título]", "Sube la rama y abre el PR", "Agente"},
	{"run", "<comando>", "Ejecuta un comando y le pasa la salida al agente", "Agente"},
	{"init", "", "Genera LIXBON.md con el contexto del proyecto", "Agente"},
}

func comandosHello() []map[string]string {
	out := make([]map[string]string, 0, len(comandos))
	for _, c := range comandos {
		out = append(out, map[string]string{"name": c.Name, "args": c.Args, "description": c.Desc, "group": c.Group})
	}
	return out
}

// slashDe separa «/nombre resto». Solo cuenta si el nombre es un comando:
// «/etc/hosts no existe» sigue siendo un mensaje normal.
func slashDe(text string) (string, string, bool) {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "/") {
		return "", "", false
	}
	name, arg, _ := strings.Cut(t[1:], " ")
	name = strings.ToLower(name)
	for _, c := range comandos {
		if c.Name == name {
			return name, strings.TrimSpace(arg), true
		}
	}
	return "", "", false
}

// slash ejecuta un comando. true si ya respondió; false si el turno sigue con
// cmd.Text reescrito (/run le pasa la salida al agente).
func (h *Host) slash(ctx context.Context, cmd *remote.Command) bool {
	name, arg, ok := slashDe(cmd.Text)
	if !ok {
		return false
	}
	if name == "run" && arg != "" {
		out := ejecutar(ctx, h.dir, arg)
		cmd.Text = fmt.Sprintf("He ejecutado `%s` en el entorno. Salida:\n```\n%s\n```", arg, out)
		return false
	}
	h.emit("user_msg", map[string]any{"text": cmd.Text, "origin": "remote", "images": 0, "image_ids": []string{}})
	h.link.Emit("status", map[string]any{"state": "thinking"})
	inicio := time.Now()
	texto := h.comando(ctx, name, arg)
	h.emit("assistant_done", map[string]any{"text": texto, "ms": time.Since(inicio).Milliseconds()})
	h.emitContext()
	h.link.Emit("status", map[string]any{"state": "idle"})
	return true
}

func (h *Host) comando(ctx context.Context, name, arg string) string {
	switch name {
	case "help":
		var b strings.Builder
		b.WriteString("**Comandos de la sesión**\n\n")
		for _, c := range comandos {
			fmt.Fprintf(&b, "- `/%s", c.Name)
			if c.Args != "" {
				b.WriteString(" " + c.Args)
			}
			fmt.Fprintf(&b, "`: %s\n", c.Desc)
		}
		return b.String()
	case "model":
		if arg == "" {
			return "Modelo actual: `" + h.chat.Model + "`. Usa `/model <modelo>` para cambiarlo."
		}
		h.chat.SetModel(arg)
		h.link.Emit("hello", h.hello())
		return "Modelo: `" + arg + "`."
	case "mode":
		switch arg {
		case "auto", "manual", "ask", "plan":
			h.applyMode(arg)
			h.link.Emit("hello", h.hello())
			return "Modo: **" + arg + "** (desde el próximo mensaje)."
		}
		return "Modos: `auto`, `manual`, `ask` o `plan`."
	case "effort":
		switch arg {
		case "auto", "off", "low", "medium", "high":
			h.chat.SetEffort(arg)
			return "Razonamiento: **" + arg + "**."
		}
		return "Niveles: `auto`, `off`, `low`, `medium` o `high`."
	case "compact":
		if err := h.chat.Compact(ctx, 4); err != nil {
			return "No se pudo compactar: " + err.Error()
		}
		_, pct := h.chat.ContextUsage()
		return fmt.Sprintf("Conversación compactada. Contexto en uso: %.0f %%.", pct)
	case "clear":
		h.chat.NewConversation()
		h.refreshContext()
		return "Contexto vacío: el agente empieza de cero. El hilo sigue a la vista y la rama no cambia."
	case "cost":
		tok, pct := h.chat.ContextUsage()
		return fmt.Sprintf("Contexto en uso: **%d tokens** (%.0f %%).", tok, pct)
	case "diff":
		return "Los cambios están en el panel **Cambios** (icono de git arriba a la derecha)."
	case "status":
		return h.estadoGit(ctx)
	case "undo":
		files, err := h.chat.Session.Undo()
		if err != nil {
			return "No hay nada que deshacer: " + err.Error()
		}
		if len(files) == 0 {
			return "El último turno no cambió archivos."
		}
		return "Deshecho. Archivos restaurados:\n\n- `" + strings.Join(files, "`\n- `") + "`"
	case "commit":
		return h.commit(ctx, arg)
	case "push":
		out, err := push(ctx, h.dir)
		if err != nil {
			return "No se pudo subir la rama: " + err.Error()
		}
		return "Rama subida: `" + out + "`."
	case "pr":
		go h.createPR(ctx, arg, "")
		return "Subiendo la rama y abriendo el PR…"
	case "run":
		return "Uso: `/run <comando>`, por ejemplo `/run npm test`."
	case "init":
		return h.initProyecto(ctx)
	}
	return "Comando desconocido. Escribe `/help`."
}

func (h *Host) estadoGit(ctx context.Context) string {
	rama := currentBranch(ctx, h.dir)
	base := h.opts.DefaultBranch
	delante, _ := runGit(ctx, h.dir, "rev-list", "--count", "origin/"+base+"..HEAD")
	sucios, _ := runGit(ctx, h.dir, "status", "--porcelain")
	n := 0
	for _, l := range strings.Split(strings.TrimSpace(sucios), "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return fmt.Sprintf("- Rama: `%s` (desde `%s`)\n- Commits por delante: %s\n- Archivos sin commit: %d\n- Modo: %s · Modelo: `%s`",
		firstNonEmpty(rama, "(sin rama)"), base, firstNonEmpty(strings.TrimSpace(delante), "0"), n, h.modeLabel(), h.chat.Model)
}

func (h *Host) commit(ctx context.Context, msg string) string {
	if _, err := runGit(ctx, h.dir, "add", "-A"); err != nil {
		return "No se pudo preparar el commit: " + err.Error()
	}
	if _, err := runGit(ctx, h.dir, "diff", "--cached", "--quiet"); err == nil {
		return "No hay cambios que guardar."
	}
	if msg == "" {
		stat, _ := runGit(ctx, h.dir, "diff", "--cached", "--stat")
		diff, _ := runGit(ctx, h.dir, "diff", "--cached")
		if len(diff) > 6000 {
			diff = diff[:6000]
		}
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		texto, err := h.client.Chat(c, h.chat.Model, []map[string]any{
			{"role": "system", "content": "Escribe el mensaje de commit para estos cambios: una línea de menos de 70 caracteres, en imperativo y en el idioma del proyecto. Responde SOLO con el mensaje."},
			{"role": "user", "content": stat + "\n\n" + diff},
		}, "lixbon-coding")
		msg = limpiarLinea(texto)
		if err != nil || msg == "" {
			msg = "Cambios de la sesión"
		}
	}
	if _, err := runGit(ctx, h.dir, "commit", "-m", msg); err != nil {
		return "No se pudo hacer el commit: " + err.Error()
	}
	hash, _ := runGit(ctx, h.dir, "rev-parse", "--short", "HEAD")
	return fmt.Sprintf("Commit `%s`: %s", strings.TrimSpace(hash), msg)
}

func (h *Host) initProyecto(ctx context.Context) string {
	destino := filepath.Join(h.dir, "LIXBON.md")
	if _, err := os.Stat(destino); err == nil {
		return "Ya hay un `LIXBON.md` en el repo. Pídele al agente que lo actualice si quieres cambiarlo."
	}
	prompt := "Analiza este proyecto y escribe un LIXBON.md breve (máximo 60 líneas) que sirva " +
		"de contexto permanente para un asistente de código. Incluye: qué es el proyecto, " +
		"stack y estructura, cómo se ejecuta y se prueba, y convenciones que haya que " +
		"respetar. Responde SOLO con el Markdown del archivo, sin explicaciones ni ```.\n\n" +
		"Carpeta: " + filepath.Base(h.dir) + "\nÁrbol:\n" + tools.WorkspaceTree(h.dir, 200)
	texto, err := h.chat.AskQuiet(ctx, []history.Message{history.User(prompt)})
	if err != nil || strings.TrimSpace(texto) == "" {
		return "No se pudo generar LIXBON.md."
	}
	if err := os.WriteFile(destino, []byte(strings.TrimSpace(texto)+"\n"), 0o644); err != nil {
		return "No se pudo escribir LIXBON.md: " + err.Error()
	}
	return "He creado `LIXBON.md` con el contexto del proyecto. Lo verás en **Cambios**."
}

// ejecutar corre un comando del usuario en el repo (máx. 2 min) y recorta la salida.
func ejecutar(ctx context.Context, dir, line string) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "bash", "-lc", line)
	c.Dir = dir
	out, err := c.CombinedOutput()
	s := strings.TrimRight(string(out), "\n")
	if len(s) > 8000 {
		s = "…\n" + s[len(s)-8000:]
	}
	if err != nil {
		s += "\n[" + err.Error() + "]"
	}
	if strings.TrimSpace(s) == "" {
		s = "(sin salida)"
	}
	return s
}

func limpiarLinea(s string) string {
	if i := strings.LastIndex(s, "</think>"); i >= 0 {
		s = s[i+len("</think>"):]
	}
	for _, l := range strings.Split(s, "\n") {
		if l = strings.Trim(strings.TrimSpace(l), "`\"'"); l != "" {
			if len(l) > 100 {
				l = l[:100]
			}
			return l
		}
	}
	return ""
}
