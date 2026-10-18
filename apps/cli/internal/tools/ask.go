package tools

import (
	"context"
	"fmt"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

// MaxQuestions es el tope de preguntas de una tanda de ask_user.
const MaxQuestions = 4

// maxChoices es el tope de opciones de cada pregunta.
const maxChoices = 6

// Question es una pregunta de ask_user. Con opciones se elige una (o varias si
// Multiple); siempre cabe escribir otra respuesta.
type Question struct {
	Header   string
	Text     string
	Options  []Choice
	Multiple bool
}

// Choice es una opción cerrada de una pregunta.
type Choice struct {
	Label       string
	Description string
}

// Unanswered es lo que recibe el modelo por una pregunta que el usuario dejó
// sin responder.
const Unanswered = "(sin responder: decide tú con tu mejor criterio)"

// AskQuestions lee las preguntas de una llamada a ask_user: la tanda en
// questions o, como atajo, una sola en question y options.
func AskQuestions(args map[string]any) []Question {
	var out []Question
	if list, ok := args["questions"].([]any); ok {
		for _, item := range list {
			if q, ok := item.(map[string]any); ok {
				out = appendQuestion(out, q)
			}
		}
	}
	if len(out) == 0 {
		out = appendQuestion(out, args)
	}
	return out[:min(len(out), MaxQuestions)]
}

func appendQuestion(out []Question, q map[string]any) []Question {
	text := textutil.Strip(firstString(q, "question", "text"))
	if text == "" {
		return out
	}
	question := Question{
		Text:     text,
		Header:   textutil.Strip(firstString(q, "header", "title")),
		Multiple: isTrue(q["multiple"]) || isTrue(q["multiSelect"]) || isTrue(q["multi_select"]),
	}
	options, _ := q["options"].([]any)
	for _, o := range options {
		var c Choice
		switch v := o.(type) {
		case map[string]any:
			c = Choice{Label: textutil.Strip(firstString(v, "label", "value", "text")), Description: textutil.Strip(firstString(v, "description", "desc"))}
		default:
			c = Choice{Label: textutil.Strip(pyStr(v))}
		}
		if c.Label != "" && len(question.Options) < maxChoices {
			question.Options = append(question.Options, c)
		}
	}
	return append(out, question)
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// isTrue es un sí explícito: true o "true".
func isTrue(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(x, "true")
	}
	return false
}

// AskSummary es lo que dice la fila «Preguntar»: la pregunta, o cuántas son.
func AskSummary(args map[string]any) string {
	switch qs := AskQuestions(args); len(qs) {
	case 0:
		return ""
	case 1:
		return qs[0].Text
	default:
		return fmt.Sprintf("%d preguntas", len(qs))
	}
}

func (tb *Toolbox) askUser(ctx context.Context, args map[string]any) string {
	if tb.AskUser == nil || tb.Remote {
		return "[ask_user no disponible en esta sesión] Termina el turno formulando la pregunta al " +
			"usuario en tu respuesta y espera su mensaje."
	}
	questions := AskQuestions(args)
	if len(questions) == 0 {
		return "[ERROR] Falta question"
	}
	answers, _ := tb.AskUser(ctx, questions)
	return AnswersText(questions, answers)
}

// AnswersText es el resultado de ask_user que recibe el modelo; ParseAnswers
// lo vuelve a leer para enseñarlo al reabrir la conversación.
func AnswersText(questions []Question, answers []string) string {
	answered := 0
	for i := range questions {
		if i < len(answers) && strings.TrimSpace(answers[i]) != "" {
			answered++
		}
	}
	if answered == 0 {
		return "El usuario no respondió (canceló). Sigue con tu mejor criterio o termina el turno."
	}
	if len(questions) == 1 {
		return "Respuesta del usuario: " + strings.TrimSpace(answers[0])
	}
	var b strings.Builder
	b.WriteString("Respuestas del usuario:")
	for i, q := range questions {
		answer := Unanswered
		if i < len(answers) && strings.TrimSpace(answers[i]) != "" {
			answer = strings.TrimSpace(answers[i])
		}
		b.WriteString("\n- ")
		if q.Header != "" {
			b.WriteString("[" + q.Header + "] ")
		}
		b.WriteString(q.Text + " → " + answer)
	}
	return b.String()
}

// Answer es una respuesta leída de vuelta del resultado de ask_user. Label es
// el título de su pregunta (vacío si era una sola).
type Answer struct {
	Label, Text string
	Missing     bool
}

// ParseAnswers lee el resultado de ask_user; ok es false si no lo es.
func ParseAnswers(result string) (answers []Answer, cancelled, ok bool) {
	result = strings.TrimSpace(result)
	switch {
	case strings.HasPrefix(result, "El usuario no respondió"):
		return nil, true, true
	case strings.HasPrefix(result, "Respuesta del usuario: "):
		return []Answer{{Text: strings.TrimPrefix(result, "Respuesta del usuario: ")}}, false, true
	case !strings.HasPrefix(result, "Respuestas del usuario:"):
		return nil, false, false
	}
	for _, line := range strings.Split(result, "\n")[1:] {
		line, found := strings.CutPrefix(line, "- ")
		if !found {
			continue
		}
		question, text, _ := strings.Cut(line, " → ")
		label := question
		if rest, found := strings.CutPrefix(question, "["); found {
			if h, _, found := strings.Cut(rest, "] "); found {
				label = h
			}
		}
		answers = append(answers, Answer{Label: label, Text: text, Missing: text == Unanswered})
	}
	return answers, false, true
}
