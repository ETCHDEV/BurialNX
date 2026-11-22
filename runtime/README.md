# cg.5 原生运行时：保留开场音频包，支持音画不同长度

`nxjs-preroll.nro-code.gz` 是从正常链接出来的 ARM64 Switch NRO 提取并压缩的**整个程序段**，不是 JavaScript 模拟器或临时测试程序。`.nro` 的 ASET、应用名、存档 ID 和游戏 `main.js` 仍由原有打包流程生成。日常从此源码构建应用只需 `npm ci && npm run build`；构建必须验证最终 NRO 的程序段 SHA-256，不能静默回退到旧核心。

## cg.5 轨道时钟

`nxjs-video-track-timeline.patch` 在 cg.4 启动修复之上维护一个按实际输出采样推进的媒体时钟。PCM 输入/消耗位置仍单独计数；已播放的静默时间不能被当成「时间停止」。音频按 PTS 进入有界队列，晚起音或循环间隙都保留，暂停和定位重设时间轴。原视频和音频文件均不改变。最后一幅画面的显示区间和排队的音频都结束后才自然结束；不靠超时模拟 `ended`。

## cg.4 的既有片头修复

在上游 `nx_media_open()` 中，探测元数据后立即启动后台解复用。`Video` 则在异步打开返回 JavaScript 后才创建 Web Audio stream node。旧工作线程在这个窗口仍读取容器，却只在 `audio_node` 已存在时处理音频包。第一个词、节拍或提示音可能损失几十到数百毫秒，同时视频、音量表和 `ended` 都看似正常。把 `currentTime` 设为 0 不等价于无损地取得开场音频，尤其是带解码预滚的 Opus。

补丁 `../patches/nxjs-video-audio-preroll.patch` 只改上游 `source/media-decoder.cc`：对有声影片，音频节点与采样率准备好之后才创建解码线程；无声影片立即预缓冲；提前关闭无需等待一个尚未创建的线程。显式无音频节点的 headless `play()` 仍可开始。没有二次播放、人工静音、填补首帧、截取音轨或修改用户文件。正常 Web Audio 路径、全屏播放器和 Pixi 纹理共享这一修复。

## 来源和复现

- nx.js：`v1.0.0-beta.7`，提交 `a649611a1a4daca09924cd1a436c7ca786f91592`，MIT。精确摘要见 `manifest.json`。
- 设备端静态库取自上游 CI 使用的 `ghcr.io/tootallnate/pacman-packages@sha256:92880d77878639768fe3696800104d68de1dfec65802bf7915689dd7bd718e53`（amd64 manifest `sha256:5c07e95cf5691a91d6782ead058a664a22961cc8786d6588666ca6bb88babde5`）。使用该镜像同版的 devkitA64 GCC 15.2.0-7、binutils 2.45.1-2、libnx 4.12.0、Switch FFmpeg 7.1-5 和其余静态依赖。本次实际使用 ARM Mac 版 devkitPro cross tools，并校验其发行签名。
- FFmpeg 不是只有 LGPL 的默认构建：Switch 的 7.1-5 包启用了 GPL。该组件的许可文件在 `LICENSES/FFmpeg-*`，精确的 [设备包配方](https://github.com/devkitPro/pacman-packages/tree/5cf3a4da7665a04032565a3e788656cb485dd279/switch/ffmpeg) 与补丁应与 [FFmpeg 7.1 源码](https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz) 配合使用。其他上游依赖的许可继续适用；这些说明不等同于对任意重新发行的法律审查。

重新编译程序段：设置标准 `DEVKITPRO`，确保其 `portlibs/switch` 带有上游 CI 的 V8、Skia、FFmpeg、libuv 等目标库，并安装 Node 22、make、jq、pkg-config、patch。若工具链放在非标准目录，确保其 `.pc` 文件中的安装前缀可正确解析（本次只调整工作区副本）。从 BurialNX 工程根目录执行：

```sh
npm ci
node tools/rebuild-preroll-runtime.mjs /path/to/clean/nx.js /path/to/NEW/build-directory
npm run build -- --default-icon
npm run build -- --debug --default-icon
```

脚本将上游干净目录复制到**新**目录，校验补丁前/后源码，将原版官方 NRO 中未修改的 `runtime.js`、字体和 source map 作为输入，使用 `make` 正常交叉编译。使用规范化编译路径避免将本机目录写入成品。它保留独立构建结果，不主动覆盖工程。若使用其他编译器/静态库产出不同 digest，应先审查，不能通过修改预期 hash 假装是同一构建。这次在两个不同工作目录得到相同 ARM64 程序段与相同独立 runtime NRO。

## 测试边界

`tests/movie-preroll-probe.cc` 允许人为推迟音轨接入，检查起始 PCM、取消、无声影片和无音频输出行为。`tests/packed-movie/compare-movie-content.py` 将最终录制与源素材独立对比：48 kHz、每个声道每毫秒计算 RMS，在三个门限测四段音的实际持续时间，也在精灵内部比较对应 RGB 画面。24 fps 两个独立时钟与重复白帧不能证明逐像素、逐帧无损；AAC 录制也不是位精确的 PCM 容器。用 cg.5 做桌面整包测试时，必须对绑定使用按顺序应用两个补丁的 nx.js 源码；宿主会根据 NRO 的原生摘要拒绝错版解码器。

已验证的层级是：原生源头对照、实际交叉构建和文件指纹、桌面执行包内应用/媒体 JS 后读取的最终像素与声音。**未在实体 Nintendo Switch 上运行，未验证任意商业游戏、物理扬声器/HDMI 或特定机器的输出时延。**
