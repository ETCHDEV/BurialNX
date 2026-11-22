# cg.3：在游戏画面里播视频纹理

普通“播放影片”通常把文件名写入 `video.src`。MV 随附的 PixiJS 4.5.4 则使用 `PIXI.Texture.fromVideoUrl()`：它把 URL/MIME 写入 `<source>` 子节点，再对未加入 document 的 `<video>` 调用 `load()`。cg.2 在这里根本没有启动解码器；cg.3 支持这一用法，帧交给 Pixi 的 CanvasRenderer 绘制成精灵，音轨仍走原生解码/音频总线，而不是在游戏上另盖全屏播放器。

## 上机试用

1. 备份旧 NRO，不删存档。把本包的 `switch/` 和 `BurialNX-Pixi-CG/` 复制到 SD 卡根目录，用 hbmenu **应用模式**启动新版。旧的独立 forwarder 内嵌旧代码；先用主程序，之后按需重建 forwarder。
2. 选择 `Add Game` → `BurialNX-Pixi-CG/www`。使用单独的 SD 存档位置即可，样例不写剧情进度。运行后**不会自动开始**。按 **A** 会先播 MP4（H.264/AAC），再播 WebM（VP8/Opus）。两段都只占游戏中央一个矩形，外面保留蓝色背景和文字。每段有 4 次白闪、4 个短音；对闪光敏感者请跳过参考片。结束后画面应变绿，并显示 `DONE`。
3. 要按相同路径测试自己的 CG，把片段**复制、不转码**到样例的 `www/movies/my-texture.mp4` 或 `my-texture.webm`，从样例开始画面按 **X** 或 **Y**。若此处正常、原游戏不正常，再排查触发插件或其绘制方式。无需上传游戏、密钥或存档。

## 验证边界与诊断

- 显式指定 `video.src` 优先；显式 `<source>` 列表按顺序选择，跳过不支持的 MIME 类型。某一候选路径不存在、容器明显不符或首次解码失败时尝试下一项。全部失败才向 video 报 `error`；已经开始播放的片段若损坏，不自动偷换成另一段剧情。
- 仍限定本地游戏/模组资源；不启用对外部 URL 的加载。短片在确实出过可画帧时可进入就绪态；从未获得画面则不会伪造开始。底层 FFmpeg 探测本质上不能保证任何随意改扩展名的文件都是有效视频。
- 参考样例的第二段故意列出不支持的类型、不存在的文件、伪装成 WebM 的文字、损坏的 WebM，再放真正的 WebM。`mislabeled.webm` 和 `broken.webm` 是**特意准备的测试数据**，不是需要修复或观看的影片。
- 本次用桌面宿主加载 NRO 中实际的应用与 nx.js 影音 JS，连接同标签原生解码和音频图，并运行 RPG Maker MV 公开代码仓库原样提供的 PixiJS 4.5.4。取样的是最终屏幕上的精灵区域、精灵外的游戏背景和左右声道 PCM。不是执行 Switch ARM 机器码，也不是实体屏幕/扬声器的测试。此处验证 **CanvasRenderer**，不代表任意 WebGL 视频滤镜、编解码器、商业插件或大码率都能完美运行。

若需要手动记录全屏视频的真机听感/片尾，可以用包中独立的 `BurialNX-CG-device-check/www`；这不是纹理测试的替代。该工具只有在手动确认和同意保存后才写本地报告。

对照实现：[MV 随附 PixiJS](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/libs/pixi.js#L26509-L26529)。本包内的 `js/pixi.js` 保留原文件和内嵌声明；对应许可见 `BurialNX-Pixi-CG/licenses/`。不含商业游戏文件。
