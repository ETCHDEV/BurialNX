// Desktop test glue, not part of the Switch application. All decode, resampling,
// buffer playback, looping, gain, finish detection and mixing use the nx.js sources.
#include <node_api.h>
#include "media-decoder.h"
#include "audio-graph.h"
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
struct Graph {nx_audio_graph *g=nx_audio_graph_create(48000);~Graph(){if(g)nx_audio_graph_unref(g);}};
struct Voice {nx_audio_graph *g=nullptr;nx_audio_node *s=nullptr,*gain=nullptr;void clear(){if(s){nx_audio_node_release(s);s=nullptr;}if(gain){nx_audio_node_release(gain);gain=nullptr;}if(g){nx_audio_graph_unref(g);g=nullptr;}}~Voice(){clear();}};
static const napi_type_tag GT={0x71615f7363656e65ULL,1},VT={0x71615f7363656e65ULL,2};
static void check(napi_status s){if(s!=napi_ok)throw std::runtime_error("invalid argument or N-API error");}
static napi_value string(napi_env e,const char*s){napi_value v;check(napi_create_string_utf8(e,s,NAPI_AUTO_LENGTH,&v));return v;}
static napi_value number(napi_env e,double x){napi_value v;check(napi_create_double(e,x,&v));return v;}
static napi_value yes(napi_env e,bool x){napi_value v;check(napi_get_boolean(e,x,&v));return v;}
static double num(napi_env e,napi_value x){double v;check(napi_get_value_double(e,x,&v));if(!std::isfinite(v))throw std::runtime_error("not finite");return v;}
static void prop(napi_env e,napi_value o,const char*k,napi_value v){check(napi_set_named_property(e,o,k,v));}
template<class T>static napi_value handle(napi_env e,std::unique_ptr<T> &t,const napi_type_tag*tag){napi_value o;check(napi_create_object(e,&o));check(napi_type_tag_object(e,o,tag));check(napi_wrap(e,o,t.get(),[](napi_env,void*p,void*){delete static_cast<T*>(p);},nullptr,nullptr));t.release();return o;}
template<class T>static T* un(napi_env e,napi_value o,const napi_type_tag *tag){bool right=false;check(napi_check_object_type_tag(e,o,tag,&right));if(!right)throw std::runtime_error("foreign handle");void*p=nullptr;check(napi_unwrap(e,o,&p));if(!p)throw std::runtime_error("missing handle");return static_cast<T*>(p);}
static void* typed(napi_env e,napi_value a,napi_typedarray_type want,size_t& len){napi_typedarray_type actual;void*p;napi_value buf;size_t off;check(napi_get_typedarray_info(e,a,&actual,&len,&p,&buf,&off));if(actual!=want||!p)throw std::runtime_error("unexpected typed array");return p;}
static napi_value call(napi_env e,napi_callback_info info){try{
  size_t argc=3;napi_value a[3]={},unused;void*data=nullptr;check(napi_get_cb_info(e,info,&argc,a,nullptr,&data));std::string cmd=static_cast<const char*>(data);check(napi_get_undefined(e,&unused));
  if(cmd=="graph"){auto g=std::make_unique<Graph>();if(!g->g)throw std::bad_alloc();return handle(e,g,&GT);}
  if(argc<1)throw std::runtime_error("argument missing");
  if(cmd=="decode"){size_t len=0;auto*p=static_cast<uint8_t*>(typed(e,a[0],napi_uint8_array,len));if(len==0||len>64*1024*1024)throw std::runtime_error("bad compressed input size");float* ch[NX_MEDIA_MAX_CHANNELS]={};int nc=0;uint32_t count=0,rate=0;char err[256]={};if(!nx_media_decode_audio(p,len,ch,&nc,&count,&rate,err,sizeof(err)))throw std::runtime_error(err);struct Holder{float**ch;int n;~Holder(){for(int i=0;i<n;i++)free(ch[i]);}} holder{ch,nc};
    napi_value o,arr;check(napi_create_object(e,&o));check(napi_create_array_with_length(e,nc,&arr));for(int i=0;i<nc;i++){napi_value ab;void*out;check(napi_create_arraybuffer(e,size_t(count)*sizeof(float),&out,&ab));memcpy(out,ch[i],size_t(count)*sizeof(float));check(napi_set_element(e,arr,i,ab));} prop(e,o,"channelData",arr);prop(e,o,"sampleRate",number(e,rate));return o;}
  if(cmd=="time"||cmd=="render"||cmd=="voice"){auto*g=un<Graph>(e,a[0],&GT)->g;
    if(cmd=="time")return number(e,nx_audio_graph_current_time(g));
    if(cmd=="render"){const double nf=argc==2?num(e,a[1]):-1;if(nf<0||nf>4096||std::floor(nf)!=nf||int(nf)%128)throw std::runtime_error("render quanta must be multiples of 128");napi_value buf;void* out;check(napi_create_buffer(e,size_t(nf)*4,&out,&buf));if(nf)nx_audio_graph_render_s16(g,static_cast<int16_t*>(out),uint32_t(nf));return buf;}
    if(argc!=3)throw std::runtime_error("voice(graph,channels,rate)");double rate=num(e,a[2]);uint32_t nc;check(napi_get_array_length(e,a[1],&nc));if(!nc||nc>32||rate<=0||rate>768000)throw std::runtime_error("bad audio format");std::vector<std::shared_ptr<void>> holds;std::vector<const float*> ch;size_t len=0;
    for(uint32_t i=0;i<nc;i++){napi_value channel;check(napi_get_element(e,a[1],i,&channel));size_t n=0;const float*p=static_cast<float*>(typed(e,channel,napi_float32_array,n));if(!n||(i&&n!=len)||n>UINT32_MAX)throw std::runtime_error("bad PCM plane");len=n;auto v=std::make_shared<std::vector<float>>(p,p+len);ch.push_back(v->data());holds.emplace_back(v);}
    auto v=std::make_unique<Voice>();v->g=g;nx_audio_graph_ref(g);v->s=nx_audio_node_create(g,NX_AUDIO_NODE_BUFFER_SOURCE);v->gain=nx_audio_node_create(g,NX_AUDIO_NODE_GAIN);nx_audio_node_connect(v->s,v->gain);nx_audio_node_connect(v->gain,g->destination);nx_audio_source_set_buffer(v->s,ch.data(),int(nc),uint32_t(len),rate,std::move(holds));return handle(e,v,&VT);
  }
  auto*v=un<Voice>(e,a[0],&VT);if(cmd=="release"){v->clear();return unused;}if(!v->s)throw std::runtime_error("released voice");
  if(cmd=="finished")return yes(e,nx_audio_source_playback_state(v->s)==NX_AUDIO_SOURCE_FINISHED);
  if(cmd=="stop"){nx_audio_source_stop(v->s,0);return unused;}if(argc!=2)throw std::runtime_error("missing value");
  if(cmd=="loop"){bool b;check(napi_get_value_bool(e,a[1],&b));nx_audio_source_set_loop(v->s,b,0,0);}else{double n=num(e,a[1]);if(cmd=="start")nx_audio_source_start(v->s,0,n,-1);else if(cmd=="gain")nx_audio_param_set_value(v->gain,nx_audio_node_param(v->gain,0),n);else if(cmd=="rate")nx_audio_param_set_value(v->s,nx_audio_node_param(v->s,0),n);else throw std::runtime_error("unknown operation");}return unused;
 }catch(const std::exception&x){napi_throw_error(e,nullptr,x.what());return nullptr;}}
static napi_value init(napi_env e,napi_value exports){prop(e,exports,"sourceSha256",string(e,BURIALNX_DECODER_HASH));for(const char*k:{"decode","graph","voice","render","time","start","stop","loop","gain","rate","finished","release"}){napi_value f;napi_create_function(e,k,NAPI_AUTO_LENGTH,call,(void*)k,&f);napi_set_named_property(e,exports,k,f);}return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
