package agent

import (
	"fmt"
	"os"
	"path/filepath"

	"lixbon.com/cli/internal/tools"
)

// maxSnapshotBytes evita guardar en memoria archivos enormes para /undo.
const maxSnapshotBytes = 64 << 20

// Checkpoint guarda el estado previo de un archivo que una herramienta va a
// tocar: Before == nil significa que no existía.
type Checkpoint struct {
	Path   string
	Before []byte
}

// SnapshotBefore guarda lo que va a cambiar una herramienta mutante, para
// poder deshacerlo. Las carpetas enteras y los archivos enormes no se guardan
// y marcan el turno como no reversible del todo.
func (s *Session) SnapshotBefore(tool string, args map[string]any) {
	if !tools.IsMutating(tool) {
		return
	}
	paths := []string{stringArg(args, "path")}
	if tool == "rename_file" {
		paths = []string{stringArg(args, "src"), stringArg(args, "dst")}
	}
	for _, rel := range paths {
		if !truthy(rel) {
			continue
		}
		target, _, err := tools.ResolveSafe(s.Workspace, rel)
		if err != nil {
			continue
		}
		info, err := os.Stat(target)
		switch {
		case err != nil:
			s.Checkpoints = append(s.Checkpoints, Checkpoint{Path: rel})
		case info.IsDir(), info.Size() > maxSnapshotBytes:
			s.UndoIncomplete = true
		case info.Mode().IsRegular():
			data, err := os.ReadFile(target)
			if err != nil {
				s.UndoIncomplete = true
				continue
			}
			s.Checkpoints = append(s.Checkpoints, Checkpoint{Path: rel, Before: data})
		}
	}
}

// BeginTurn reinicia los contadores y checkpoints del turno.
func (s *Session) BeginTurn() {
	s.Stats = TurnStats{Files: map[string]bool{}}
	s.Checkpoints = nil
	s.UndoIncomplete = false
}

// EndTurn apila los checkpoints del turno (los últimos 10) para /undo.
func (s *Session) EndTurn() {
	if len(s.Checkpoints) == 0 {
		return
	}
	s.UndoStack = append(s.UndoStack, s.Checkpoints)
	if len(s.UndoStack) > 10 {
		s.UndoStack = s.UndoStack[len(s.UndoStack)-10:]
	}
}

// Undo revierte el último turno apilado: restaura el contenido previo o borra
// lo que se creó. Devuelve una línea por archivo.
func (s *Session) Undo() ([]string, error) {
	if len(s.UndoStack) == 0 {
		return nil, ErrNothingToUndo
	}
	entries := s.UndoStack[len(s.UndoStack)-1]
	done, err := UndoCheckpoints(s.Workspace, entries)
	if err != nil {
		return done, err
	}
	s.UndoStack = s.UndoStack[:len(s.UndoStack)-1]
	return done, nil
}

// UndoCheckpoints deshace en orden inverso.
func UndoCheckpoints(workspace string, entries []Checkpoint) ([]string, error) {
	var done []string
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		target, _, err := tools.ResolveSafe(workspace, e.Path)
		if err != nil {
			return done, err
		}
		if e.Before == nil {
			if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
				if err := os.Remove(target); err != nil {
					return done, err
				}
				done = append(done, "eliminado "+e.Path)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return done, err
		}
		if err := tools.WriteFileAtomic(target, e.Before); err != nil {
			return done, fmt.Errorf("%s: %w", e.Path, err)
		}
		done = append(done, "restaurado "+e.Path)
	}
	return done, nil
}
