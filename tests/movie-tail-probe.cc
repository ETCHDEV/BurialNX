// Read clock, ACTUALLY PRESENTED pixels and the mixed 48 kHz stereo bus; never
// infer visual success or natural completion just from a declared track duration.
#include "audio-graph.h"
#include "media-decoder.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
using Clock=std::chrono::steady_clock;
using namespace std::chrono_literals;
int main(int argc,char **argv){
  if(argc<2||argc>3) return 2;
  const char* mode=argc==3?argv[2]:"normal";
  bool seekPause=!std::strcmp(mode,"seek-pause"),lastPause=!std::strcmp(mode,"pause-last"),mute=!std::strcmp(mode,"detach");
  bool pause=!std::strcmp(mode,"pause"),seek=!std::strcmp(mode,"seek"),loop=!std::strcmp(mode,"loop");
  char err[256]={};auto*m=nx_media_open(argv[1],nullptr,0,nullptr,err,sizeof(err));
  if(!m){std::fprintf(stderr,"open: %s\n",err);return 2;}
  auto w=nx_media_width(m),h=nx_media_height(m);double duration=nx_media_duration(m);
  auto*g=nx_audio_graph_create(48000);auto*s=nx_audio_node_create(g,NX_AUDIO_NODE_STREAM_SOURCE);
  nx_audio_node_connect(s,g->destination);if(nx_media_has_audio(m))nx_media_set_audio_node(m,s,48000);
  if(loop)nx_media_set_loop(m,true);
  auto *pixels=(uint8_t*)std::calloc(size_t(w)*h,4);if(!pixels||w<2||h<2)return 2;
  auto wait=Clock::now()+1000ms;while(nx_media_buffered_frames(m)<2&&!nx_media_error(m)&&Clock::now()<wait)std::this_thread::sleep_for(1ms);
  nx_media_play(m);auto start=Clock::now();double maxTime=0,lastTime=0,pausedAt=-1,pauseDrift=0,elapsed=0,firstGreen=-1,lastAudio=-1,peakL=0,peakR=0;
  const double maxSec=loop?10.0:6.4;bool ended=false,donePause=false,didSeek=false,green=false,lastGreen=false,wasSound=false;int greenOn=0,onCount=0,backsteps=0;
  double expectedPause=0,requestedError=0;bool endedWhilePaused=false,removed=false;
  double audioOn[16]={};std::array<int16_t,2048> pcm{};int64_t n=0;
  do{
    elapsed=std::chrono::duration<double>(Clock::now()-start).count();
    if(mute&&!removed&&elapsed>=1.2){nx_audio_node_disconnect(s,g->destination);removed=true;}
    if(seekPause&&!didSeek&&elapsed>=1.15){nx_media_seek(m,2.7);nx_media_pause(m);expectedPause=2.7;pausedAt=nx_media_current_time(m);didSeek=true;}
    if((pause||lastPause)&&!donePause&&elapsed>=(lastPause?2.4:1.6)&&pausedAt<0){nx_media_pause(m);pausedAt=nx_media_current_time(m);expectedPause=pausedAt;}
    if((pause||lastPause||seekPause) && pausedAt>=0 && !donePause){pauseDrift=std::max(pauseDrift,std::fabs(nx_media_current_time(m)-pausedAt));requestedError=std::max(requestedError,std::fabs(nx_media_current_time(m)-expectedPause));endedWhilePaused|=nx_media_ended(m);if(elapsed>=(lastPause?2.8:seekPause?1.55:2.0)){nx_media_play(m);donePause=true;}}
    if(seek&&!didSeek&&elapsed>=1.15){nx_media_seek(m,2.7);didSeek=true;}
    nx_audio_graph_render_s16(g,pcm.data(),1024);
    double l=0,r=0;for(int i=0;i<1024;i++){double a=pcm[2*i]/32768.,b=pcm[2*i+1]/32768.;l+=a*a;r+=b*b;}l=std::sqrt(l/1024);r=std::sqrt(r/1024);peakL=std::max(peakL,l);peakR=std::max(peakR,r);
    bool audible=l>.025||r>.025;if(audible){lastAudio=elapsed;if(!wasSound&&onCount<16)audioOn[onCount++]=elapsed;}wasSound=audible;
    if(nx_media_present(m,&pixels)){
      const size_t p=4*(size_t(h/2)*w+w/2);green=pixels[p+1]>165 && pixels[p+2]<85 && pixels[p]<125 && pixels[p+3]>240;
      // Require several spatially separated samples, so an incidental green tile in testsrc2 is not a tail.
      for(const size_t pp:{size_t(4)*(size_t(h/4)*w+w/5),size_t(4)*(size_t(h*3/4)*w+w*4/5)})green=green&&pixels[pp+1]>165&&pixels[pp+2]<85&&pixels[pp]<125;
      if(green&&!lastGreen){greenOn++;if(firstGreen<0)firstGreen=elapsed;}lastGreen=green;
    }
    double t=nx_media_current_time(m);maxTime=std::max(maxTime,t);if(t+.03<lastTime)backsteps++;lastTime=t;
    ended=nx_media_ended(m);if((ended&&(pausedAt<0||donePause))||nx_media_error(m))break;
    std::this_thread::sleep_until(start+std::chrono::microseconds(++n*1024*1000000LL/48000));
  }while(elapsed<maxSec && (!loop||onCount<3));
  std::printf("{\"mode\":\"%s\",\"duration\":%.4f,\"wall\":%.3f,\"mediaTime\":%.4f,\"maxMediaTime\":%.4f,\"ended\":%s,\"error\":%s,\"presented\":%llu,\"dropped\":%llu,\"firstTailColorWall\":%.4f,\"lastFrameTailColor\":%s,\"tailOnsets\":%d,\"audibleThroughWall\":%.3f,\"peakL\":%.3f,\"peakR\":%.3f,\"pauseDrift\":%.4f,\"pauseTargetError\":%.4f,\"endedWhilePaused\":%s,\"backsteps\":%d,\"soundOnsets\":[",mode,duration,elapsed,lastTime,maxTime,ended?"true":"false",nx_media_error(m)?"true":"false",(unsigned long long)nx_media_presented_frames(m),(unsigned long long)nx_media_dropped_frames(m),firstGreen,green?"true":"false",greenOn,lastAudio,peakL,peakR,pauseDrift,requestedError,endedWhilePaused?"true":"false",backsteps);
  for(int i=0;i<onCount;i++)std::printf("%s%.3f",i?",":"",audioOn[i]);std::puts("]}");
  nx_media_destroy(m);std::free(pixels);nx_audio_node_release(s);nx_audio_graph_unref(g);return 0;
}
