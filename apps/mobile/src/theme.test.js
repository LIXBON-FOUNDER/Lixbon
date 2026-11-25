import test from 'node:test';
import assert from 'node:assert/strict';
import { DARK, LIGHT } from './theme.js';
const luminance = (hex) => hex.slice(1).match(/../g).map((x) => parseInt(x,16)/255).map((x) => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4).reduce((n,x,i) => n+x*[.2126,.7152,.0722][i],0);
const contrast = (a,b) => { const [hi,lo]=[luminance(a),luminance(b)].sort((a,b)=>b-a); return (hi+.05)/(lo+.05); };
for (const theme of [DARK,LIGHT]) {
  test(`texto legible en superficies ${theme.dark ? 'oscuras' : 'claras'}`, () => {
    for (const ink of ['ink','inkBody','inkSoft','inkMuted','inkFaint']) for (const surface of ['surface0','surface1','surface2','surface3']) assert.ok(contrast(theme[ink],theme[surface]) >= 4.5, `${ink} / ${surface}`);
    assert.ok(contrast(theme.onDanger,theme.dangerAction) >= 4.5);
  });
}
