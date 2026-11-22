#!/usr/bin/env python3
"""Independently compare the final ENCODED sprite capture with the two supplied movies.
No harness events/logs are used to find or validate the content. Requires ffmpeg only.
Usage: python3 compare-movie-content.py capture.mp4 folder/with/sync.{mp4,webm} report.json
"""
import array, hashlib, json, math, statistics, subprocess, sys
from pathlib import Path

capture, sources, report = map(Path, sys.argv[1:4]); digest = lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def decode(p,args):return subprocess.check_output(['ffmpeg','-nostdin','-v','error','-threads','1','-i',str(p)]+args+['pipe:1'])
def pcm(p):
    a=array.array('f');a.frombytes(decode(p,['-map','0:a:0','-ac','2','-ar','48000','-f','f32le']));return a

def gates(a,ch,th):
    on=None; result=[]; n=48
    for j in range(0,len(a)-2*n+1,2*n):
        ms=j//(2*n); above=sum(x*x for x in a[j+ch:j+2*n:2])/n>=th*th
        if above and on is None: on=ms
        elif not above and on is not None:
            if ms-on>25:result.append((on,ms-on))
            on=None
    if on is not None:result.append((on,len(a)//(2*n)-on))
    return result

def strength(a,ch,begin,duration=100):
    # Content check as well as energy: FFT-free fine-grid sinusoid fit to the middle
    # of each known test pulse. Frequency is an estimate, not an acoustic output measurement.
    b=a[2*(begin*48)+ch:2*((begin+duration)*48):2];b=b[::4]; n=len(b)
    def energy(f):
        w=2*math.pi*f/12000;return sum(x*math.sin(w*i) for i,x in enumerate(b))**2+sum(x*math.cos(w*i) for i,x in enumerate(b))**2
    return max(range(645,676),key=energy) if n else None

def video(p,region):
    # 816x624 game fitted in a 640x360 final screen; a 320x180 sprite at (248,222).
    # Drop the sprite's interpolated edges; the same interior maps to each crop.
    f= ('crop=160:90:240:135:exact=1' if region else 'crop=554:312:43:24:exact=1')+',scale=48:27:flags=area'
    b=decode(p,['-map','0:v:0','-vf',f,'-pix_fmt','rgb24','-f','rawvideo']);n=48*27*3;assert len(b)%n==0;return [b[k:k+n] for k in range(0,len(b),n)]

def moments(x,y):
    n=len(x); u=sum(x)/n;v=sum(y)/n; xx=sum(c*c for c in x)/n-u*u;yy=sum(c*c for c in y)/n-v*v; xy=sum(a*b for a,b in zip(x,y))/n-u*v
    err=sum((a-b)**2 for a,b in zip(x,y))/n
    corr=xy/max(1e-8,math.sqrt(max(0,xx*yy)));psnr=10*math.log10(255*255/max(1e-8,err));return corr,psnr

thresholds=[.02,.05,.08];left=pcm(capture); capEnv={(ch,th):gates(left,ch,th) for ch in (0,1) for th in thresholds};assert all(len(g)==8 for g in capEnv.values()),'expected eight separate captured pulses'
visual=video(capture,True);white=[];previous=False
for i,v in enumerate(visual):
    ok=sum(v)/len(v)>235
    if ok and not previous:white.append(i)
    previous=ok
assert len(white)==8,('unexpected captured flashes',white)
results=[]
for k,ext in enumerate(('mp4','webm')):
    p=sources/('sync.'+ext);src=pcm(p);frames=video(p,False);assert len(frames)==96
    durations=[];good=True
    for c in [0,1]:
        for th in thresholds:
            reference=gates(src,c,th);assert len(reference)==4
            recorded=capEnv[c,th][k*4:k*4+4]; r=[t[1] for t in reference]; out=[t[1] for t in recorded];delta=[a-b for a,b in zip(out,r)];good &= all(abs(v)<=5 for v in delta)
            durations.append(dict(channel='LR'[c],rmsThreshold=th,sourceMs=r,captureMs=out,deltaMs=delta))
    # Follow the actual first visible pulse. For a 24 fps capture asynchronously
    # sampling a 24 fps movie, nearest-PTS comparison permits +/-2 input frames.
    # Do not try to uniquely identify the six identical white frames per pulse.
    start=white[k*4];peaks=[];ps=[];exactTime=[];lags=[];noColor=[]
    for i,frame in enumerate(frames):
        if sum(frame)/len(frame)>228:continue
        index=start+i
        if index>=len(visual):continue
        options=[(j,)+moments(frames[j],visual[index]) for j in range(max(0,i-2),min(len(frames),i+3)) if sum(frames[j])/len(frames[j])<=228];
        if sum(visual[index])/len(visual[index])>228:noColor.append(i);continue
        best=max(options,key=lambda t:t[2]);lags.append(best[0]-i);peaks.append(best[1]);ps.append(best[2]);exactTime.append(next(q[2] for q in options if q[0]==i))
    q=lambda vals,p:round(sorted(vals)[min(len(vals)-1,int(len(vals)*p))],4)
    freq=[]
    for c in (0,1):
        a=[strength(src,c,t+45) for t,_ in gates(src,c,.05)];b=[strength(left,c,t+45) for t,_ in capEnv[c,.05][k*4:k*4+4]];freq.append({'sourceHz':a,'captureHz':b})
    visualCheck=len(peaks)>=60 and q(peaks,.05)>.97 and q(ps,.05)>24
    results.append(dict(file=p.name,sha256=digest(p),audioPulseWidths=durations,sourceFrequencyMatch=all(x['captureHz']==x['sourceHz'] for x in freq),fundamentalHz=freq,allPulseWidthsWithin5ms=bool(good),picture={'inputFrames':len(frames),'nonWhiteSourceFrames':sum(sum(v)/len(v)<=228 for v in frames),'comparedNonWhiteFrames':len(peaks),'captureWhiteAtColorBoundaryOffsets':noColor,'rgbCorrelationP05':q(peaks,.05),'rgbCorrelationMedian':q(peaks,.5),'bestOfPlusMinus2FramesRgbPsnrP05':q(ps,.05),'sameTimeRgbPsnrMedian':q(exactTime,.5),'matchingSourceLagFrames':[min(lags),max(lags)],'contentMatches':visualCheck}));
res={'type':'Source vs final sprite recording; NOT device hardware or a claim of bit-exact playback.','measurements':'Independent ffmpeg decoding. Audio gate: 1 ms blocks at 48kHz per channel and 3 RMS thresholds; tolerance 5 ms. Picture: registered sprite-interior RGB downsample, with known asynchronous 24 fps readback. White frames are not individually distinguishable.','captureSha256':digest(capture),'clips':results,'passed':all(x['allPulseWidthsWithin5ms'] and x['picture']['contentMatches'] and x['sourceFrequencyMatch'] for x in results)}
report.write_text(json.dumps(res,indent=2)+'\n');print(json.dumps({'passed':res['passed'],'clips':[{ 'movie':r['file'],'headWidthMsRange':[min(d['captureMs'][0] for d in r['audioPulseWidths']),max(d['captureMs'][0] for d in r['audioPulseWidths'])],'picture':r['picture'],'frequenciesMatched':r['sourceFrequencyMatch']} for r in results]},ensure_ascii=False));sys.exit(0 if res['passed'] else 1)
