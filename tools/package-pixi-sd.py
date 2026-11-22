#!/usr/bin/env python3
"""Build the cg.6 SD ZIP offline (no overwrite). Usage: package-pixi-sd.py STOCK_DIR NEW.zip.
STOCK_DIR: unmodified MV corescript js/libs/pixi.js (commit 182e31449707ba7e406db0485c44c2a9d11e2dcd),
MIT license from pixijs/pixijs v4.5.4 as pixi-license.txt and MV corescript LICENSE as corescript-license.txt.
The reviewed original JS and both license files ship with the card, in BurialNX-Pixi-CG/."""
import hashlib, json, struct, sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

stock, out = map(Path, sys.argv[1:]); root = Path(__file__).resolve().parents[1]
sha = lambda b: hashlib.sha256(b).hexdigest()

def original(name, digest):
    b = (stock / name).read_bytes()
    if sha(b) != digest: raise ValueError('Stock input differs: ' + name)
    return b

nro = (root/'burialnx.nro').read_bytes(); executable = struct.unpack_from('<I', nro, 24)[0]
nacp = executable + struct.unpack_from('<Q', nro, executable+24)[0]
if nro[nacp+0x3060:nacp+0x3070].split(b'\0')[0] != b'0.1.6-cg.6': raise ValueError('Build cg.6 before packaging')
items = {'switch/burialnx/burialnx.nro':nro, '安装与验收.md':(root/'docs/movie-playback-zh.md').read_bytes(),
 'licenses/NOTICE.md':(root/'NOTICE.md').read_bytes(), 'licenses/BurialNX-AGPL.txt':(root/'LICENSE').read_bytes(),
 'licenses/nx.js-MIT.txt':(root/'LICENSES/nx.js-MIT.txt').read_bytes()}
for fixture, folder in [('cg','BurialNX-CG-check'),('pixi-cg','BurialNX-Pixi-CG'),('device-check','BurialNX-CG-device-check')]:
    source = root/'tests/fixtures'/fixture/'www'; files = ['index.html','js/rpg_core.js'];
    if fixture == 'device-check': files.append('js/device-metrics.js')
    for f in files: items[f'{folder}/www/{f}']=(source/f).read_bytes()
    for ext, digest in [('mp4','604b6fd2beeefaf8ec8b7e3381e1b56c08ed381769786aafb9d8fb2efd9240eb'),('webm','f5958d48517335c61d61316e6757b32975a7766a54971b022cd0b33236ea7dd0')]:
        b=(root/f'tests/fixtures/cg/www/movies/sync.{ext}').read_bytes()
        if sha(b) != digest: raise ValueError('Incorrect reference video')
        items[f'{folder}/www/movies/sync.{ext}']=b
p='BurialNX-Pixi-CG/'
items[p+'www/js/pixi.js']=original('pixi.js','47097d24b261679366419f9e36196a3303c35fa3d06d0518edb7f1ab5417def0')
items[p+'licenses/PixiJS-MIT.txt']=original('pixi-license.txt','d3109477c60054718630f887a9417e7e808dbc81132b7d6a91d875e36f2fc52e')
items[p+'licenses/MV-corescript-MIT.txt']=original('corescript-license.txt','e3563d4b3ff63e95a154f75d207444d71c108dc1bb64f0bb8230c5ee65a13922')
items[p+'www/movies/broken.webm']=bytes([0x1a,0x45,0xdf,0xa3,0xff]+[0]*11)
items[p+'www/movies/mislabeled.webm']=b'Intentionally not a media file.'
items[p+'纹理测试说明.md']=(root/'docs/pixi-movies-zh.md').read_bytes()
items['BurialNX-CG-device-check/使用说明.md']=(root/'docs/device-check-zh.md').read_bytes()
# Include provenance and the exact media modification/licensing text on the card.
items['licenses/runtime-preroll.md']=(root/'runtime/README.md').read_bytes()
items['licenses/runtime-preroll-manifest.json']=(root/'runtime/manifest.json').read_bytes()
items['licenses/nxjs-video-audio-preroll.patch']=(root/'patches/nxjs-video-audio-preroll.patch').read_bytes()
# Only original media and official MIT scripts from the pinned MV revision.
t='BurialNX-Tail-CG/'
for f in ['index.html','js/rpg_core.js','movies/short-audio.mp4','movies/short-video.webm']:
    items[t+'www/'+f]=(root/'tests/fixtures/track-tails/www'/f).read_bytes()
for f,digest in {'Graphics.js':'efdc3769856e6a96697a7ed0614c8aff93fa82d286531effe7d5cbc6b6343412','ResourceHandler.js':'a4c33601ce2f8fc7ebd366eb6644e8e1e857b18438e8ebe44ae073989b374d45','Game_Interpreter.js':'e08d305740540ea4ef832e3c75772c5b226a67c87803a7dfaf6888671a054bb0'}.items():
    items[t+'www/js/'+f]=original(f,digest)
items[t+'MV-corescript-MIT.txt']=items['BurialNX-Pixi-CG/licenses/MV-corescript-MIT.txt']
items[t+'片尾测试说明.md']=(root/'docs/track-tails-zh.md').read_bytes()
items['licenses/nxjs-video-track-timeline.patch']=(root/'patches/nxjs-video-track-timeline.patch').read_bytes()
# Asset digests distinguish a silent picture from its external stereo soundtrack.
sep='BurialNX-Sidecar-CG/'
for f in ['index.html','js/rpg_core.js','movies/picture-only.mp4','audio/voice.ogg']:
    data=(root/'tests/fixtures/sidecar-cg/www'/f).read_bytes()
    pins={'movies/picture-only.mp4':'d82d74299054f626f2541ffd4b7163106a353ff9139de87072c3c848fe68c6ff','audio/voice.ogg':'ea4b5a8008da362c23b6fcdd60e2a4b339c26d47bc473fe373c7adc2830d284a'}
    if f in pins and sha(data)!=pins[f]:raise ValueError('Separate soundtrack probe input changed: '+f)
    items[sep+'www/'+f]=data
items[sep+'分轨测试说明.md']=(root/'docs/separate-audio-zh.md').read_bytes()
for license_file in sorted((root/'LICENSES').glob('FFmpeg-*')):
    items['licenses/'+license_file.name]=license_file.read_bytes()
with ZipFile(out,'x') as z:
    for name, data in sorted(items.items()):
        i=ZipInfo(name,(1980,1,1,0,0,0)); i.external_attr=0o100644<<16; z.writestr(i,data,compress_type=ZIP_DEFLATED,compresslevel=6)
with ZipFile(out) as z:
    if z.testzip() or set(z.namelist())!=set(items) or any(z.read(k)!=v for k,v in items.items()): raise ValueError('ZIP verification failed')
print(json.dumps({'files':len(items),'bytes':out.stat().st_size,'sha256':sha(out.read_bytes()),'nroSha256':sha(nro)}))
