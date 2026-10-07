package tui

import (
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
)

// printer entrega al programa, en orden, lo que va al scrollback de la
// terminal. Los comandos de Bubble Tea corren cada uno en su goroutine y no
// garantizan el orden; una sola goroutine sí. Con la pantalla alternativa
// abierta Bubble Tea descarta lo impreso, así que hold lo retiene.
type printer struct {
	send func(tea.Msg)

	mu    sync.Mutex
	idle  *sync.Cond
	queue []tea.Msg
	held  bool
	busy  bool
	stop  bool
	wake  chan struct{}
}

func newPrinter(send func(tea.Msg)) *printer {
	p := &printer{send: send, wake: make(chan struct{}, 1)}
	p.idle = sync.NewCond(&p.mu)
	go p.run()
	return p
}

func (p *printer) put(msg tea.Msg) {
	p.mu.Lock()
	p.queue = append(p.queue, msg)
	p.mu.Unlock()
	p.notify()
}

func (p *printer) notify() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *printer) hold(held bool) {
	p.mu.Lock()
	p.held = held
	p.mu.Unlock()
	p.notify()
}

func (p *printer) close() {
	p.mu.Lock()
	p.stop = true
	p.idle.Broadcast()
	p.mu.Unlock()
	p.notify()
}

func (p *printer) run() {
	for range p.wake {
		for {
			p.mu.Lock()
			if p.stop {
				p.mu.Unlock()
				return
			}
			if p.held || len(p.queue) == 0 {
				p.mu.Unlock()
				break
			}
			msg := p.queue[0]
			p.queue = p.queue[1:]
			p.busy = true
			p.mu.Unlock()

			if pause, ok := msg.(time.Duration); ok {
				time.Sleep(pause)
			} else {
				p.send(msg)
			}

			p.mu.Lock()
			p.busy = false
			p.idle.Broadcast()
			p.mu.Unlock()
		}
	}
}

// flush espera a que todo lo encolado haya llegado al programa, con un tope
// por si la salida está retenida o el programa ya no responde.
func (p *printer) flush(limit time.Duration) {
	expired := false
	timer := time.AfterFunc(limit, func() {
		p.mu.Lock()
		expired = true
		p.idle.Broadcast()
		p.mu.Unlock()
	})
	defer timer.Stop()

	p.mu.Lock()
	defer p.mu.Unlock()
	for (len(p.queue) > 0 || p.busy) && !p.held && !p.stop && !expired {
		p.idle.Wait()
	}
}
