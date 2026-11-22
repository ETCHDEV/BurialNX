#!/usr/bin/env python3
"""Desktop native regression driver (no Switch hardware or game keys).
Requires c++17, pkg-config, ffmpeg. Pass /path/to/CG5-patched/nx.js/source.
Optionally provide a path to save the JSON measurements. Uses disposable media.
"""
import concurrent.futures,hashlib,json,os,shlex,subprocess,sys,tempfile
from pathlib import Path
if not (2<=len(sys.argv)<=3): raise SystemExit('usage: python3 tools/test-track-tails.py patched-source-dir [measurements.json]')
root=Path(__file__).resolve().parents[1];src=Path(sys.argv[1]).resolve()
m=json.loads((root/'runtime/manifest.json').read_text())
for name,pin in m['patchedSourceSha256'].items():
    if hashlib.sha256((src/name).read_bytes()).hexdigest()!=pin:raise ValueError('Incorrect native source: '+name)
def run(args,**kw):return subprocess.run(list(map(str,args)),check=True,**kw)
media=root/'tests/fixtures/track-tails/www/movies'
with tempfile.TemporaryDirectory(prefix='burialnx-track-tails-') as d:
    w=Path(d);libs=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','libavformat','libavcodec','libavutil','libswscale','libswresample'],text=True));bin=w/'probe'
    run([os.environ.get('CXX','c++'),'-std=c++17','-O2','-pthread','-I',src,root/'tests/movie-tail-probe.cc',src/'media-decoder.cc',src/'audio-graph.cc',*libs,'-o',bin]);
    def ff(*args):run(['ffmpeg','-nostdin','-v','error',*args])
    def gen(name,pictureLength,audioLength,mark,rate=24,delay=0):
        args=['-f','lavfi','-i',f'testsrc2=size=384x216:rate={rate}:duration={pictureLength}'];
        if audioLength:args+=['-itsoffset',str(delay),'-f','lavfi','-i',f'aevalsrc=0.22*sin(2*PI*440*t)|0.22*sin(2*PI*880*t):s=48000:d={audioLength}']
        ff(*args,'-vf',f"drawbox=x=0:y=0:w=iw:h=ih:color=0x20cc50:t=fill:enable='gte(t,{mark})'",'-c:v','libx264','-threads','2','-bf','0','-pix_fmt','yuv420p','-preset','veryfast',*(['-c:a','aac','-b:a','144k'] if audioLength else ['-an']),'-movflags','+faststart',w/name)
    gen('short-video.mp4',1,4,.7);gen('delayed-audio.mp4',4,.7,3.5,delay=1.5);gen('last-hold.mp4',4,None,2,rate=.5)
    ff('-i',media/'short-audio.mp4','-map','0:v','-an','-c','copy',w/'silent.mp4');ff('-i',media/'short-audio.mp4','-map','0:v','-map','0:a','-c:v','libvpx','-threads','2','-b:v','420k','-cpu-used','4','-deadline','realtime','-c:a','libopus','-b:a','80k',w/'short-audio.webm')
    jobs=[(f,'normal') for f in ('short-audio.mp4','short-video.mp4','short-audio.webm','short-video.webm','delayed-audio.mp4','silent.mp4')]+[('short-audio.mp4','pause'),('short-audio.mp4','seek'),('short-video.mp4','seek'),('short-audio.mp4','loop'),('short-audio.webm','loop'),('short-audio.mp4','seek-pause'),('short-audio.mp4','detach'),('last-hold.mp4','pause-last')]
    def probe(job):
        f,mode=job;inp=media/f if (media/f).is_file() else w/f;r=json.loads(subprocess.check_output([bin,inp,mode],timeout=13));r.update(file=f);return r
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(probe,jobs))
    out=w/'measurements.json';out.write_text(json.dumps(rows,indent=2)+'\n');run([sys.executable,root/'tests/check-tail-matrix.py',out]);
    if len(sys.argv)==3:
        with Path(sys.argv[2]).open('x') as f:f.write(out.read_text())
