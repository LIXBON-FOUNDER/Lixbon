"""Negative/offline/accessibility continuation of f5_drive.py's fixture run."""
import json
import re
import time
import drive as ui
import f5_drive as qa
from f4_drive import api, scan


def button(pattern):
    scan(pattern)
    return ui.find(pattern, cls='android.widget.Button', last=True)


def main():
    qa.scenario('elevated'); qa.attention('pregunta')
    ui.tap(scan(r'Respuesta a Que archivo')); ui.type_text('Borrador privado'); ui.hide_keyboard()
    assert button(r'^Revisar y enviar$').get('enabled') == 'false'
    qa.check('elevated-question-disabled')

    qa.scenario('expired'); qa.attention('aprobaci[oó]n')
    scan(r'venci[oó]|expir[oó]|vencid|expirad')
    assert not [n for n in ui.nodes() if n.get('content-desc') == 'Aprobar']
    qa.check('expired-launch-disabled')

    qa.scenario('elevated'); qa.attention('revisi[oó]n')
    assert button(r'^Aceptar revisi[oó]n$').get('enabled') == 'false'
    qa.check('elevated-review-disabled')

    qa.scenario('ready'); qa.attention('pregunta')
    ui.tap(scan(r'Respuesta a Que archivo')); ui.type_text('Conserva borrador'); ui.hide_keyboard()
    before = len(qa.mutations())
    api('/__e2e/host/false', True)
    ui.find(r'Sin conexi[oó]n|IDE desconectado', timeout=20)
    assert button(r'^Revisar y enviar$').get('enabled') == 'false'
    qa.check('question-offline-draft')
    api('/__e2e/host/true', True)
    scan(r'Al d[ií]a', down=False)
    assert 'Conserva borrador' in scan(r'Conserva borrador').get('text', '')
    assert len(qa.mutations()) == before
    qa.check('question-reconnected-draft-no-replay')

    qa.scenario('queue_failure'); qa.controls()
    ui.tap(scan(r'Instrucci[oó]n para la cola')); ui.type_text('Falla entrega'); ui.hide_keyboard()
    ui.tap(scan(r'^Encolar instrucci[oó]n$')); qa.confirm(r'^Encolar instrucci[oó]n$')
    scan(r'Fall[oó]: Falla entrega.*adapter_error')
    qa.check('queue-delivery-failure-visible')

    # A real Android configuration change; re-open Observe after recreation.
    qa.home()
    api('/__e2e/f5/ready', True)
    ui.adb('shell', 'settings', 'put', 'system', 'font_scale', '1.3')
    ui.adb('shell', 'am', 'force-stop', ui.PKG)
    ui.adb('shell', 'am', 'start', '-n', f'{ui.PKG}/.MainActivity')
    ui.find(r'Abrir men[uú]', timeout=25)
    ui.tap(ui.find(r'Abrir men[uú]')); ui.tap(ui.find(r'^Supervisar$')); ui.tap(ui.find(r'^Trabajo activo:'))
    qa.controls()
    targets = []
    density = int(re.search(r'(?:Physical|Override) density: (\d+)', ui.adb('shell', 'wm', 'density')).group(1)) / 160
    for pattern in [r'^Encolar instrucci[oó]n$', r'^Detener intento$']:
        node = button(pattern)
        x1, y1, x2, y2 = node['box']
        assert y2 - y1 >= 48 * density, (pattern, node['box'], density)
        targets.append({'label': node.get('content-desc'), 'role': node['class'], 'bounds': node['box'], 'height_dp': (y2-y1)/density})
    qa.check('android-font130-button-roles-48dp')
    (qa.OUT / 'accessibility.json').write_text(json.dumps({'font_scale': 1.3, 'targets': targets}, indent=2), encoding='utf-8')
    ui.adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
    state = api('/__e2e/state')
    assert not state['failures'], state['failures']
    (qa.OUT / 'negative-relay-evidence.json').write_text(json.dumps(state, indent=2), encoding='utf-8')


if __name__ == '__main__':
    try: main()
    except BaseException as error:
        (qa.OUT / 'results.json').write_text(json.dumps({'ok': False, 'checks': qa.checks, 'error': str(error)}, indent=2), encoding='utf-8')
        ui.shot('failure')
        raise
