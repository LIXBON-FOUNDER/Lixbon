"""mascotas.py — genera los sprites pixel art de Gael y Leya (public/mascotas).

Cada estado es una tira horizontal de cuadros de 48×48 (el kart, de 72×48):
    <personaje>-<estado>.png  con estado en idle, type, think, sleep, point,
    wave, whip y kart. Con `-casco` (casco de obra blanco, para cuando son
    coordinadores) y los agentes hijos `bot-<rol>-<estado>` (color según el rol).
Se dibujan por capas (pelo de atrás, cuerpo, brazos, cabeza, pelo de delante)
y cada capa lleva su propio contorno, así los brazos se leen encima del torso.
Uso: python apps/web/scripts/mascotas.py  (requiere Pillow).

Además de los PNG escribe src/lib/mascotaSprites.js (cuadros por estado y una
versión que es el hash de los sprites, para que el navegador no use los de la
caché tras regenerarlos) y copia todo al IDE (apps/desktop).
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
        for (x,y),c in l.p.items():
            if 0<=x<w and 0<=y<h: im.putpixel((x,y),hx(c))
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
def face(h,c,name,mode='open',look=0,lookX=0,boca='normal'):
    K=c['K']
    ey=16
    for ex in (16,28):
        if mode=='open' or mode=='angry':
            h.rect(ex,ey,ex+3,ey,K)
            h.rect(ex,ey+1,ex+3,ey+4,W_)
            iy=ey+1+(0 if look<0 else 1)
            ix=ex+1+lookX
            h.rect(ix,iy,ix+1,iy+2 if look>=0 else iy+1,c['iris'])
            h.rect(ix,iy+1,ix+1,iy+2 if look>=0 else iy+1,c['pupil'])
            h.px(ix,iy,W_)
            if name=='leya':
                h.px(ex-1 if ex==16 else ex+4,ey-1,K); h.px(ex-1 if ex==16 else ex+4,ey,K)
                h.rect(ex,ey+5,ex+3,ey+5,c['skinS'])
        elif mode=='closed':
            h.rect(ex,ey+3,ex+3,ey+3,K); h.px(ex-1 if ex==16 else ex+4,ey+2,K)
        elif mode=='sleep':
            h.rect(ex,ey+3,ex+3,ey+3,K); h.px(ex,ey+2,K); h.px(ex+3,ey+2,K)
        elif mode=='feliz':  # ^ ^
            h.px(ex,ey+3,K); h.px(ex+1,ey+2,K); h.px(ex+2,ey+2,K); h.px(ex+3,ey+3,K)
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
    elif boca=='abierta':
        h.rect(22,23,25,24,c['lipD']); h.rect(23,25,24,25,c['lip'])
    elif boca=='o':
        h.rect(23,23,24,25,c['lipD'])
    elif boca=='sonrisa':
        h.px(21,23,c['lip']); h.rect(22,24,25,24,c['lip']); h.px(26,23,c['lip'])
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
CASCO=False
def casco_layer():
    """Casco de obra blanco (el coordinador): cúpula con cresta y ala."""
    w,wS,wL='#f4f4ef','#c9cac2','#ffffff'
    h=L()
    h.blob(23.5,6,12.5,6,w,e=2.4,ymax=9)
    for (x,y) in list(h.p):
        if x>=32: h.p[(x,y)]=wS
    h.rect(9,9,38,10,w); h.rect(9,10,38,10,wS)
    h.rect(22,1,25,9,wL)
    for y in range(2,9): h.px(21,y,wS); h.px(26,y,wS)
    return h
def mover(l,dx,dy):
    if not dx and not dy: return l
    n=L(l.w,l.h); n.p={(x+dx,y+dy):v for (x,y),v in l.p.items()}; return n
def legs_layer(c):
    b=L()
    if True:
        b.rect(17,38,22,43,c['pants']); b.rect(25,38,30,43,c['pants']); b.rect(22,38,25,40,c['pants'])
        b.rect(17,42,22,43,c['pantsS']); b.rect(25,42,30,43,c['pantsS'])
        b.rect(16,44,22,45,c['shoe']); b.rect(25,44,31,45,c['shoe']); b.rect(16,45,22,45,c['shoeS']); b.rect(25,45,31,45,c['shoeS'])
    return b
def body_layer(c,name,legs=True):
    b=L()
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
def char(name,mode='open',look=0,armsL=IDLE_L,armsR=IDLE_R,legs=True,extra_front=None,extra_mid=None,dy=0,openR=False,armR_layer=None,
         lookX=0,boca='normal',headDx=0,headDy=0,bodyDy=0,openL=False,delante=False,giro=0):
    """Personaje de frente. headDx/headDy mueven cabeza y pelo; bodyDy baja
    el torso, los brazos y la cabeza (respirar) dejando los pies en el suelo."""
    c=CH[name]; K=c['K']
    h=head_layer(c,name)
    if giro:
        # Cara girada 3/4: los rasgos se corren `giro` px, sin salirse de la cabeza.
        rasgos=L(); face(rasgos,c,name,mode,look,lookX,boca)
        for (x,y),v in rasgos.p.items():
            if (x+giro,y) in h.p: h.p[(x+giro,y)]=v
    else:
        face(h,c,name,mode,look,lookX,boca)
    hx,hy=headDx,headDy+bodyDy
    layers=[(mover(hair_back(c,name),hx,hy),True)]
    if isinstance(legs, L): layers.append((legs,True))
    elif legs: layers.append((legs_layer(c),True))
    layers.append((mover(body_layer(c,name),0,bodyDy),True))
    if extra_mid: layers.append((extra_mid,True))
    # Con los brazos en alto (delante=True) los dos van por delante de la cabeza.
    if armsL and not delante: layers.append((mover(arm(c,armsL,open_=openL),0,bodyDy),True))
    layers+= [(mover(h,hx,hy),True),(mover(hair_front(c,name),hx,hy),True)]
    if CASCO: layers.append((mover(casco_layer(),hx,hy),True))
    if armsL and delante: layers.append((mover(arm(c,armsL,open_=openL),0,bodyDy),True))
    if armsR: layers.append((armR_layer or mover(arm(c,armsR,open_=openR),0,bodyDy),True))
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

# ── Animaciones con más cuadros ─────────────────────────────────────────
# (redefinen las de arriba: mismo nombre, más vida)

RESPIRA = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1]

def idle(name, f):
    """12 cuadros: respira (el torso baja un píxel) y parpadea al final."""
    return render(char(name, 'closed' if f == 11 else 'open', 0, bodyDy=RESPIRA[f]), name)

def talk(name, f):
    """Hablando: la boca cambia, la cabeza acompaña y la mano gesticula."""
    bocas = ['abierta', 'normal', 'o', 'sonrisa']
    mano = [(33, 38), (34, 35), (35, 33), (34, 35)][f]
    return render(char(name, 'open', 0, boca=bocas[f], headDy=[0, 1, 0, 0][f],
                       armsR=[(31, 30), (34, 34), mano], openR=f == 2), name)

def look(name, f):
    """Mira a un lado, al centro y al otro, girando un poco la cabeza."""
    lado = [-1, -1, -1, 0, 1, 1, 1, 0][f]
    return render(char(name, 'open', 0, lookX=lado, headDx=lado), name)

def wave(name, f):
    manos = [(38, 19), (40, 17), (41, 19), (39, 21)]
    codo = [(36, 27), (37, 26), (37, 26), (36, 27)][f]
    return render(char(name, 'open', 0, boca='sonrisa', headDx=[0, 1, 1, 0][f],
                       armsR=[(31, 30), codo, manos[f]], openR=True), name)

def celebrate(name, f):
    """Salta con los brazos arriba: el tramo final de una tarea."""
    alto = [0, 2, 4, 2][f]
    # Brazos cortos (casi como en reposo): codo afuera y la mano junto a la cabeza.
    arriba = [(9, 22), (8, 20), (8, 19), (8, 20)][f]
    # A Gael las rastas le tapan los ojos cerrados: celebra con los ojos abiertos.
    lay = char(name, 'feliz' if name == 'leya' else 'open', 0, boca='abierta', delante=True,
               armsL=[(16, 30), (11, 26), arriba],
               armsR=[(31, 30), (36, 26), (47 - arriba[0], arriba[1])], openL=True, openR=True)
    return render(lay, name, shift=(0, -alto))

def stretch(name, f):
    """Se estira y bosteza (gesto de espera)."""
    fases = [
        ([(16, 30), (14, 35), (14, 38)], [(31, 30), (33, 35), (33, 38)], 'open', 'normal'),
        ([(16, 30), (11, 24), (12, 15)], [(31, 30), (36, 24), (35, 15)], 'closed', 'o'),
        ([(16, 30), (11, 20), (17, 4)], [(31, 30), (36, 20), (30, 4)], 'closed', 'abierta'),
        ([(16, 30), (11, 24), (12, 15)], [(31, 30), (36, 24), (35, 15)], 'closed', 'o'),
    ]
    al, ar, ojos, boca = fases[f]
    return render(char(name, ojos, 0, boca=boca, armsL=al, armsR=ar, bodyDy=1 if f == 2 else 0, delante=f > 0), name)

def scratch(name, f):
    """Se rasca la cabeza, mirando arriba (duda)."""
    mano = (34, 11) if f == 0 else (33, 13)
    return render(char(name, 'open', -1, boca='o', armsR=[(31, 30), (37, 24), mano]), name)

def think(name, f=0):
    """Mano en la barbilla, dando golpecitos."""
    return render(char(name, 'open', -1, lookX=1 if f else 0, armsR=[(31, 30), (35, 34), (31, 27 - f)]), name)

def point(name, f=0):
    c = CH[name]
    lay = char(name, 'open', 0, boca='sonrisa' if f else 'normal', armsR=[(31, 30), (37, 30), (42 + f, 30)])
    fg = L(); fg.rect(43 + f, 29, 45 + f, 29, c['skin'])
    lay.append((fg, True))
    return render(lay, name)

def sleep(name, f):
    return render(char(name, 'sleep', 0, bodyDy=f), name)

# ── Caminando de perfil (mirando a la derecha; a la izquierda, en espejo) ─

ZANCADA = [4, 2, 0, -3, -2, 1]

def walk(name, f):
    c = CH[name]; K = c['K']
    dx = ZANCADA[f]
    bote = 1 if abs(dx) <= 1 else 0          # al cruzar las piernas el cuerpo baja
    capas = []
    # pelo de atrás (Leya)
    pb = L()
    if name == 'leya':
        pb.blob(22, 15, 12, 11.5, c['hair'], e=2.2)
        for y in range(15, 38):
            for x in range(11, 24):
                if y <= 37 - (x % 3): pb.px(x, y, c['hair'] if (x + y) % 6 else c['hairM'])
    capas.append((mover(pb, 0, bote), True))
    # brazo de atrás y pierna de atrás (más oscuros)
    sombra = c['topS'] if c['sleeve'] else c['skinS']
    ab = L(); ab.line((24, 31), (24 - dx, 37), sombra, 1); ab.rect(23 - dx, 37, 25 - dx, 38, c['skinS'])
    capas.append((mover(ab, 0, bote), True))
    def pierna(desp, col, colS):
        lg = L()
        lg.line((24, 39), (24 + desp, 43), col, 1)
        lg.rect(23 + desp, 44, 27 + desp, 45, c['shoe']); lg.rect(23 + desp, 45, 27 + desp, 45, c['shoeS'])
        return lg
    capas.append((pierna(-dx, c['pantsS'], c['pantsS']), True))
    # torso de perfil
    b = L()
    if name == 'gael':
        b.blob(24, 33, 6, 7, c['top'], e=3, ymin=27); b.rect(18, 33, 29, 39, c['top'])
        b.rect(18, 38, 29, 39, c['topS']); b.rect(17, 27, 21, 31, c['topS'])     # capucha atrás
        b.rect(22, 26, 27, 28, c['neck']); b.rect(22, 28, 27, 28, c['neckS'])
        b.rect(26, 29, 26, 32, c['topL'])
    else:
        b.rect(22, 26, 26, 28, c['skin'])
        b.rect(19, 29, 28, 35, c['top']); b.rect(19, 34, 28, 35, c['topS']); b.rect(21, 31, 27, 31, c['topL'])
        b.rect(20, 36, 27, 37, c['skin']); b.rect(19, 38, 28, 39, c['pants'])
    capas.append((mover(b, 0, bote), True))
    capas.append((pierna(dx, c['pants'], c['pantsS']), True))
    # cabeza de perfil
    h = L()
    h.blob(23.5, 17, 10.5, 10.5, c['skin'], e=2.6)
    h.px(35, 20, c['skin']); h.px(35, 21, c['skin'])                          # nariz
    for y in range(20, 27):
        for x in range(13, 36):
            if (x, y) in h.p and x <= 16: h.p[(x, y)] = c['skinS']
    ey = 16
    h.rect(29, ey, 32, ey, K); h.rect(29, ey + 1, 32, ey + 4, W_)
    h.rect(31, ey + 1, 32, ey + 3, c['iris']); h.rect(31, ey + 2, 32, ey + 3, c['pupil']); h.px(31, ey + 1, W_)
    if name == 'leya':
        h.px(33, ey - 1, K); h.px(33, ey, K)
        h.px(30, 22, c['blush']); h.px(31, 22, c['blush'])
        h.rect(31, 24, 33, 24, c['lip'])
    else:
        h.rect(28, 13, 32, 13, K)
        h.rect(31, 24, 33, 24, c['lip']); h.rect(32, 25, 33, 25, c['lipD'])
        h.rect(19, 16, 21, 20, c['skin']); h.px(20, 18, c['skinS'])            # oreja
        for y in range(9, 16):
            for x in range(14, 20):
                if (x, y) in h.p: h.p[(x, y)] = c['fade']
    capas.append((mover(h, 0, bote), True))
    # pelo de delante
    pf = L()
    if name == 'gael':
        cols = [c['hairL'], c['hairM'], c['hair']]
        pf.blob(23, 6, 11.5, 5, c['hair'], e=2.2, ymax=9)
        for (x, y) in list(pf.p): pf.p[(x, y)] = cols[(x // 2 + y) % 3]
        # rastas: por delante caen sobre la frente; por detrás, sobre la nuca
        for i, (x0, y0, x1, y1) in enumerate([(13, 6, 12, 17), (16, 6, 15, 15), (26, 6, 27, 14), (29, 6, 31, 15), (32, 6, 34, 13)]):
            n = y1 - y0
            for j in range(n + 1):
                x = round(x0 + (x1 - x0) * j / n) - (1 if (f + i) % 2 and j > n - 3 else 0); y = y0 + j
                k = (y + i) % 3
                pf.px(x, y, cols[k]); pf.px(x + 1, y, cols[(k + 1) % 3])
        for x, y in ((17, 0), (18, 0), (24, 0), (25, 0), (30, 1)): pf.px(x, y, c['hairM'])
    else:
        pf.blob(23, 13, 12, 9, c['hair'], e=2.3, ymax=14)
        for y in range(10, 31):                                                 # mechón junto a la oreja
            for x in (19, 20, 21): pf.px(x, y, c['hair'])
            pf.px(20, y, c['streak'])
            if y % 5 == 0: pf.px(20, y, c['streakL'])
        for x in range(18, 23): pf.px(x, 7, c['hairL'])
        pf.rect(28, 9, 30, 10, '#d9cff2'); pf.px(29, 9, '#ffffff')
    capas.append((mover(pf, 0, bote), True))
    # brazo de delante, balanceándose al revés que la pierna de delante
    af = L(); col = c['top'] if c['sleeve'] else c['skin']
    af.line((24, 31), (24 - dx, 37), col, 1); af.rect(23 - dx, 37, 25 - dx, 39, c['skin'])
    capas.append((mover(af, 0, bote), True))
    return comp(capas, S, S, K)

# ── Caminando (3/4): la cara mira hacia donde va, rodillas arriba y brazos
# que se balancean. Mira a la derecha; a la izquierda se pinta en espejo.

def piernas_paso(c, alza_izq, alza_der):
    """Piernas de frente; la que avanza sube `alza` px (rodilla arriba)."""
    b = L()
    for x0, alza in ((17, alza_izq), (25, alza_der)):
        y = -alza
        b.rect(x0, 38 + y, x0 + 5, 43 + y, c['pants']); b.rect(x0, 42 + y, x0 + 5, 43 + y, c['pantsS'])
        b.rect(x0 - 1 + (x0 > 20), 44 + y, x0 + 5 + (x0 > 20), 45 + y, c['shoe'])
        b.rect(x0 - 1 + (x0 > 20), 45 + y, x0 + 5 + (x0 > 20), 45 + y, c['shoeS'])
    b.rect(22, 38, 25, 40, c['pants'])
    return b

def walk(name, f):
    c = CH[name]
    # 4 tiempos: izquierda arriba, apoyo, derecha arriba, apoyo.
    alza = [(2, 0), (0, 0), (0, 2), (0, 0)][f]
    bote = 0 if alza != (0, 0) else 1
    # Brazos al revés que las piernas: el que va delante sube la mano, el
    # otro queda atrás (más abajo y pegado al cuerpo).
    adelante = [1, 0, -1, 0][f]                # 1: brazo derecho delante
    brazoL = [(16, 30), (14, 34), (15, 36) if adelante < 0 else (14, 39) if adelante > 0 else (14, 38)]
    brazoR = [(31, 30), (33, 34), (32, 36) if adelante > 0 else (33, 39) if adelante < 0 else (33, 38)]
    lay = char(name, 'open', 0, lookX=1, giro=2, headDx=1, bodyDy=bote,
               armsL=brazoL, armsR=brazoR, legs=piernas_paso(c, *alza))
    return render(lay, name)

def strip(frames,w=S):
    im=Image.new('RGBA',(w*len(frames),S))
    for i,f in enumerate(frames): im.paste(f,(i*w,0))
    return im
# Cuadros por estado: tiene que coincidir con CUADROS en lib/mascota.js (web e IDE).
ESTADOS = {
    'idle': (idle, 12), 'talk': (talk, 4), 'look': (look, 8), 'walk': (walk, 4),
    'wave': (wave, 4), 'celebrate': (celebrate, 4), 'stretch': (stretch, 4), 'scratch': (scratch, 2),
    'think': (think, 2), 'point': (point, 2), 'type': (typing, 2), 'sleep': (sleep, 2), 'whip': (whip, 3),
}
# ── Agentes hijos del orquestador ──────────────────────────────────────
# Ni humanos ni animales, con casco de obra. El color del cuerpo y del casco
# depende del rol de la tarea (ROLES). Hay tres formas: el robot (la que usa
# el IDE), un monitor con patas y una gota de código; las dos últimas solo se
# generan como muestra con MASCOTAS_MUESTRAS=<carpeta>.
AG = dict(K='#14191d', screen='#1b262d', led='#7be0a5', ledD='#3f9468', dark='#3a464e',
          paper='#f7f4ee', paperS='#c8c3b6', ink='#7a756a')
CH['bot'] = dict(K=AG['K'])
CASCOS = {
    'amarillo': dict(c='#f5c518', s='#c99a0c', l='#ffe066'),
    'naranja': dict(c='#f08a24', s='#c0661a', l='#ffb061'),
}
ROLES = {
    'general': dict(body='#8fa4b0', bodyS='#6c818d', bodyL='#b9c9d1', casco='amarillo'),
    'explorador': dict(body='#6fa8dc', bodyS='#4f86b8', bodyL='#a3cbee', casco='amarillo'),
    'implementador': dict(body='#7fb069', bodyS='#5d8a4b', bodyL='#a9d194', casco='naranja'),
    'revisor': dict(body='#a08ad6', bodyS='#7a66b0', bodyL='#c4b5ea', casco='amarillo'),
    'escalado': dict(body='#dc7c6e', bodyS='#b4584b', bodyL='#f0a79c', casco='naranja'),
}

def casco_obra(color, dy=0, luz=True):
    cs = CASCOS[color]
    c = L()
    c.blob(23.5, 13 + dy, 11, 6.5, cs['c'], e=2.4, ymax=15 + dy)
    for (x, y) in list(c.p):
        if x >= 31: c.p[(x, y)] = cs['s']
    c.rect(11, 15 + dy, 36, 16 + dy, cs['c']); c.rect(11, 16 + dy, 36, 16 + dy, cs['s'])
    c.rect(22, 8 + dy, 25, 15 + dy, cs['l'])
    if luz:
        c.rect(22, 4 + dy, 25, 7 + dy, cs['s']); c.rect(23, 5 + dy, 24, 6 + dy, '#ffe9a8')
    return c

def ojos_en(h, ojos, dy, ojo, brillo, boca=None):
    """Cara de pantalla/gota: los mismos gestos en las tres formas."""
    if ojos == 'open':
        for ex in (19, 26): h.rect(ex, 20 + dy, ex + 2, 23 + dy, ojo); h.px(ex, 20 + dy, brillo)
    elif ojos == 'blink':
        for ex in (19, 26): h.rect(ex, 22 + dy, ex + 2, 22 + dy, ojo)
    elif ojos == 'feliz':
        for ex in (19, 26): h.px(ex, 22 + dy, ojo); h.px(ex + 1, 21 + dy, ojo); h.px(ex + 2, 22 + dy, ojo)
    elif ojos == 'arriba':
        for ex in (19, 26): h.rect(ex, 19 + dy, ex + 2, 21 + dy, ojo)
    elif ojos == 'duda':
        h.rect(22, 19 + dy, 25, 19 + dy, ojo); h.rect(25, 20 + dy, 26, 21 + dy, ojo); h.rect(23, 22 + dy, 24, 22 + dy, ojo); h.rect(23, 24 + dy, 24, 24 + dy, ojo)
    if boca == 'abierta': h.rect(22, 24 + dy, 25, 25 + dy, ojo)

# Cada forma: dónde nacen los brazos, cuánto baja el casco y cómo se pinta.
def cuerpo_robot(r, ojos, boca, piernas):
    capas = []
    lg = L()
    for x0, alza in ((18, piernas[0]), (26, piernas[1])):
        lg.rect(x0, 40 - alza, x0 + 3, 43 - alza, r['bodyS'])
        lg.rect(x0 - 2, 44 - alza, x0 + 5, 45 - alza, AG['dark'])
    t = L()
    t.rect(16, 29, 31, 40, r['body']); t.rect(16, 38, 31, 40, r['bodyS']); t.rect(17, 30, 18, 38, r['bodyL'])
    t.rect(21, 32, 26, 36, AG['screen']); t.rect(22, 33, 23, 33, AG['led']); t.rect(25, 33, 25, 33, AG['ledD'])
    t.rect(22, 35, 25, 35, AG['ledD'])
    h = L()
    h.rect(14, 16, 33, 28, r['body']); h.rect(14, 26, 33, 28, r['bodyS']); h.rect(15, 17, 16, 25, r['bodyL'])
    h.rect(17, 18, 30, 26, AG['screen'])
    ojos_en(h, ojos, 0, AG['led'], '#c9ffe0', boca)
    return [(lg, True)], [(t, True), (h, True)]

def cuerpo_monitor(r, ojos, boca, piernas):
    lg = L()
    for x0, alza in ((18, piernas[0]), (26, piernas[1])):
        lg.rect(x0 + 1, 38 - alza, x0 + 2, 43 - alza, AG['dark'])
        lg.rect(x0 - 1, 44 - alza, x0 + 4, 45 - alza, AG['dark'])
    m = L()
    m.rect(20, 34, 27, 37, r['bodyS'])                                       # pie del monitor
    m.rect(11, 15, 36, 33, r['body']); m.rect(11, 31, 36, 33, r['bodyS']); m.rect(12, 16, 13, 30, r['bodyL'])
    m.rect(15, 18, 32, 29, AG['screen'])
    m.rect(31, 31, 33, 32, AG['led'])                                        # piloto de encendido
    for x in range(16, 32, 2): m.px(x, 28, '#24323b')                        # líneas de barrido
    ojos_en(m, ojos, 1, AG['led'], '#c9ffe0', boca)
    return [(lg, True)], [(m, True)]

def cuerpo_gota(r, ojos, boca, piernas):
    g = L()
    # Una gota redonda; sin piernas, al caminar da saltitos.
    alza = max(piernas)
    g.blob(23.5, 31 - alza, 12.5, 12, r['body'], e=2.1)
    for (x, y) in list(g.p):
        if y >= 38 - alza: g.p[(x, y)] = r['bodyS']
    g.rect(15, 24 - alza, 16, 29 - alza, r['bodyL']); g.px(17, 23 - alza, r['bodyL'])
    for x in range(19, 29, 3): g.px(x, 39 - alza, AG['led'])                # brillo de código
    ojos_en(g, ojos, 5 - alza, AG['K'], '#ffffff', boca)
    return [], [(g, True)]

FORMAS = {
    'robot': dict(fn=cuerpo_robot, hombros=((15, 31), (32, 31)), casco=0),
    'monitor': dict(fn=cuerpo_monitor, hombros=((11, 27), (36, 27)), casco=0),
    'gota': dict(fn=cuerpo_gota, hombros=((12, 31), (35, 31)), casco=5),
}

def agente(forma, rol, ojos='open', bodyDy=0, brazoL=None, brazoR=None, piernas=(0, 0), extra=None, luz=True, boca=None):
    fo = FORMAS[forma]; r = ROLES[rol]
    abajo, cuerpo = fo['fn'](r, ojos, boca, piernas)
    salto = max(piernas) if forma == 'gota' else 0
    capas = list(abajo) + [(mover(l, 0, bodyDy), o) for l, o in cuerpo]
    capas.append((mover(casco_obra(r['casco'], fo['casco'] - salto, luz), 0, bodyDy), True))
    def brazo(pts, hombro):
        a = L(); pts = [hombro] + list(pts[1:])
        dx = hombro[0] - (15 if hombro[0] < 24 else 32); dy = hombro[1] - 31
        pts = [pts[0]] + [(x + dx, y + dy) for x, y in pts[1:]]
        for p0, p1 in zip(pts, pts[1:]): a.line(p0, p1, r['bodyS'], 1)
        hx_, hy = pts[-1]
        a.rect(hx_ - 1, hy - 1, hx_ + 1, hy + 1, AG['dark'])
        return a
    if brazoL: capas.append((mover(brazo(brazoL, fo['hombros'][0]), 0, bodyDy - salto), True))
    if brazoR: capas.append((mover(brazo(brazoR, fo['hombros'][1]), 0, bodyDy - salto), True))
    for e in (extra or []): capas.append(e)
    return capas

B_IDLE_L = [(15, 31), (12, 35), (12, 38)]
B_IDLE_R = [(32, 31), (35, 35), (35, 38)]

def papel(x0, y0, w=12, h=14, check=False):
    p = L()
    p.rect(x0, y0, x0 + w - 1, y0 + h - 1, AG['paper']); p.rect(x0, y0 + h - 1, x0 + w - 1, y0 + h - 1, AG['paperS'])
    for y in range(y0 + 3, y0 + h - 2, 3): p.rect(x0 + 2, y, x0 + w - 3, y, AG['ink'])
    if check: p.rect(x0 + w - 4, y0 + 1, x0 + w - 3, y0 + 1, AG['led'])
    return p

def ag_idle(fo, rol, f):
    return render(agente(fo, rol, 'blink' if f == 11 else 'open', bodyDy=RESPIRA[f], brazoL=B_IDLE_L, brazoR=B_IDLE_R, luz=f % 6 < 3), 'bot')
def ag_walk(fo, rol, f):
    alza = [(2, 0), (0, 0), (0, 2), (0, 0)][f]
    bote = 0 if alza != (0, 0) else 1
    ad = [1, 0, -1, 0][f]
    return render(agente(fo, rol, 'open', bodyDy=bote, piernas=alza,
                         brazoL=[(15, 31), (13, 35), (13, 37 - (2 if ad < 0 else 0))],
                         brazoR=[(32, 31), (34, 35), (34, 37 - (2 if ad > 0 else 0))], luz=f % 2 == 0), 'bot')
def ag_carry(fo, rol, f):
    alza = [(2, 0), (0, 0), (0, 2), (0, 0)][f]
    bote = 0 if alza != (0, 0) else 1
    y = {'robot': 29, 'monitor': 30, 'gota': 31}[fo] + bote - (max(alza) if fo == 'gota' else 0)
    return render(agente(fo, rol, 'feliz' if f % 2 else 'open', bodyDy=bote, piernas=alza,
                         brazoL=[(15, 31), (14, 36), (18, 38)], brazoR=[(32, 31), (33, 36), (29, 38)],
                         extra=[(papel(17, y, 14, 12, check=True), True)]), 'bot')
def ag_work(fo, rol, f):
    if f == 0:
        brazoR = [(32, 31), (37, 27), (39, 22)]
        martillo = L(); martillo.rect(37, 17, 43, 20, AG['dark']); martillo.rect(38, 17, 39, 18, '#c9d2d8')
        extra = [(martillo, True)]
    else:
        brazoR = [(32, 31), (38, 34), (41, 38)]
        martillo = L(); martillo.rect(39, 37, 45, 40, AG['dark']); martillo.rect(40, 37, 41, 38, '#c9d2d8')
        chispa = L()
        for p_ in ((44, 43), (46, 41), (42, 44), (47, 44)): chispa.px(*p_, '#ffe066')
        extra = [(martillo, True), (chispa, False)]
    if fo == 'monitor': extra = [(mover(l, 4, -3), o) for l, o in extra]
    return render(agente(fo, rol, 'open', bodyDy=f, brazoL=B_IDLE_L, brazoR=brazoR, extra=extra, luz=bool(f)), 'bot')
def ag_think(fo, rol, f):
    return render(agente(fo, rol, 'arriba', brazoL=B_IDLE_L, brazoR=[(32, 31), (36, 28), (33, 24 - f)], luz=bool(f)), 'bot')
def ag_celebrate(fo, rol, f):
    alto = [0, 2, 4, 2][f]
    # Brazos cortos (como en reposo) levantados junto al casco.
    mano = [(11, 25), (10, 23), (10, 22), (10, 23)][f]
    im = render(agente(fo, rol, 'feliz', boca='abierta', brazoL=[(15, 31), (12, 28), mano],
                       brazoR=[(32, 31), (35, 28), (47 - mano[0], mano[1])]), 'bot')
    out = Image.new('RGBA', (S, S)); out.paste(im, (0, -alto), im); return out
def ag_ask(fo, rol, f):
    return render(agente(fo, rol, 'duda', brazoL=B_IDLE_L, brazoR=[(32, 31), (36, 27), (38 + f, 23)], luz=bool(f)), 'bot')

ESTADOS_BOT = {
    'idle': (ag_idle, 12), 'walk': (ag_walk, 4), 'carry': (ag_carry, 4), 'work': (ag_work, 2),
    'think': (ag_think, 2), 'celebrate': (ag_celebrate, 4), 'ask': (ag_ask, 2),
}

for n in ('gael', 'leya'):
    for estado, (fn, cuadros) in ESTADOS.items():
        strip([fn(n, f) for f in range(cuadros)]).save(f'{n}-{estado}.png')
    strip([kart(n, 0), kart(n, 1)], 72).save(f'{n}-kart.png')
    CASCO = True
    for estado, (fn, cuadros) in ESTADOS.items():
        strip([fn(n, f) for f in range(cuadros)]).save(f'{n}-{estado}-casco.png')
    CASCO = False
for rol in ROLES:
    for estado, (fn, cuadros) in ESTADOS_BOT.items():
        strip([fn('robot', rol, f) for f in range(cuadros)]).save(f'bot-{rol}-{estado}.png')
MUESTRAS = os.environ.get('MASCOTAS_MUESTRAS')
if MUESTRAS:
    os.makedirs(MUESTRAS, exist_ok=True)
    for fo in FORMAS:
        for rol in ROLES:
            for estado, (fn, cuadros) in ESTADOS_BOT.items():
                strip([fn(fo, rol, f) for f in range(cuadros)]).save(os.path.join(MUESTRAS, f'{fo}-{rol}-{estado}.png'))


# ── Versión y cuadros para el código, y copia al IDE ───────────────────
import hashlib, shutil, glob as _glob
APPS = os.path.abspath(os.path.join(os.getcwd(), '..', '..', '..'))
pngs = sorted(_glob.glob('*.png'))
version = hashlib.sha1(b''.join(open(f, 'rb').read() for f in pngs)).hexdigest()[:8]
cuadros = {e: n for e, (_, n) in ESTADOS.items()}
cuadros['kart'] = 2
cuadros.update({e: n for e, (_, n) in ESTADOS_BOT.items()})
js = (
    '// mascotaSprites.js — GENERADO por apps/web/scripts/mascotas.py: no editar a mano.\n'
    '// Cuadros de cada tira de sprites y versión (hash) de los PNG: va en la URL\n'
    '// para que, al regenerarlos, el navegador no use los viejos de la caché.\n'
    f"export const VERSION_SPRITES = '{version}';\n"
    'export const CUADROS = {\n'
    + ''.join(f'  {e}: {n},\n' for e, n in cuadros.items())
    + '};\n'
)
for app in ('web', 'desktop'):
    with open(os.path.join(APPS, app, 'src', 'lib', 'mascotaSprites.js'), 'w', encoding='utf-8') as fh:
        fh.write(js)
destino = os.path.join(APPS, 'desktop', 'public', 'mascotas')
os.makedirs(destino, exist_ok=True)
for f in pngs:
    shutil.copy(f, destino)
print('sprites', version, len(pngs))
