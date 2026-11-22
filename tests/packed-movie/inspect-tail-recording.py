#!/usr/bin/env python3
"""Independently inspect the DELIVERED movie. Neither the original fixtures
nor loader events/logs are consulted. Detect real pixels, PCM and stereo order."""
import array,hashlib,json,math,subprocess,sys
from pathlib import Path
file, report=map(Path,sys.argv[1:3]);info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(file)]));vid=next(x for x in info['streams'] if x['codec_type']=='video');aud=next(x for x in info['streams'] if x['codec_type']=='audio');assert aud['channels']==2 and aud['sample_rate']=='48000';n,d=map(int,vid['avg_frame_rate'].split('/'));fps=n/d
ff=lambda args:subprocess.check_output(['ffmpeg','-v','error','-nostdin','-threads','1','-i',str(file),*args,'pipe:1'])
px=ff(['-map','0:v:0','-vf','crop=80:40:280:222,scale=8:4:flags=area','-pix_fmt','rgb24','-f','rawvideo']);vf=8*4*3;assert len(px)%vf==0
colors={'green tail':[32,204,80],'middle scene':[51,68,153],'final scene':[131,47,85]};labels=[]
for i in range(0,len(px),vf):
    b=px[i:i+vf];name=None
    for k,col in colors.items():
        if all(abs(v-col[j%3])<=11 for j,v in enumerate(b)):name=k;break
    labels.append(name)

def runs(seq,min_len):
    out=[];y=0
    while y<len(seq):
        x=y;y+=1
        while y<len(seq) and seq[y]==seq[x]:y+=1
        if seq[x] and y-x>=min_len:out.append([seq[x],x,y]);
    return out
states=[(k,round((x/fps+float(vid.get('start_time',0)))*1000),round((y/fps+float(vid.get('start_time',0)))*1000)) for k,x,y in runs(labels,4)]
pcm=array.array('f');pcm.frombytes(ff(['-map','0:a:0','-ar','48000','-ac','2','-f','f32le'])); aud0=round(1000*float(aud.get('start_time',0)));audioRuns=[];separations=[]
for ch in (0,1):
    marks=[sum(x*x for x in pcm[k+ch:k+96:2])/48>=.03**2 for k in range(0,len(pcm)-95,96)];rr=[(x+aud0,y+aud0) for _,x,y in runs(marks,80)];audioRuns.append(rr);s=[]
    for x,y in rr:
        win=pcm[(x-aud0+200)*96+ch:(x-aud0+400)*96+ch:8];
        def proj(hz):
            w=2*math.pi*hz/12000;return sum(z*math.cos(w*i) for i,z in enumerate(win))**2+sum(z*math.sin(w*i) for i,z in enumerate(win))**2
        power=[proj(440),proj(880)];s.append(round(10*math.log10(max(power[ch],1e-20)/max(power[1-ch],1e-20)),2))
    separations.append(s)
assert [k for k,x,y in states]==['green tail','middle scene','green tail','final scene'],states
assert all(len(rows)==2 for rows in audioRuns),audioRuns
first,middle,second,last=states
checks={'audibleDurationsMatchBothTracks':all(abs((q[0][1]-q[0][0])-1000)<=80 and abs((q[1][1]-q[1][0])-4000)<=110 for q in audioRuns),
  'pictureTailReallyVisibleInSilence':450<=first[2]-first[1]<=580 and all(first[1]-q[0][1]>=2250 for q in audioRuns),
  'musicReallyContinuesOverLastPicture':second[2]-second[1]>=3050 and all(q[1][1]-second[1]>=3050 for q in audioRuns),
  'finalPictureHeldThroughAudioEnd':all(abs(second[2]-q[1][1])<=100 and last[1]>=q[1][1]-60 for q in audioRuns),
  'bothIntermediateAndFinalSceneActuallyShown':middle[2]-middle[1]>=200 and last[2]-last[1]>=300,
  'noChannelSwapOrMonoFold':all(sep>15 for chan in separations for sep in chan)}
d={'scope':'Independent ffmpeg decode of the actual published desktop screen recording. No engine events, original inputs or physical device claims.', 'recordingSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'videoFps':fps,'audioChannels':aud['channels'],'visualStatesMs':states,'leftRightAudibleIntervalsMs':audioRuns,'intendedToneSeparationDb_L440_R880':separations,'checks':checks,'passed':all(checks.values())};report.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d,ensure_ascii=False));sys.exit(0 if d['passed'] else 1)
