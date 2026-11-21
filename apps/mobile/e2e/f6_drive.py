"""Android F6 acceptance: native app + real gateway/JS relay, fixture Core/opener.

Use only the isolated emulator and loopback gateway documented in MOBILE_F6.md.
"""
import json
from pathlib import Path
import sys
import time
import drive as ui
from f4_drive import api, scan, top

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True); ui.OUT = str(OUT)
checks = []

def check(name):
    checks.append(name); ui.shot(name)
    (OUT / 'results.json').write_text(json.dumps({'ok': True, 'checks': checks}), encoding='utf-8')
    print(name, flush=True)

def home():
    for _ in range(8):
        back = [n for n in ui.nodes() if n.get('content-desc') == 'Volver']
        if not back: return
        ui.tap(back[0]); time.sleep(.3)

def refresh(case):
    home(); api(f'/__e2e/f6/{case}', True)
    ui.tap(ui.find(r'Abrir men[uú]')); ui.tap(ui.find(r'^Supervisar$'))
    ui.tap(ui.find(r'^Trabajo activo:')); ui.find(r'Ver toda la atenci[oó]n', timeout=30)

def open_link(expected):
    ui.tap(scan(r'^Abrir en Desktop$')); scan(expected)

def main():
    ui.adb('shell', 'pm', 'grant', ui.PKG, 'android.permission.POST_NOTIFICATIONS')
    ui.adb('shell', 'am', 'start', '-n', f'{ui.PKG}/.MainActivity'); time.sleep(8)
    ui.tap(ui.edits()[0]); ui.type_text('ana@lixbon.com'); ui.tap(ui.edits()[1]); ui.type_text('secreto123')
    ui.hide_keyboard(); ui.tap(ui.find(r'^Iniciar Sesi[oó]n\s*$', last=True)); ui.find(r'Escribe un mensaje', timeout=35)
    ui.tap(ui.find(r'Abrir men[uú]')); ui.tap(ui.find(r'Ana.*ajustes'))
    ui.tap(scan(r'^Prototipo de supervisi[oó]n$')); ui.adb('shell', 'input', 'keyevent', '4')
    refresh('ready'); ui.tap(scan(r'Validar Mobile F6.*abre la tarea'))
    open_link(r'Destino abierto en el Desktop conectado')
    ui.tap(scan(r'^Copiar enlace de Desktop$')); scan(r'Enlace copiado', down=False)
    check('task-open-copy')
    ui.tap(scan(r'^Compartir enlace de Desktop$'))
    ui.find(r'lixbon://|Compartir|Nearby|Quick Share', timeout=15)
    check('native-share-sheet'); ui.adb('shell', 'input', 'keyevent', '4')
    scan(r'Validar Mobile F6', down=False); check('share-return-preserves-task')
    ui.tap(scan(r'Intento.*actual.*claude'))
    open_link(r'Destino abierto en el Desktop conectado'); check('attempt-open')
    remaining()

def remaining():
    refresh('ready'); ui.tap(scan(r'Ver toda la atenci[oó]n'))
    open_link(r'Destino abierto en el Desktop conectado'); check('attention-open')
    ui.tap(scan(r'abre la revisi[oó]n'))
    open_link(r'Destino abierto en el Desktop conectado'); check('review-open-revision')
    refresh('stale'); ui.tap(scan(r'Ver toda la atenci[oó]n')); ui.tap(scan(r'abre la revisi[oó]n'))
    before = len(api('/__e2e/state')['effects'])
    open_link(r'revisi[oó]n del enlace est[aá] obsoleta')
    assert len(api('/__e2e/state')['effects']) == before
    check('stale-review-does-not-open')
    refresh('unavailable'); ui.tap(scan(r'Validar Mobile F6.*abre la tarea'))
    open_link(r'Desktop no pudo abrirse'); scan(r'^Copiar enlace de Desktop$'); check('desktop-unavailable-copy-fallback')
    api('/__e2e/host/false', True); time.sleep(3)
    ui.tap(scan(r'^Copiar enlace de Desktop$')); scan(r'Enlace copiado', down=False); check('offline-copy-prepared-link')
    api('/__e2e/host/true', True)
    state = api('/__e2e/state'); assert not state['failures'], state['failures']
    assert all(e['kind'] == 'desktop_opened' for e in state['effects'])
    assert not any(k in json.dumps(state['effects']) for k in ['PRIVATE_SENTINEL', 'api_key', 'session_ref'])
    (OUT / 'relay-evidence.json').write_text(json.dumps(state, indent=2), encoding='utf-8')

if __name__ == '__main__':
    try:
        if len(sys.argv) > 2 and sys.argv[2] == '--resume':
            checks.extend(json.loads((OUT / 'results.json').read_text())['checks']); remaining()
        else: main()
    except BaseException as e:
        (OUT / 'results.json').write_text(json.dumps({'ok': False, 'checks': checks, 'error': str(e)}), encoding='utf-8')
        ui.shot('failure'); raise
