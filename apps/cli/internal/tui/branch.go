package tui

import (
	"context"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

const newBranchValue = "\x01new"

type branchRef struct {
	name, when string
	remote     bool
}

// branches son las ramas locales (la más reciente primero) y las remotas que
// aún no tienen copia local.
func (m *Model) branches(ctx context.Context) ([]branchRef, string, bool) {
	code, out := m.git(ctx, 10*time.Second, "for-each-ref", "--sort=-committerdate",
		"--format=%(refname)%09%(committerdate:relative)", "refs/heads", "refs/remotes")
	if code != 0 {
		return nil, strings.TrimSpace(out), false
	}
	var local, remote []branchRef
	have := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		ref, when, _ := strings.Cut(line, "\t")
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			name := strings.TrimPrefix(ref, "refs/heads/")
			have[name] = true
			local = append(local, branchRef{name: name, when: when})
		case strings.HasPrefix(ref, "refs/remotes/") && !strings.HasSuffix(ref, "/HEAD"):
			remote = append(remote, branchRef{name: strings.TrimPrefix(ref, "refs/remotes/"), when: when, remote: true})
		}
	}
	for _, r := range remote {
		if _, short, ok := strings.Cut(r.name, "/"); ok && !have[short] {
			have[short] = true
			local = append(local, r)
		}
	}
	return local, "", true
}

func (m *Model) cmdBranch(arg string) tea.Cmd {
	if m.repoRoot == "" {
		m.add(note(shortPath(m.chat.Workspace) + " no es un repositorio git."))
		return nil
	}
	if arg = strings.TrimSpace(arg); arg != "" {
		return m.switchBranch(arg, false)
	}
	return m.async("leyendo ramas", func(ctx context.Context) cmdDoneMsg {
		refs, problem, ok := m.branches(ctx)
		if !ok {
			return cmdDoneMsg{lines: []block{errLine("git no pudo listar las ramas: " + problem)}}
		}
		return cmdDoneMsg{apply: func(m *Model) { m.branchPicker(refs) }}
	})
}

func (m *Model) branchPicker(refs []branchRef) {
	options := make([]option, 0, len(refs)+1)
	cursor := 0
	for _, r := range refs {
		o := option{Label: r.name, Value: r.name, Meta: sDim.Render(r.when)}
		if r.remote {
			o.Desc = "remota"
		}
		if r.name == m.branch {
			o.Badge, cursor = "actual", len(options)
		}
		options = append(options, o)
	}
	options = append(options, option{Label: "+ rama nueva", Value: newBranchValue, Desc: "crearla desde " + firstNonEmpty(m.branch, "HEAD")})
	p := newPicker("Ramas "+glyphSep+" "+shortPath(m.repoRoot), options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
			return nil
		case value == newBranchValue:
			m.promptFor("Nombre de la rama nueva", func(name string) tea.Cmd { return m.switchBranch(strings.TrimSpace(name), true) })
			return nil
		case value == m.branch:
			m.add(note("Ya estás en " + value + "."))
			return nil
		}
		return m.switchBranch(value, false)
	})
	p.search, p.maxShown, p.cursor = true, 14, cursor
	p.keys = [][2]string{{"escribe", "filtra"}, {"↑↓", "mover"}, {"↵", "cambiar"}, {"esc", "salir"}}
	m.picker = p
}

// switchBranch cambia de rama con git switch: una remota crea su copia local
// con seguimiento. Si hay cambios que lo impiden, git lo explica y no se toca nada.
func (m *Model) switchBranch(name string, create bool) tea.Cmd {
	if name == "" {
		return nil
	}
	if m.running {
		// Cambiar los archivos bajo los pies del agente le haría editar otra rama.
		m.add(note("El agente está trabajando en estos archivos: cambia a " + name + " cuando termine, o interrúmpelo con esc."))
		return nil
	}
	args := []string{"switch", name}
	if create {
		args = []string{"switch", "-c", name}
	}
	return m.async("cambiando a "+name, func(ctx context.Context) cmdDoneMsg {
		code, out := m.git(ctx, 30*time.Second, args...)
		if code != 0 && !create {
			if remote, _ := m.git(ctx, 10*time.Second, "show-ref", "--verify", "--quiet", "refs/remotes/"+name); remote == 0 {
				_, short, _ := strings.Cut(name, "/")
				code, out = m.git(ctx, 30*time.Second, "switch", "-c", short, "--track", name)
			}
		}
		if code != 0 {
			return cmdDoneMsg{lines: []block{errLine("No se pudo cambiar de rama:"), textBlock(sDim.Render(strings.TrimSpace(out)))}}
		}
		return cmdDoneMsg{apply: func(m *Model) {
			m.refreshGit()
			m.files = nil
			m.add(okLine("Rama: " + m.branch))
		}}
	})
}
