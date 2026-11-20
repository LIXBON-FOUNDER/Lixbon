"""Native F5 UI acceptance. Uses only f5_gateway.py's loopback fixture account.

Run with ANDROID_SERIAL set to an isolated emulator and an API_BASE fixture APK.
Core RPC is simulated here; real Core is tested by Rust mobile_* integration tests.
"""
import json
from pathlib import Path
import re
import sys
import time
import drive as ui
from f4_drive import api, scan

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'e2e-f5-out')
OUT.mkdir(parents=True, exist_ok=True)
ui.OUT = str(OUT)
checks = []


def check(name):
    checks.append(name)
    ui.shot(f'{len(checks):02d}-{name}')
    (OUT / 'results.json').write_text(json.dumps({'ok': True, 'checks': checks}, indent=2), encoding='utf-8')
    print(name, flush=True)


def home():
    for _ in range(6):
        cancel = [n for n in ui.nodes() if n.get('text') == 'Cancelar']
        if cancel: ui.tap(cancel[-1])
        back = [n for n in ui.nodes() if n.get('content-desc') == 'Volver']
        if not back: return
        ui.tap(back[0])
    raise AssertionError('Cannot return to Observe Home')


def scenario(name):
    home()
    api(f'/__e2e/f5/{name}', True)
    # Reopen Observe to get a fresh snapshot without waiting for its polling interval.
    ui.tap(ui.find(r'Abrir men[uú]'))
    ui.tap(ui.find(r'^Supervisar$'))
    ui.tap(ui.find(r'^Trabajo activo:'))
    ui.find(r'Ver toda la atenci[oó]n', timeout=30)


def attention(kind):
    ui.tap(scan(r'Ver toda la atenci[oó]n'))
    ui.tap(scan(rf'abre la {kind}'))


def controls():
    ui.tap(scan(r'Validar Mobile F5.*abre la tarea'))
    ui.tap(scan(r'Intento.*actual.*claude'))
    scan(r'^Controles del intento$')


def confirm(pattern):
    ui.tap(ui.find(pattern, last=True))


def button(pattern):
    scan(pattern)
    return ui.find(pattern, cls='android.widget.Button', last=True)


def mutations():
    return [r for r in api('/__e2e/state')['requests'] if r['mutation']]


def main():
    mode = sys.argv[2] if len(sys.argv) > 2 else 'full'
    if mode == '--tail':
        ui.adb('shell', 'am', 'start', '-n', f'{ui.PKG}/.MainActivity')
        time.sleep(5)
    if mode == 'full':
        ui.adb('shell', 'pm', 'grant', ui.PKG, 'android.permission.POST_NOTIFICATIONS')
        ui.adb('shell', 'am', 'start', '-n', f'{ui.PKG}/.MainActivity')
        time.sleep(8)
        ui.tap(ui.edits()[0]); ui.type_text('ana@lixbon.com')
        ui.tap(ui.edits()[1]); ui.type_text('secreto123')
        ui.hide_keyboard(); ui.tap(ui.find(r'^Iniciar Sesi[oó]n\s*$', last=True))
        ui.find(r'Escribe un mensaje', timeout=35)
        ui.tap(ui.find(r'Abrir men[uú]')); ui.tap(ui.find(r'Ana.*ajustes'))
        ui.tap(scan(r'^Prototipo de supervisi[oó]n$'))
        ui.adb('shell', 'input', 'keyevent', '4')
        ui.tap(ui.find(r'Abrir men[uú]')); ui.tap(ui.find(r'^Supervisar$')); ui.tap(ui.find(r'^Trabajo activo:'))

        attention('pregunta')
        field = scan(r'Respuesta a Que archivo'); ui.tap(field); ui.type_text('login.js'); ui.hide_keyboard()
        ui.tap(scan(r'^Revisar y enviar$')); confirm(r'^Enviar respuesta$')
        scan(r'El Core confirm[oó] la respuesta')
        check('question-answer-confirmed')

    if mode != '--tail':
        for decision, outcome in [('Aprobar', 'aprob'), ('Rechazar', 'rechaz')]:
            scenario('ready'); attention('aprobaci[oó]n')
            ui.tap(scan(rf'^{decision}$')); confirm(rf'^{decision}$')
            scan(rf'El Core confirm[oó].*{outcome}')
            check(f'launch-{decision.lower()}')

        for label, verb in [('Aceptar', 'aceptaci[oó]n'), ('Rechazar', 'rechazo')]:
            scenario('ready'); attention('revisi[oó]n')
            scan(r'Sin evidencia')
            ui.tap(scan(r'^He revisado esta revisi[oó]n$'))
            ui.tap(scan(rf'^{label} revisi[oó]n$')); confirm(rf'^{label} revisi[oó]n$')
            scan(rf'El Core confirm[oó].*{verb}', down=False)
            check(f'review-{label.lower()}')

        scenario('large'); attention('revisi[oó]n')
        scan(r'El diff no cabe de forma [ií]ntegra')
        ui.tap(scan(r'^Open on Desktop$'))
        scan(r'La revisi[oó]n se abri[oó]', down=False)
        check('large-diff-open-desktop')

        scenario('head_moved'); attention('revisi[oó]n')
        before = len([e for e in api('/__e2e/state')['effects'] if e['kind'] == 'review'])
        ui.tap(scan(r'^He revisado esta revisi[oó]n$'))
        ui.tap(scan(r'^Aceptar revisi[oó]n$')); confirm(r'^Aceptar revisi[oó]n$')
        scan(r'La revisi[oó]n cambi[oó]', down=False)
        assert len([e for e in api('/__e2e/state')['effects'] if e['kind'] == 'review']) == before
        check('review-head-moved-blocked')

        scenario('ready'); controls()
        ui.tap(scan(r'Instrucci[oó]n para la cola')); ui.type_text('Agrega pruebas'); ui.hide_keyboard()
        ui.tap(scan(r'^Encolar instrucci[oó]n$')); confirm(r'^Encolar instrucci[oó]n$')
        scan(r'El Core confirm[oó] la instrucci[oó]n', down=False)
        ui.tap(scan(r'^Cancelar instrucci[oó]n 1$')); confirm(r'^Cancelar instrucci[oó]n$')
        scan(r'El Core confirm[oó] la cancelaci[oó]n', down=False)
        check('queue-success-cancel')
        ui.tap(scan(r'^Detener intento$')); confirm(r'^Detener intento$')
        scan(r'El Core confirm[oó] el intento detenido', down=False)
        check('stop-confirmed')

    scenario('unsupported'); controls()
    node = button(r'^Encolar instrucci[oó]n$')
    assert node.get('enabled') == 'false'
    assert button(r'^Detener intento$').get('enabled') == 'false'
    check('unsupported-controls-disabled')

    for case, message in [('stop_failure', r'No se pudo confirmar el Stop'), ('stop_timeout', r'Se agot[oó] la espera|No lleg[oó] confirmaci[oó]n')]:
        scenario(case); controls()
        ui.tap(scan(r'^Detener intento$')); confirm(r'^Detener intento$')
        scan(message, down=False)
        check(case)

    scenario('lost_ack'); controls()
    ui.tap(scan(r'Instrucci[oó]n para la cola')); ui.type_text('Mismo request'); ui.hide_keyboard()
    before = len([e for e in api('/__e2e/state')['effects'] if e['kind'] == 'queue'])
    ui.tap(scan(r'^Encolar instrucci[oó]n$')); confirm(r'^Encolar instrucci[oó]n$')
    scan(r'El Core encontr[oó] la solicitud', down=False)
    api('/__e2e/host/false', True)
    ui.find(r'Sin conexi[oó]n|IDE desconectado', timeout=20)
    count = len(mutations())
    assert button(r'^Detener intento$').get('enabled') == 'false'
    check('offline-controls-disabled')
    api('/__e2e/host/true', True)
    scan(r'Al d[ií]a', down=False)
    time.sleep(3)
    assert len(mutations()) == count, 'Reconnect resent a mutation'
    assert len([e for e in api('/__e2e/state')['effects'] if e['kind'] == 'queue']) == before + 1
    check('lost-ack-reconciled-no-replay')

    state = api('/__e2e/state')
    assert not state['failures'], state['failures']
    (OUT / 'relay-evidence.json').write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(json.dumps({'ok': True, 'checks': checks}), flush=True)


if __name__ == '__main__':
    try: main()
    except BaseException as error:
        (OUT / 'results.json').write_text(json.dumps({'ok': False, 'checks': checks, 'error': str(error)}, indent=2), encoding='utf-8')
        ui.shot('failure')
        raise
