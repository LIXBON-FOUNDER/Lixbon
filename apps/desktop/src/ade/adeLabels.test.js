import { describe, expect, it } from 'vitest';
import { COPY, UNKNOWN_STATUS_LABEL, attemptStatusInfo, errorCopy, taskStateInfo } from './adeLabels';
import { attemptDuration, displayPath, pathName } from './attemptFormat';

describe('adeLabels / attemptFormat', () => {
  it('todos los estados del contrato tienen texto; los desconocidos son neutros y nunca lanzan', () => {
    for (const status of ['pending_approval', 'starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited']) {
      expect(attemptStatusInfo(status).known).toBe(true);
    }
    for (const raw of ['nuevo', '', null, undefined, 3, {}]) {
      const info = attemptStatusInfo(raw);
      expect(info).toMatchObject({ label: UNKNOWN_STATUS_LABEL, tone: 'neutral', known: false });
    }
    expect(taskStateInfo('discarded').label).toBe('Descartada');
    expect(taskStateInfo('otro').tone).toBe('neutral');
  });

  it('copia por código de error', () => {
    expect(errorCopy('core_model_inactive')).toMatchObject({ tone: 'info', text: COPY.modelInactive, retry: false });
    expect(errorCopy('query_unsupported').tone).toBe('info');
    expect(errorCopy('model_not_found')).toMatchObject({ text: 'Esta tarea ya no existe o no es de este proyecto', back: true });
    expect(errorCopy('model_unavailable')).toMatchObject({ text: 'El Core no responde; reintentando', retry: true });
  });

  it('duración solo con inicio y fin; rutas como nombre o relativas, nunca resueltas', () => {
    expect(attemptDuration({ started_at: 1000, ended_at: null })).toBe('no disponible');
    expect(attemptDuration({ started_at: 1000, ended_at: 3_662_000 })).toBe('1 h 1 min');
    expect(pathName('/home/ana/app.lixbon-wt/t3-api/')).toBe('t3-api');
    expect(pathName('C:\\\\wt\\\\t3')).toBe('t3');
    expect(displayPath('/home/ana/app/.lixbon/informes/r1/t3.md', '/home/ana/app')).toBe('.lixbon/informes/r1/t3.md');
    expect(displayPath('/otra/ruta/x.md', '/home/ana/app')).toBe('x.md');
  });
});
