// Host regression for the file/graph handoff in the shipped Switch runtime.
// Compile with the reviewed media-decoder.cc and audio-graph.cc (stock OR patched),
// run: probe movie.mp4 delay_ms [audio|silent|no-sink|cancel] [seek0]
#include "audio-graph.h"
#include "media-decoder.h"
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
  if(argc<3||argc>5)return 2;
  const int delay=std::atoi(argv[2]);if(delay<0||delay>2000)return 2;
  const char* mode=argc>3?argv[3]:"audio";
  const bool audio=std::strcmp(mode,"audio")==0,silent=std::strcmp(mode,"silent")==0;
  if(!audio && !silent && std::strcmp(mode,"no-sink") && std::strcmp(mode,"cancel"))return 2;
  char reason[384]={};auto*m=nx_media_open(argv[1],nullptr,0,nullptr,reason,sizeof(reason));
  if(!m){std::fprintf(stderr,"Failed to open clip: %s\n",reason);return 1;}
  std::this_thread::sleep_for(std::chrono::milliseconds(delay));auto buffered=nx_media_buffered_frames(m);
  if(!std::strcmp(mode,"cancel")){nx_media_destroy(m);std::printf("{\"closedBeforeAttach\":true,\"bufferedBeforeAttach\":%u}\n",buffered);return 0;}
  int w=nx_media_width(m),h=nx_media_height(m);bool tracks=nx_media_has_audio(m);
  if(!w||!h||(audio&&!tracks)||(silent&&tracks)){nx_media_destroy(m);return 2;}
  nx_audio_graph*g=nullptr;nx_audio_node*s=nullptr;
  if(audio){g=nx_audio_graph_create(48000);s=nx_audio_node_create(g,NX_AUDIO_NODE_STREAM_SOURCE);nx_audio_node_connect(s,g->destination);nx_media_set_audio_node(m,s,48000);}
  if(argc==5&&!std::strcmp(argv[4],"seek0"))nx_media_seek(m,0);
  if(audio||silent){auto end=Clock::now()+1200ms;while((nx_media_seeking(m)||nx_media_buffered_frames(m)<2)&&!nx_media_error(m)&&Clock::now()<end)std::this_thread::sleep_for(1ms);}
  auto*p=(uint8_t*)std::calloc(size_t(w)*h,4);if(!p){nx_media_destroy(m);return 2;}
  nx_media_play(m);std::array<int16_t,2048> data{};const double thresholds[]={.02,.05,.08};
  int span[2][3]={},win=0;double sq[2]={};auto start=Clock::now();bool ended=false;
  for(int b=0;b<(audio?35:400);b++){
    if(audio){nx_audio_graph_render_s16(g,data.data(),1024);for(int i=0;i<1024;i++){
      for(int c=0;c<2;c++){double v=data[i*2+c]/32768.;sq[c]+=v*v;}
      if(++win==48){for(int c=0;c<2;c++){double rms=std::sqrt(sq[c]/win);for(int k=0;k<3;k++)if(rms>=thresholds[k])span[c][k]++;sq[c]=0;}win=0;}
    }}
    nx_media_present(m,&p);ended=nx_media_ended(m);if(ended||nx_media_error(m))break;
    std::this_thread::sleep_until(start+std::chrono::microseconds((b+1)*1024*1000000LL/48000));
  }
  const bool ok=!nx_media_error(m)&&(audio||ended);auto presented=nx_media_presented_frames(m);
  nx_media_destroy(m);std::free(p);if(s)nx_audio_node_release(s);if(g)nx_audio_graph_unref(g);
  std::printf("{\"delayMs\":%d,\"bufferedBeforeAttach\":%u,\"presented\":%llu,\"ended\":%s,\"firstPulseDurationMs\":[[%d,%d,%d],[%d,%d,%d]]}\n",delay,buffered,(unsigned long long)presented,ended?"true":"false",span[0][0],span[0][1],span[0][2],span[1][0],span[1][1],span[1][2]);
  return ok?0:1;
}
