"""mascotas.py — genera los sprites pixel art de Gael y Leya (public/mascotas).

Cada estado es una tira horizontal de cuadros de 48×48 (el kart, de 72×48):
    <personaje>-<estado>.png  con estado en idle, type, think, sleep, point,
    wave, whip y kart.
Se dibujan por capas (pelo de atrás, cuerpo, brazos, cabeza, pelo de delante)
y cada capa lleva su propio contorno, así los brazos se leen encima del torso.
Uso: python apps/web/scripts/mascotas.py  (requiere Pillow).
"""
import os
from PIL import Image
os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'public', 'mascotas'), exist_ok=True)
os.chdir(os.path.join(os.path.dirname(__file__), '..', 'public', 'mascotas'))
S=48
def hx(c): return tuple(int(c[i:i+2],16) for i in (1,3,5))+(255,)
CH={
 'gael':dict(K='#1a1311',skin='#8d5a3b',skinS='#6f4329',skinL='#a3704c',fade='#4e3020',
   hair='#3a281a',hairM='#563c25',hairL='#80603c',top='#7f8475',topS='#61665a',topL='#9a9f8f',
   neck='#e2e1d6',neckS='#bdbcb0',pants='#2b2d33',pantsS='#1f2025',shoe='#ecebe4',shoeS='#b7b5ab',
   iris='#3a2414',pupil='#120a06',lip='#8a3a32',lipD='#6a2a24',sleeve=True),
 'leya':dict(K='#1d1422',skin='#f3cdb6',skinS='#dba48d',skinL='#fbe2d2',blush='#eda59a',
   hair='#2a1f33',hairM='#3b2d48',hairL='#5a4870',streak='#8f74d6',streakL='#b9a6ee',
   top='#a8389f',topS='#7e2779',topL='#c862bd',pants='#2b2d33',pantsS='#1f2025',shoe='#ecebe4',shoeS='#b7b5ab',
   iris='#c88a1c',pupil='#5e3a06',lip='#cf5550',lipD='#a83c38',sleeve=False),
}
W_='#f7f4ee'
class L:
    def __init__(s,w=S,h=S): s.w,s.h=w,h; s.p={}
    def px(s,x,y,c):
        if 0<=x<s.w and 0<=y<s.h: s.p[(x,y)]=c
    def rect(s,x0,y0,x1,y1,c):
        for y in range(y0,y1+1):
            for x in range(x0,x1+1): s.px(x,y,c)
    def blob(s,cx,cy,a,b,c,e=2.4,ymin=-99,ymax=99):
        for y in range(int(cy-b-1),int(cy+b+2)):
            for x in range(int(cx-a-1),int(cx+a+2)):
                if ymin<=y<=ymax and abs((x+.5-cx)/a)**e+abs((y+.5-cy)/b)**e<=1: s.px(x,y,c)
    def line(s,p0,p1,c,r=1):
        (x0,y0),(x1,y1)=p0,p1; n=max(abs(x1-x0),abs(y1-y0),1)
        for i in range(n+1):
            x=round(x0+(x1-x0)*i/n); y=round(y0+(y1-y0)*i/n)
            for dy in range(-r,r+1):
                for dx in range(-r,r+1): s.px(x+dx,y+dy,c)
def outline(l,K):
    o=L(l.w,l.h); o.p=dict(l.p)
    for (x,y) in list(l.p):
        for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
            q=(x+dx,y+dy)
            if q not in l.p and 0<=q[0]<l.w and 0<=q[1]<l.h: o.p[q]=K
    return o
def comp(layers,w=S,h=S,K=None):
    im=Image.new('RGBA',(w,h),(0,0,0,0))
    for l,ol in layers:
        if ol: l=outline(l,K)
        for (x,y),c in l.p.items(): im.putpixel((x,y),hx(c))
    return im

def head_layer(c,name):
    h=L()
    h.blob(23.5,17,11,10.5,c['skin'],e=2.6)
    for y in range(20,27):  # jaw shade
        for x in range(13,35):
            if (x,y) in h.p and (x<=15 or x>=32): h.p[(x,y)]=c['skinS']
    if name=='gael':
        h.rect(11,16,12,20,c['skin']); h.rect(35,16,36,20,c['skin']); h.px(11,18,c['skinS']); h.px(36,18,c['skinS'])
        for y in range(9,17):
            for x in (13,14,15,32,33,34):
                if (x,y) in h.p: h.p[(x,y)]=c['fade']
    return h
def face(h,c,name,mode='open',look=0):
    K=c['K']
    ey=16
    for ex in (16,28):
        if mode=='open' or mode=='angry':
            h.rect(ex,ey,ex+3,ey,K)
            h.rect(ex,ey+1,ex+3,ey+4,W_)
            iy=ey+1+(0 if look<0 else 1)
            h.rect(ex+1,iy,ex+2,iy+2 if look>=0 else iy+1,c['iris'])
            h.rect(ex+1,iy+1,ex+2,iy+2 if look>=0 else iy+1,c['pupil'])
            h.px(ex+1,iy,W_)
            if name=='leya':
                h.px(ex-1 if ex==16 else ex+4,ey-1,K); h.px(ex-1 if ex==16 else ex+4,ey,K)
                h.rect(ex,ey+5,ex+3,ey+5,c['skinS'])
        elif mode=='closed':
            h.rect(ex,ey+3,ex+3,ey+3,K); h.px(ex-1 if ex==16 else ex+4,ey+2,K)
        elif mode=='sleep':
            h.rect(ex,ey+3,ex+3,ey+3,K); h.px(ex,ey+2,K); h.px(ex+3,ey+2,K)
    # brows
    if name=='gael':
        if mode=='angry':
            h.rect(15,13,17,13,K); h.rect(18,14,20,14,K); h.rect(27,14,29,14,K); h.rect(30,13,32,13,K)
        else:
            h.rect(15,13,19,13,K); h.rect(28,13,32,13,K)
    else:
        if mode=='angry':
            h.rect(16,13,17,13,K); h.rect(18,14,19,14,K); h.rect(28,14,29,14,K); h.rect(30,13,31,13,K)
    # nose
    h.px(24,21,c['skinS']); h.px(23,22,c['skinS'])
    # blush
    if name=='leya':
        for x in (15,16,31,32): h.px(x,22,c['blush'])
    # mouth
    if mode=='angry':
        h.rect(22,23,25,25,c['lipD']); h.rect(22,23,25,23,K); h.rect(23,25,24,25,c['lip'])
    elif mode=='sleep':
        h.rect(23,24,24,24,c['lipD'])
    else:
        h.rect(22,24,25,24,c['lip']); 
        if name=='gael': h.rect(23,25,24,25,c['lipD'])
def hair_back(c,name):
    l=L()
    if name=='leya':
        l.blob(23.5,15,14,12,c['hair'],e=2.2)
        for y in range(15,40):
            end=[39,38,40,37,39,40,38,39,37,40]
            for x in range(10,38):
                if y<=end[x%10]: l.px(x,y,c['hair'] if (x+y)%7 else c['hairM'])
    return l
def hair_front(c,name):
    l=L()
    if name=='gael':
        cols=[c['hairL'],c['hairM'],c['hair']]
        l.blob(23.5,6,12,5,c['hair'],e=2.2,ymax=9)
        for (x,y) in list(l.p): l.p[(x,y)]=cols[(x//2+y)%3]
        # loose twists falling from the crown, 2px wide with gaps between them
        strands=[(12,6,11,12),(15,5,14,15),(18,5,17,14),(21,6,21,16),(24,6,25,14),(27,5,28,16),(30,5,31,18),(33,6,35,13)]
        for i,(x0,y0,x1,y1) in enumerate(strands):
            n=y1-y0
            for j in range(n+1):
                x=round(x0+(x1-x0)*j/n); y=y0+j
                k=(y+i)%3
                l.px(x,y,cols[k]); l.px(x+1,y,cols[(k+1)%3])
            l.px(round(x1),y1+1,c['hairM'])
        # tufts sticking up on top
        for x,y in ((16,0),(17,0),(22,0),(23,0),(29,0),(30,0),(13,2),(34,2)): l.px(x,y,c['hairM'])
    else:
        l.blob(23.5,13,12.8,9,c['hair'],e=2.3,ymax=14)
        for x in range(12,36): 
            if (x,14) in l.p and x%4==1: del l.p[(x,14)]
        # side locks
        for y in range(10,34):
            for x in (11,12,13): l.px(x,y,c['hair'])
            for x in (34,35,36): l.px(x,y,c['hair'])
            l.px(12,y,c['streak']); l.px(35,y,c['streak'])
            if y%5==0: l.px(12,y,c['streakL']); l.px(35,y,c['streakL'])
        # shine
        for x in range(17,22): l.px(x,7,c['hairL'])
        l.px(16,8,c['hairL']); l.px(22,8,c['hairL'])
        l.rect(29,9,31,10,'#d9cff2'); l.px(30,9,'#ffffff')   # clip
    return l
def body_layer(c,name,legs=True):
    b=L()
    if legs:
        b.rect(17,38,22,43,c['pants']); b.rect(25,38,30,43,c['pants']); b.rect(22,38,25,40,c['pants'])
        b.rect(17,42,22,43,c['pantsS']); b.rect(25,42,30,43,c['pantsS'])
        b.rect(16,44,22,45,c['shoe']); b.rect(25,44,31,45,c['shoe']); b.rect(16,45,22,45,c['shoeS']); b.rect(25,45,31,45,c['shoeS'])
    if name=='gael':
        b.blob(23.5,33,9.5,7,c['top'],e=3,ymin=27)
        b.rect(15,33,32,39,c['top'])
        b.rect(15,38,32,39,c['topS'])
        b.rect(18,34,29,37,c['topS']); b.rect(19,34,28,36,c['top'])  # pocket
        b.rect(17,27,30,29,c['topS'])  # hood
        b.rect(20,26,27,28,c['neck']); b.rect(20,28,27,28,c['neckS'])
        b.rect(21,29,21,32,c['topL']); b.rect(26,29,26,32,c['topL'])
    else:
        b.rect(21,26,26,28,c['skin']); b.rect(21,26,26,26,c['skinS'])
        b.blob(23.5,31,8.5,3.5,c['skin'],e=3)
        b.rect(17,30,30,35,c['top']); b.rect(18,29,29,29,c['top'])
        b.rect(17,34,30,35,c['topS']); b.rect(19,31,28,31,c['topL'])
        b.px(19,28,c['top']); b.px(19,27,c['top']); b.px(28,28,c['top']); b.px(28,27,c['top'])
        b.rect(18,36,29,37,c['skin']); b.px(23,37,c['skinS'])
        b.rect(17,38,30,39,c['pants'])
    return b
def arm(c,pts,hand=True,fist=False,open_=False):
    l=L()
    sl=c['top'] if c['sleeve'] else c['skin']
    for a,b in zip(pts,pts[1:]): l.line(a,b,sl,1)
    if c['sleeve']:
        ex,ey=pts[-1]
    hx_,hy=pts[-1]
    if hand:
        l.rect(hx_-1,hy-1,hx_+1,hy+1,c['skin']); l.px(hx_+1,hy+1,c['skinS'])
        if open_:
            for dx in (-1,0,1): l.px(hx_+dx,hy-2,c['skin'])
            l.px(hx_+2,hy,c['skin'])
    return l
IDLE_L=[(16,30),(14,35),(14,38)]
IDLE_R=[(31,30),(33,35),(33,38)]
def char(name,mode='open',look=0,armsL=IDLE_L,armsR=IDLE_R,legs=True,extra_front=None,extra_mid=None,dy=0,openR=False,armR_layer=None):
    c=CH[name]; K=c['K']
    h=head_layer(c,name); face(h,c,name,mode,look)
    layers=[(hair_back(c,name),True),(body_layer(c,name,legs),True)]
    if extra_mid: layers.append((extra_mid,True))
    if armsL: layers.append((arm(c,armsL),True))
    layers+= [(h,True),(hair_front(c,name),True)]
    if armsR: layers.append((armR_layer or arm(c,armsR,open_=openR),True))
    if extra_front:
        for e in extra_front: layers.append(e)
    return layers
def render(layers,name,w=S,h=S,shift=(0,0)):
    K=CH[name]['K']; im=comp(layers,w,h,K)
    if shift!=(0,0):
        out=Image.new('RGBA',(w,h)); out.paste(im,shift,im); return out
    return im

def keyboard(f):
    k=L(); 
    k.rect(8,37,39,41,'#2e2e2e')
    for y in (38,40):
        for x in range(10,38,2): k.px(x,y,'#6a6a66')
    k.rect(18,40,29,40,'#8a8a85')
    d=L(); d.rect(0,42,47,47,'#5b4532'); d.rect(0,42,47,42,'#7a5e44'); d.rect(0,47,47,47,'#47362a')
    return [(d,False),(k,True)]
def typing(name,f):
    c=CH[name]
    lh=(18,37) if f==0 else (19,39)
    rh=(29,39) if f==0 else (28,37)
    lay=char(name,'open',1,armsL=None,armsR=None,legs=False)
    lay+=keyboard(f)
    lay.append((arm(c,[(16,30),(13,34),lh]),True))
    lay.append((arm(c,[(31,30),(34,34),rh]),True))
    # key spark
    sp=L(); 
    lay.append((sp,False))
    return render(lay,name)
def think(name):
    c=CH[name]
    lay=char(name,'open',-1,armsR=[(31,30),(35,34),(31,27)])
    return render(lay,name)
def point(name):
    c=CH[name]
    lay=char(name,'open',0,armsR=[(31,30),(37,30),(42,30)])
    fg=L(); fg.rect(43,29,45,29,c['skin']); 
    lay.append((fg,True))
    return render(lay,name)
def wave(name,f):
    hand=(38,19) if f==0 else (40,20)
    lay=char(name,'open',0,armsR=[(31,30),(36,27),hand],openR=True)
    return render(lay,name)
def whip(name,f):
    c=CH[name]; wc='#6b4423'; wl='#9a6a3a'
    w=L()
    if f==0:
        pts=[(31,30),(36,24),(37,17)]
        hand=pts[-1]
        curve=[(37,16),(36,12),(33,8),(29,5),(24,3),(19,3),(15,5)]
    elif f==1:
        pts=[(31,30),(37,28),(42,26)]
        curve=[(43,25),(45,22),(46,18),(46,14),(45,11)]
    else:
        pts=[(31,30),(37,32),(41,36)]
        curve=[(42,37),(44,40),(46,43),(45,46),(41,46),(38,45)]
    lay=char(name,'angry',0,armsR=pts)
    for a,b in zip(curve,curve[1:]): w.line(a,b,wc,0)
    hx_,hy=pts[-1]; w.px(hx_,hy,'#3a2414')
    lay.append((w,False))
    if f==2:
        s=L()
        for p in ((36,43),(35,41),(34,45),(37,40)): s.px(*p,'#f2f2f0')
        lay.append((s,False))
    return render(lay,name)
def sleep(name,f):
    lay=char(name,'sleep',0)
    return render(lay,name,shift=(0,f))
def idle(name,f):
    return render(char(name,'closed' if f else 'open',0),name)
def kart(name,f):
    c=CH[name]; W=72
    # character shifted right by 6, no legs
    base=char(name,'open',0,armsR=None,legs=False)
    sh=[]
    for l,ol in base:
        n=L(W,S); n.p={(x+8,y+1):v for (x,y),v in l.p.items()}; sh.append((n,ol))
    k=L(W,S)
    k.blob(36,38,32,6,'#c4553d',e=3.5)
    k.rect(4,38,66,42,'#c4553d'); k.rect(4,41,66,42,'#9b3f2c')
    k.rect(60,36,69,40,'#c4553d'); k.px(70,38,'#c4553d')
    k.rect(46,35,58,36,'#e6e6e3'); k.rect(10,37,14,38,'#b4c64e')
    k.rect(1,27,8,29,'#9b3f2c'); k.rect(4,30,5,35,'#5a5a5a')   # wing
    st=L(W,S); st.line((48,34),(51,28),'#2e2e2e',0); st.rect(50,25,52,29,'#3a3a3a')
    wheels=L(W,S)
    for cx in (15,55):
        wheels.blob(cx,42,5.5,5.5,'#232323',e=2)
        wheels.blob(cx,42,2.5,2.5,'#7a7a7a',e=2)
        if f==0: wheels.px(cx-2,40,'#c9c9c0'); wheels.px(cx+2,44,'#c9c9c0')
        else: wheels.px(cx+2,40,'#c9c9c0'); wheels.px(cx-2,44,'#c9c9c0')
    ra=L(W,S)
    a=arm(c,[(39,31),(45,30),(50,28)])
    ra.p=dict(a.p)
    layers=sh[:2]+[(st,True)]+sh[2:]+[(k,True),(wheels,True),(ra,True)]
    if f==1:
        sp=L(W,S); sp.rect(0,33,3,33,'#5e5e5c'); sp.rect(1,36,4,36,'#5e5e5c'); layers.append((sp,False))
    im=comp(layers,W,S,c['K'])
    return im
def strip(frames,w=S):
    im=Image.new('RGBA',(w*len(frames),S))
    for i,f in enumerate(frames): im.paste(f,(i*w,0))
    return im
for n in ('gael','leya'):
    strip([idle(n,0),idle(n,1)]).save(f'{n}-idle.png')
    strip([typing(n,0),typing(n,1)]).save(f'{n}-type.png')
    strip([think(n)]).save(f'{n}-think.png')
    strip([sleep(n,0),sleep(n,1)]).save(f'{n}-sleep.png')
    strip([point(n)]).save(f'{n}-point.png')
    strip([wave(n,0),wave(n,1)]).save(f'{n}-wave.png')
    strip([whip(n,0),whip(n,1),whip(n,2)]).save(f'{n}-whip.png')
    strip([kart(n,0),kart(n,1)],72).save(f'{n}-kart.png')
