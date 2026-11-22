// Host-side verification of the same patched native movie + audio graph
// sources. Device audio hardware, nv/EGL and V8 are not part of this executable.
#include "media-decoder.h"
#include "audio-graph.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <memory>
#include <set>
#include <thread>
#include <vector>
using Clock=std::chrono::steady_clock;
using namespace std::chrono_literals;
static bool clip(const char *file, bool memory) {
  char err[512]={}; std::shared_ptr<std::vector<uint8_t>> input;
  if(memory){std::ifstream f(file,std::ios::binary);input=std::make_shared<std::vector<uint8_t>>(std::istreambuf_iterator<char>(f),std::istreambuf_iterator<char>());}
  auto *m=nx_media_open(memory?nullptr:file,memory?input->data():nullptr,memory?input->size():0,input,err,sizeof(err));
  if(!m){fprintf(stderr,"open: %s\n",err);return false;}
  const auto w=nx_media_width(m),h=nx_media_height(m);const bool tracks=nx_media_has_video(m)&&nx_media_has_audio(m);
  auto *graph=nx_audio_graph_create(48000);auto *stream=nx_audio_node_create(graph,NX_AUDIO_NODE_STREAM_SOURCE);auto *gain=nx_audio_node_create(graph,NX_AUDIO_NODE_GAIN);
  nx_audio_node_connect(stream,gain);nx_audio_node_connect(gain,graph->destination);nx_media_set_audio_node(m,stream,48000);
  auto *pixels=(uint8_t*)calloc((size_t)w*h,4); if(!pixels){return false;}
  auto start=Clock::now();while(nx_media_buffered_frames(m)<2 && Clock::now()-start<2s && !nx_media_error(m))std::this_thread::sleep_for(2ms);
  constexpr int block=1024; int16_t pcm[block*2];bool tone=false,white=false;int frames=0;double peak=0;std::set<uint32_t> hashes;std::vector<double> toneOn,flashOn;
  nx_media_play(m);start=Clock::now();uint64_t blocks=0;
  while(Clock::now()-start<7s && !nx_media_error(m)){
    nx_audio_graph_render_s16(graph,pcm,block); double energy=0;for(auto v:pcm)energy+=double(v)*v;double rms=sqrt(energy/(block*2))/32768;peak=std::max(peak,rms);
    double t=nx_media_current_time(m);if(rms>.035&&!tone)toneOn.push_back(t);tone=rms>.035;
    if(nx_media_present(m,&pixels)){
      frames++;double sum=0;int n=0;uint32_t hash=2166136261u;
      for(int y=h/10;y<h;y+=std::max(1,h/11))for(int x=w/12;x<w;x+=std::max(1,w/13)){size_t p=4*((size_t)y*w+x);sum+=pixels[p]+pixels[p+1]+pixels[p+2];n+=3;hash=(hash^pixels[p])*16777619u;hash=(hash^pixels[p+1])*16777619u;}
      hashes.insert(hash);bool bright=sum/n>237;if(bright&&!white)flashOn.push_back(t);white=bright;
    }
    if(nx_media_ended(m))break;++blocks;std::this_thread::sleep_until(start+std::chrono::microseconds(blocks*block*1000000ULL/48000));
  }
  const bool ended=nx_media_ended(m);const char *error=nx_media_error(m);if(error)fprintf(stderr,"decode: %s\n",error);
  bool synced=toneOn.size()==4&&flashOn.size()==4;double maxDelta=0;
  if(synced)for(int i=0;i<4;i++){maxDelta=std::max(maxDelta,fabs(toneOn[i]-flashOn[i]));synced=synced&&fabs(toneOn[i]-i)<.15&&fabs(flashOn[i]-i)<.15;}
  const bool good=tracks&&w==640&&h==360&&ended&&!error&&frames>=75&&hashes.size()>=45&&peak>.06&&synced&&maxDelta<=.15;
  printf("%s: %s mode=%s size=%dx%d presented=%d distinct=%zu flashes=%zu tones=%zu peakPCM=%.3f maxSampledOffsetMs=%.1f ended=%d\n",good?"PASS":"FAIL",file,memory?"buffer":"file",w,h,frames,hashes.size(),flashOn.size(),toneOn.size(),peak,maxDelta*1000,ended);
  nx_media_destroy(m);free(pixels);nx_audio_node_release(stream);nx_audio_node_release(gain);nx_audio_graph_unref(graph);return good;
}
int main(int argc,char **argv) { if(argc!=3){fprintf(stderr,"usage: native-probe sync.mp4 sync.webm\n");return 2;}bool a=clip(argv[1],false),b=clip(argv[2],true);return a&&b?0:1; }
