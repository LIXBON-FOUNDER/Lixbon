package tui

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/api"
)

// quotaState es la cuota de la cuenta (sesión de 4 h y semana): es de la
// cuenta, no de la conversación, así que va en la barra superior.
type quotaState struct{ session, week api.Bucket }

type quotaMsg struct {
	usage api.Usage
	err   error
}

func (m *Model) fetchQuota() tea.Cmd {
	if m.chat.Client.Generic || m.chat.Cfg.APIKey == "" {
		return nil
	}
	client := m.chat.Client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		u, err := client.Usage(ctx)
		return quotaMsg{u, err}
	}
}

func (m *Model) applyQuota(msg quotaMsg) {
	if msg.err != nil {
		return
	}
	m.quota = &quotaState{msg.usage.Buckets.Session, msg.usage.Buckets.Week}
}

// quotaLabel es «sesión 12% · semana 30%»; short la deja en «12% · 30%».
func (m *Model) quotaLabel(short bool) string {
	q := m.quota
	if q == nil || m.chat.Client.Generic || q.session.Unlimited && q.week.Unlimited {
		return ""
	}
	part := func(name string, b api.Bucket) string {
		if b.Unlimited {
			return ""
		}
		pct := min(100, int(b.Percent+0.5))
		style := sSoft
		switch {
		case float64(pct) >= ctxFull:
			style = sErr
		case float64(pct) >= ctxWarn:
			style = sWarn
		}
		text := style.Render(fmt.Sprintf("%d%%", pct))
		if !short {
			text = sDim.Render(name+" ") + text
		}
		return text
	}
	var parts []string
	for _, p := range []string{part("sesión", q.session), part("semana", q.week)} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sDim2.Render(" " + glyphSep + " ")
		}
		out += p
	}
	return out
}
