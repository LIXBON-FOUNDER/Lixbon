package history

import (
	"errors"
	"fmt"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

const (
	PromptBudgetRatio    = 0.65
	CharsPerToken        = 3.2
	TokensPerImage       = 800
	MaxToolOutputChars   = 6000
	MaxOldToolOutputChar = 1200
	KeepRecent           = 6
	AutoCompactRatio     = 0.7
	CompactKeepRecent    = 4
)

const (
	clipMark  = "\n…[recortado: %d caracteres omitidos]…\n"
	PruneNote = "[Nota del sistema: los pasos más antiguos de este turno se han " +
		"recortado para no desbordar la ventana de contexto. Si necesitas " +
		"algo de un archivo que ya leíste, vuelve a leerlo.]"
	CompactPrompt = "Resume la conversación anterior para poder continuar el trabajo con el contexto " +
		"limpio. Sé concreto y breve (máximo 500 palabras). Incluye, en este orden:\n" +
		"1. Objetivo del usuario y qué pidió exactamente.\n" +
		"2. Decisiones tomadas y preferencias que expresó.\n" +
		"3. Archivos tocados y qué cambió en cada uno (rutas exactas).\n" +
		"4. Estado actual: qué ya funciona y qué falla (errores literales relevantes).\n" +
		"5. Qué queda pendiente.\n" +
		"Responde SOLO con el resumen."
)

var ErrEmptySummary = errors.New("el modelo no devolvió resumen")

// Estimator convierte caracteres en tokens. Se calibra con el conteo real del
// servidor; mientras no hay medición vale la estimación conservadora.
type Estimator struct {
	calibrated float64
}

func (e *Estimator) CharsPerToken() float64 {
	if e != nil && e.calibrated != 0 {
		return e.calibrated
	}
	return CharsPerToken
}

// Calibrate solo vale si charsSent se midió con PayloadChars sobre el mismo
// payload que produjo promptTokens.
func (e *Estimator) Calibrate(charsSent, promptTokens int) {
	if promptTokens > 50 && charsSent > 200 {
		e.calibrated = max(1.5, min(8.0, float64(charsSent)/float64(promptTokens)))
	}
}

func ImageCount(messages []Message) int {
	n := 0
	for _, m := range messages {
		n += len(m.Images)
	}
	return n
}

// PayloadChars cuenta los caracteres de texto que viajan al modelo, incluido
// el JSON de los tool_calls y las definiciones de herramientas.
func PayloadChars(messages []Message, tools []map[string]any) int {
	chars := 0
	for _, m := range messages {
		chars += utf8.RuneCountInString(m.Content)
		for _, call := range m.ToolCalls {
			chars += reprLen(decodeJSON(call))
		}
		chars += 16
	}
	if len(tools) > 0 {
		chars += reprLen(tools)
	}
	return chars
}

func (e *Estimator) EstimateTokens(messages []Message) int {
	return int(float64(PayloadChars(messages, nil))/e.CharsPerToken()) + TokensPerImage*ImageCount(messages)
}

// ToolsTokens es el coste de las definiciones de herramientas, que Ollama
// inyecta en el template del modelo.
func (e *Estimator) ToolsTokens(tools []map[string]any) int {
	if len(tools) == 0 {
		return 0
	}
	return int(float64(reprLen(tools)) / e.CharsPerToken())
}

// PromptBudget son los tokens disponibles para el historial, descontando el
// system prompt y las herramientas.
func (e *Estimator) PromptBudget(contextWindow int, tools []map[string]any, systemTokens int) int {
	total := int(float64(max(contextWindow, 1)) * PromptBudgetRatio)
	return max(total-e.ToolsTokens(tools)-systemTokens, 512)
}

func (e *Estimator) NeedsCompaction(messages []Message, contextWindow int) bool {
	return e.EstimateTokens(messages) > int(float64(contextWindow)*AutoCompactRatio)
}

// ClipToolOutput recorta por el medio: en un read_file importa el principio y
// en un run_command el final, y así se conservan ambos.
func ClipToolOutput(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	head := int(float64(limit) * 0.6)
	tail := limit - head
	omitted := len(runes) - limit
	return string(runes[:head]) + fmt.Sprintf(clipMark, omitted) + string(runes[len(runes)-tail:])
}

// ShrinkOldResults adelgaza los resultados de herramienta que ya no son
// recientes, conservando la estructura del turno.
func ShrinkOldResults(messages []Message, keepRecent, limit int) []Message {
	if len(messages) <= keepRecent {
		return messages
	}
	cut := len(messages) - keepRecent
	out := make([]Message, len(messages))
	for i, m := range messages {
		if i < cut && m.IsToolResult() && utf8.RuneCountInString(m.Content) > limit {
			m.Content = ClipToolOutput(m.Content, limit)
		}
		out[i] = m
	}
	return out
}

// safeStart devuelve el primer índice >= index que no deja huérfano un
// resultado de herramienta (sin su assistant el template del modelo falla).
func safeStart(messages []Message, index int) int {
	for index < len(messages) && messages[index].IsToolResult() {
		index++
	}
	return index
}

// FitHistory poda el historial hasta que cabe en el presupuesto: primero
// adelgaza resultados antiguos, luego suelta mensajes viejos conservando
// siempre la petición original y, como último recurso, solo los últimos.
func (e *Estimator) FitHistory(messages []Message, budget, keepRecent int) ([]Message, bool) {
	if budget <= 0 || len(messages) == 0 {
		return messages, false
	}
	working := ShrinkOldResults(messages, keepRecent, MaxOldToolOutputChar)
	if e.EstimateTokens(working) <= budget {
		return working, !equal(working, messages)
	}

	var head []Message
	start := 0
	if working[0].Role == "user" {
		head = []Message{working[0], User(PruneNote)}
		start = 1
	}
	headTokens := e.EstimateTokens(head)
	for start < len(working) {
		start = safeStart(working, start)
		tail := working[start:]
		if len(tail) == 0 {
			break
		}
		if headTokens+e.EstimateTokens(tail) <= budget {
			return append(append([]Message{}, head...), tail...), true
		}
		start++
	}

	// Python usa working[-keep_recent:], que con keep_recent=0 es la lista entera.
	tail := working
	if keepRecent > 0 && len(working) > keepRecent {
		tail = working[len(working)-keepRecent:]
	}
	tail = ShrinkOldResults(tail, 0, MaxOldToolOutputChar)
	note := []Message{User(PruneNote)}
	first := safeStart(tail, 0)
	for first < len(tail) && e.EstimateTokens(append(append([]Message{}, note...), tail[first:]...)) > budget {
		first = safeStart(tail, first+1)
	}
	if first < len(tail) {
		tail = tail[first:]
	} else {
		tail = tail[safeStart(tail, 0):]
	}
	if len(tail) > 0 {
		return append(note, tail...), true
	}
	return working, true
}

// CompactMessages sustituye lo antiguo por un resumen del modelo y conserva
// los últimos mensajes intactos. ask es un chat sin streaming.
func CompactMessages(messages []Message, ask func([]Message) (string, error), keepRecent int) ([]Message, error) {
	var plain []Message
	for _, m := range messages {
		if m.Role == "tool" {
			continue
		}
		m.ToolCalls = nil
		if textutil.Strip(m.Content) == "" {
			continue
		}
		plain = append(plain, m)
	}
	if len(plain) <= keepRecent {
		return messages, nil
	}
	cut := safeStart(plain, max(0, len(plain)-keepRecent))
	old, recent := plain[:cut], plain[cut:]
	request := append(append([]Message{}, old...), User(CompactPrompt))
	summary, err := ask(request)
	if err != nil {
		return nil, err
	}
	summary = textutil.Strip(summary)
	if summary == "" {
		return nil, ErrEmptySummary
	}
	out := []Message{
		User("Resumen de lo hablado hasta ahora (la conversación se compactó para liberar contexto):\n" + summary),
		Assistant("Entendido, sigo desde ahí."),
	}
	return append(out, recent...), nil
}
