package events

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

const (
	pollBase       = 500 * time.Millisecond
	pollMax        = 2 * time.Second
	reconnectBase  = time.Second
	reconnectMax   = 8 * time.Second
	DefaultOutage  = 60 * time.Second
	pollBackoffCap = 2
)

var (
	Now   = time.Now
	Sleep = func(ctx context.Context, d time.Duration) error {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
)

type Fetcher interface {
	Fetch(ctx context.Context, q Query) (*Page, error)
}

type CursorStore interface {
	Load() (cursor int64, found bool, err error)
	Save(cursor int64) error
}

type Follower struct {
	Fetcher   Fetcher
	Store     CursorStore
	Emit      func(raw json.RawMessage) error
	Notify    func(format string, args ...any)
	MaxOutage time.Duration
}

func pollDelay(emptyPolls int) time.Duration {
	return min(pollBase<<min(emptyPolls, pollBackoffCap), pollMax)
}

func reconnectDelay(attempt int) time.Duration {
	return min(reconnectBase<<min(attempt, 3), reconnectMax)
}

// Run sigue el log hasta que ctx se cancela (devuelve nil) o hay un error que
// no se arregla reintentando. El cursor guardado solo avanza tras emitir.
func (f *Follower) Run(ctx context.Context, q Query, explicit bool) error {
	cursor, saved := q.Cursor, int64(-1)
	if !explicit {
		switch stored, found, err := f.Store.Load(); {
		case err != nil:
			f.Notify("No se pudo leer el cursor guardado (%v): se empieza en %d.", err, cursor)
		case found:
			cursor, saved = stored, stored
			f.Notify("Reanudando desde el cursor guardado %d.", stored)
		}
	}
	userCursor := explicit
	var outageStart time.Time
	outageAttempt, emptyPolls := 0, 0

	for ctx.Err() == nil {
		q.Cursor = cursor
		page, err := f.Fetcher.Fetch(ctx, q)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var apiErr *Error
			if !errors.As(err, &apiErr) {
				return err
			}
			switch {
			case apiErr.Kind == KindNetwork:
				if outageStart.IsZero() {
					outageStart = Now()
				}
				if Now().Sub(outageStart) >= f.MaxOutage {
					return newError(KindNetwork, "network", "sin respuesta del Core tras %s de reintentos: %s", f.MaxOutage, apiErr.Message)
				}
				delay := reconnectDelay(outageAttempt)
				outageAttempt++
				f.Notify("Reconectando en %s (último cursor confirmado: %d): %s", delay, cursor, apiErr.Message)
				if Sleep(ctx, delay) != nil {
					return nil
				}
				continue
			case apiErr.Kind == KindCursorAhead && !userCursor && cursor > 0:
				f.Notify("El cursor guardado (%d) supera el head_seq del Core: la base ya no es la misma, se empieza en 0.", cursor)
				cursor, saved, emptyPolls = 0, -1, 0
				continue
			}
			return err
		}
		if !outageStart.IsZero() {
			f.Notify("Conexión recuperada.")
			outageStart, outageAttempt = time.Time{}, 0
		}
		userCursor = false

		emitted, lastEmitted := 0, cursor
		for i, raw := range page.Events {
			if page.Seqs[i] <= cursor {
				continue
			}
			if ctx.Err() != nil {
				return f.persist(lastEmitted, &saved)
			}
			if err := f.Emit(raw); err != nil {
				_ = f.persist(lastEmitted, &saved)
				return err
			}
			lastEmitted = page.Seqs[i]
			emitted++
		}
		cursor = page.NextCursor
		if err := f.persist(cursor, &saved); err != nil {
			return err
		}
		if page.HasMore {
			emptyPolls = 0
			continue
		}
		if emitted == 0 {
			emptyPolls++
		} else {
			emptyPolls = 0
		}
		if Sleep(ctx, pollDelay(max(emptyPolls-1, 0))) != nil {
			return nil
		}
	}
	return nil
}

func (f *Follower) persist(cursor int64, saved *int64) error {
	if cursor == *saved {
		return nil
	}
	if err := f.Store.Save(cursor); err != nil {
		return newError(KindInternal, "cursor_store", "no se pudo guardar el cursor %d: %v", cursor, err)
	}
	*saved = cursor
	return nil
}
