package agent

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/toolspec"
)

var ErrNothingToUndo = errors.New("no hay cambios del agente que revertir en esta sesión")

// StreamResult es la respuesta completa de un paso del modelo: el texto, las
// llamadas nativas que haya emitido y su razonamiento (los modelos thinking
// a veces dejan ahí la llamada).
type StreamResult struct {
	Text      string
	ToolCalls []json.RawMessage
	Reasoning string
}

// Streamer envía los mensajes al modelo y devuelve la respuesta completa. La
// interfaz muestra el texto en vivo desde dentro de la implementación.
type Streamer func(ctx context.Context, messages []history.Message, tools []map[string]any) (StreamResult, error)

type Decision int

const (
	Deny Decision = iota
	Allow
	AllowAlways // «siempre»: ya no pregunta más en esta sesión
	AllowPrefix // «siempre para este comando»: guarda el prefijo
)

type ApprovalKind string

const (
	ApproveEdit    ApprovalKind = "edit"
	ApproveCommand ApprovalKind = "command"
	ApproveMCP     ApprovalKind = "mcp"
)

// Approval es lo que se le pide aprobar al usuario (o al móvil, en remoto).
type Approval struct {
	Kind    ApprovalKind
	Tool    string
	Summary string
	Detail  string // ruta y conteo de líneas, para las ediciones
	Prefix  string // prefijo guardable, para los comandos
	Change  *Change
}

// Approver decide. Un error (p. ej. contexto cancelado) aborta el turno.
type Approver interface {
	Approve(ctx context.Context, a Approval) (Decision, error)
}

// MCPClient son las herramientas externas conectadas por MCP.
type MCPClient interface {
	ToolSchemas() []json.RawMessage
	IsMCPTool(name string) bool
	Call(ctx context.Context, name string, args map[string]any) string
}

type EventKind string

const (
	EventNote         EventKind = "note"
	EventAction       EventKind = "action"
	EventActionResult EventKind = "result"
	EventReadGroup    EventKind = "read_group"
	EventRescued      EventKind = "rescued"
)

// Event es lo que el bucle cuenta a la interfaz; no sabe cómo se pinta.
type Event struct {
	Kind     EventKind
	Tool     string
	Text     string // nota o etiqueta de la acción
	Meta     string // medida de una lectura («12 líneas»)
	ReadOnly bool
	Change   *Change
	Adds     int
	Dels     int
	Result   string
	Summary  string
	Check    string
	Failed   bool
	Elapsed  time.Duration
	Names    []string
	Lines    int
}

type TurnStats struct {
	Actions int
	Files   map[string]bool
	Adds    int
	Dels    int
}

// Session es el estado mutable de la conversación con el agente.
type Session struct {
	Workspace string
	Tools     *tools.Toolbox
	Approver  Approver
	MCP       MCPClient
	Estimator *history.Estimator
	// Model es el nombre mostrado al avisar de que no admite herramientas nativas.
	Model string

	AutoApprove     bool
	AutoRunCommands bool
	NativeTools     bool
	PlanMode        bool
	AutoCheck       bool
	AllowedCommands []string
	// OnAllowedCommands persiste la lista cuando el usuario añade un prefijo.
	OnAllowedCommands func([]string)
	ContextWindow     int
	// Ask es un chat sin streaming (compactación del contexto); nil la desactiva.
	Ask func(ctx context.Context, messages []history.Message) (string, error)

	// Working es lo que viaja al modelo en el turno en curso (la barra de
	// contexto mide esto y no el historial).
	Working []history.Message

	Stats          TurnStats
	Checkpoints    []Checkpoint
	UndoIncomplete bool
	UndoStack      [][]Checkpoint

	pendingImages []string
}

func NewSession(workspace string, tb *tools.Toolbox) *Session {
	return &Session{
		Workspace:     workspace,
		Tools:         tb,
		Estimator:     &history.Estimator{},
		NativeTools:   true,
		AutoCheck:     true,
		ContextWindow: 16384,
		Stats:         TurnStats{Files: map[string]bool{}},
	}
}

func (s *Session) popToolImages() []string {
	images := s.pendingImages
	s.pendingImages = nil
	return images
}

func isEditTool(name string) bool { return toolspec.IsEdit(name) }
