# 整包桌面验收：不重新编译应用脚本

输入是最终 SD 卡 ZIP。`package-input.mjs` 从它的 NRO RomFS 读取未修改的 `main.js`，从同一 NRO 的程序段读取 nx.js `Video`、`Event` 和 `EventTarget` 模块，同时读取包中测试游戏和 MP4、WebM。宿主将设备文件访问映射到内存里的测试 SD 卡，画布映射到桌面 Skia，音频以设备同款 48 kHz / 1024 帧的块大小读取。解码与混音由摘要固定的 nx.js C++ 代码完成（依赖本机 FFmpeg）。外层用真实屏幕像素、左右声道 PCM、影片事件和 A 键重播来验收，不用回调代替真正的音画。

**边界：** 这是对发布载荷的桌面验证，未运行 Switch ARM 机器码，没有测试物理扬声器、HDMI、特定商业游戏或主机负载性能。`stock-mv.mjs` 使用公开 MIT 版的三个 RPG Maker MV 引擎文件，不使用游戏本体。源文件按已知摘要检查，在本地读取，不内置或改写这些引擎文件。

## 复现

在源码根目录使用 Node 22+、C++17、pkg-config、FFmpeg 开发库、ffmpeg/ffprobe、unzip。把下面的占位路径换成你自己的路径。`CG_TEST_DEPS` 指向一个**可丢弃的依赖目录**（含 package.json 和 node_modules），不要对生产依赖安装测试插件。

1. 将项目的 `package.json`/`package-lock.json` 复制到该依赖目录，在其中执行 `npm ci`，再安装 `npm install --no-save --package-lock=false @napi-rs/canvas@0.1.80`。
2. 准备 nx.js `v1.0.0-beta.7`（`a649611a1a4daca09924cd1a436c7ca786f91592`）的 `source/` 目录。只用 `media-decoder.cc/.h` 和 `audio-graph.cc/.h`。测 cg.5 时须依次应用 `patches/nxjs-video-audio-preroll.patch` 和 `patches/nxjs-video-track-timeline.patch`；测 cg.4 时只应用 `patches/nxjs-video-audio-preroll.patch`；测历史包时用未改原版。宿主会根据 NRO 程序段摘要拒绝错误的桌面绑定。下面的脚本校验这四个文件再链接测试模块。

```sh
export CG_TEST_DEPS=/absolute/path/to/test-deps
export CG_DECODER=/absolute/path/to/scratch/decoder.node
node tests/packed-movie/build-native.mjs /path/to/nx.js/source "$CG_DECODER"
ZIP=/path/to/BurialNX-0.1.6-cg.4-SD.zip
T=tests/packed-movie
node --experimental-vm-modules "$T/run.mjs" "$ZIP" scaled /path/to/scaled.json /path/to/capture.mp4
node --experimental-vm-modules "$T/run.mjs" "$ZIP" direct /path/to/direct.json
CG_NEGATIVE=av-off node --experimental-vm-modules "$T/run.mjs" "$ZIP" scaled /path/to/negative.json
node "$T/inspect-capture.mjs" /path/to/capture.mp4 /path/to/recording-check.json
```

负对照只阻断最终电影画面和音频增益，继续运行同一解码器和同一事件循环。应当能结束、能重播，但像素不变化、音轨是零，`negativeControlWorked` 应为 true，`passed` 必须为 false。实录只从运行时画布读回和实际音频总线编码，没有直接复用输入视频流；独立复核脚本不读样片或运行日志。

## 原版事件与片尾回归

准备公开 `rpgtkoolmv/corescript` 提交 `182e31449707ba7e406db0485c44c2a9d11e2dcd` 中的 `js/rpg_core/Graphics.js`、`js/rpg_core/ResourceHandler.js`、`js/rpg_objects/Game_Interpreter.js`，保持原样、以基本文件名放在同一个临时目录。以下方法生成原创 14 秒 720p/30 测试片（运动图案、间隔 2 秒的 7 组白闪与短音）：

```sh
ffmpeg -f lavfi -i 'testsrc2=size=1280x720:rate=30:duration=14' -f lavfi \
  -i 'aevalsrc=if(between(mod(t\,2)\,0.5\,0.75)\,0.28*sin(2*PI*660*t)\,0):s=48000:d=14' \
  -vf "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(mod(t,2),0.5,0.75)'" \
  -t 14 -ac 2 -c:v libx264 -threads 3 -profile:v main -pix_fmt yuv420p -crf 24 -preset veryfast \
  -movflags +faststart -c:a aac -b:a 128k /path/to/cinematic.mp4
node --experimental-vm-modules "$T/stock-mv.mjs" "$ZIP" /path/to/original-MV-js /path/to/cinematic.mp4 /path/to/stock.json
```

此测试执行原版 261“播放电影”→ 等待 → 355“剧情脚本”→ 结束。游戏先请求 WebM，测试 SD 卡上只有同名 MP4，以此同时验证格式回退。判定要求剧情不能提前执行、只执行一次，并且不仅游戏离屏画布变色，**最终屏幕的同一个像素**也必须变成剧情色。此项在 cg.1 上确实失败，在 cg.2 上通过。

## cg.6：独立声音文件

`tests/packed-movie/build-native.mjs` 的第三个参数 `sidecar` 会将同源 FFmpeg 全文件音频解码器和 Web Audio 图编译成额外的桌面测试绑定。两个模块都校验与 NRO 匹配的原始 C++ 文件摘要。

```sh
node tests/packed-movie/build-native.mjs /path/to/cg5-patched/source /path/to/scratch/sidecar.node sidecar
export CG_SIDECAR_NATIVE=/path/to/scratch/sidecar.node
# 另设 CG_DECODER、CG_TEST_DEPS，如上；cg.6 的原生程序与 cg.5 相同。
node --experimental-vm-modules tests/packed-movie/separate-soundtrack.mjs cg6-SD.zip cg6-SD.zip result.json fixed capture.mp4
CG_SIDECAR_MUTE=1 node --experimental-vm-modules tests/packed-movie/separate-soundtrack.mjs cg6-SD.zip cg6-SD.zip mute.json mute
```

负对照只将独立配音的真实增益置零，保留图像、解码和片尾事件，应被检测为“无声”。两个音调分别位于左/右，检查与画面同步，也检查是否被合成单声道。
