# 动态 CG 修复版：0.1.6-cg.6

**cg.6 支持独立配音：** 如果插件将画面和配音分开存放，现在 `<audio>` 和 `new Audio()` 也能加载游戏资源、真实输出声音并在结束时交还控制。可直接添加 `BurialNX-Sidecar-CG/www` 按 A，在只有视频轨的 MP4 上验证配音来自另一文件。

**cg.5 修复片尾卡剧情：** 当声音先结束，影片照常播完剩余画面；当画面先结束，保留最后一帧，直到声音也播完。要在本机验证，选择 `BurialNX-Tail-CG/www`，按 A，观察两段各 4 秒的影片。第一段声音 1 秒后停、后段画面变绿；第二段约 1 秒后画面停留，声音要持续到第 4 秒。两段结束后应显示 `DONE 2/2`。素材和原版 MV 指令在包内，不用任何商业游戏。

**cg.4 修复了有声 CG 开头的吞音。** 现在先接好音轨再启动原生解码线程；未改写/转码游戏文件，也未通过倒回或补静音掩盖丢包。普通版和调试版均嵌入修复后的 ARM64 程序。

这是基于 ETCHDEV/BurialNX `v0.1.6` 的本地修复，不是上游官方发行版。面向 RPG Maker MV 的“播放影片”和使用 Canvas 2D 绘制 `<video>` 的插件。

**cg.3 新增：** 支持 PixiJS 4 的 `Texture.fromVideoUrl()`。这些视频常是未挂到 DOM 的 `<video>`，候选文件在 `<source>` 子节点中。现在按 MIME、顺序及实际解码结果选择本地片源，视频只画在游戏指定的 Canvas 精灵位置。

**cg.2 的额外修复：** 开启跳过重绘时，片尾如果游戏在下一次回调才绘制剧情，旧版可能残留电影末帧。现在按游戏画布实际修改版本决定是否合成到屏幕，不依赖 `ended` 回调或引擎渲染标记猜测。

**要验证插件里的小窗动态 CG：** 在本包中添加 `BurialNX-Pixi-CG/www`，选择 A 后检查两段视频是否只出现在游戏画面中央、两段都有声且片尾画面变绿。详见 `BurialNX-Pixi-CG/纹理测试说明.md`。

## 在 Switch 上验收（不需要商业游戏）

1. 备份已有的 `sdmc:/switch/burialnx/burialnx.nro`，不要删除存档。将普通版 `burialnx.nro` 放到此路径。如果使用自制的游戏快捷启动器（forwarder），**先从 hbmenu 启动更新后的主程序**；旧的 forwarder 内嵌旧运行代码，需重建才会使用修复。
2. 配套 SD 卡包内有 `BurialNX-CG-check/www/`。也可以将源码中的 `tests/fixtures/cg/www/` 复制到卡上的这个目录。两段视频和测试脚本都是自制的，没有游戏素材。
3. 用应用模式（非相册小程序模式）启动，选 **Add Game → `BurialNX-CG-check/www`**。首次选独立 SD 存档位置即可；样例不读写游戏进度。
4. 自动先播放 H.264/AAC 的 MP4，再播放 VP8/Opus 的 WebM。两段都是 **640×360、24 fps、4 秒、双声道**。每段都有运动图案，以及每秒一次、总共 **4 次**的全屏白闪和短音。请以舒适音量测试；对闪光敏感者可以跳过样例。
5. 听见每次短音与白闪相对应、两段片尾都恢复测试画面，并看到 **`Ended: 2/2`** 才算这台机器通过。按 A 可重播。还可以在播到一半时打开/关闭暂停菜单，检查声音和画面一起暂停、恢复。然后测试**你自己的 CG**，尤其是开头、转场和回到剧情的位置。

如果失败：普通版用于日常运行；调试版以 `burialnx-debug.nro` 放在同一目录，从 hbmenu 启动。记录文件扩展名、编码、分辨率、故障时间，以及是“无图/无声/不同步/不回剧情”中的哪种；`sdmc:/switch/burialnx/LOGS/native-host.log` 中可查 `Movie metadata` / `Movie ended` / `Movie failed`。无需提供游戏本体、存档或机器密钥。

## 实现与限制

- 锁定 nx.js `v1.0.0-beta.7` 原生 `Video`；FFmpeg 解复用和解码，视频帧实际交给 `drawImage`，声音走原生 Web Audio。默认 SD 文件按路径流式播放，模组优先；一种扩展名缺失时尝试同名 `.mp4` / `.webm`。损坏的首选文件会报错，而不是无声跳过。
- 对需要通过原资源读取器解包或无法安全直传原生路径的文件，使用可回收 Blob，内存回退上限为 **64 MiB**。此限制不套用到能直接从 SD 读取的普通文件。未加入网络流播放。
- 首个可用画面发送一次 `loadeddata`；正常结束发送 `ended`，失败走 `error`。支持暂停/继续、音量、静音、循环和定位。支持主画布直绘/离屏、跳过静态游戏重绘、从菜单恢复及退出清理。保留比例与黑边。
- 目前是 **1×** 播放。没有保证任意插件（例如仅支持 WebGL 视频纹理的插件）、所有编码/码率、无限分辨率或所有机器。原项目单独禁用的 Credits 菜单并未重新开放。

## 开发者验证

```sh
npm ci
npm test                          # 单元、MV 事件时序及真实宿主合成流程
npm run test:movie:browser         # Chrome/Chromium；可设 CHROME_BIN
# NXJS_MEDIA_SOURCE 指向 依次应用 patches/nxjs-video-audio-preroll.patch、patches/nxjs-video-track-timeline.patch 后的 nx.js v1.0.0-beta.7/source/；需 C++17、pkg-config、FFmpeg 开发库
NXJS_MEDIA_SOURCE=/path/to/nx.js/source npm run test:movie:native
npm run build -- --default-icon
npm run build -- --debug --default-icon
```

- 浏览器测试通过**生产代码的资源解析、视频节点和合成器**，实际采样画布像素与解码的 PCM；不依赖扬声器，也不是拿媒体时长当播放成功。
- 原生测试单独编译与设备版同标签、经摘要核对的 `media-decoder.cc`、`audio-graph.cc` 及其头文件，测实际帧缓冲、双声道 PCM、同步标记与结束状态。使用的是电脑的 FFmpeg 动态库，不是执行 Switch NRO。
- 正常 npm 构建嵌入已从源码交叉编译的 cg.4 原生程序段（详见 runtime/README.md）；还会校验最终 NRO 的原生程序段 SHA-256，防止换成不含解码器的精简启动包；普通版、调试版都嵌入完整运行时。
- 本次没有在实体 Switch 上播放，未验证特定商业游戏、实际扬声器/HDMI 延迟、长片或高码率性能。以上桌面测试不能替代第 1 节的真机验收。

上游依据：[BurialNX 基线](https://github.com/ETCHDEV/BurialNX/tree/v0.1.6)、[固定版本媒体实现](https://github.com/TooTallNate/nx.js/blob/v1.0.0-beta.7/packages/runtime/src/video.ts)、[原生媒体解码器](https://github.com/TooTallNate/nx.js/blob/v1.0.0-beta.7/source/media-decoder.cc)。

### cg.1 初次桌面记录（历史基线）

`npm test`: 239/239 通过，无跳过。下列是两段 4 秒样片的实测值，不是对其他片源的性能承诺。

| 样片 | 浏览器：不同画面 / 白闪 / 短音 | nx.js 原生核心：呈现帧 / 白闪 / 短音 | 原生核心：白闪与短音的最大采样时间差 |
|---|---:|---:|---:|
| `sync.mp4` | 73 / 4 / 4 | 94 / 4 / 4 | 41.4 ms |
| `sync.webm` | 74 / 4 / 4 | 94 / 4 / 4 | 43.8 ms |

“呈现帧”计数来自电脑上的原生播放器；音画时间差是合成白闪/短音采样结果，不包含 Switch 屏幕、扬声器或 HDMI 的输出延迟。
