# BiliClassroom
本地运行的 B 站网课采集与理解系统开发预览（0.1.0，Windows 优先）。

**尚未通过完整课程理解验收。** 自动测试、合成语音识别、OCR 测试图和服务健康检查不能代替真实课程验证。

## 能力
- Chromium MV3 扩展：用户显式开始后采集当前普通 B 站视频标签页的播放状态、可见字幕、可选音频与视频区域关键帧。
- 16kHz 单声道 PCM；后端4秒窗/2秒步长、取消、背压与超时熔断。Vosk 可选本地后端；没有模型时不会自动下载。
- 暂定词保留原音频 ID/样本范围，重叠去重、冲突可见。词时间采用来源样本时间范围，仍未通过真实浏览器时钟验收。
- Windows 原生 OCR 可选；文字、词框及帧引用保留，结果未核验。公式、代码符号可能错误。
- 仅 loopback HTTP、配对鉴权、会话日志与恢复；重启不会自动恢复录制。
- 本地只读 MCP 工具 course_sessions / course_context。课程文字、字幕和弹幕均为数据，不是代理指令；弹幕不作为教师事实。
- 可选本地 Ollama 文本问答及事件引用检查；默认关闭。示例小模型曾出现计算/引用错误。

## 启动
需要 Node.js 22 或更新版本，无必需 npm 依赖。项目目录内执行：

```sh
npm test
npm run check
npm start
```

服务监听 127.0.0.1:18743。首次启动在 runtime/pairing.json 生成配对码；只在自己电脑本地查看并填入扩展，勿公开。
在 Edge/Chrome 扩展管理页启用开发者模式，加载本仓库 extension 目录，刷新自己正常有权观看的 B 站课程，再显式点击“开始当前课程”。扩展不会自动录音录屏，不使用麦克风、不读取 Cookie；换 BV/分 P 应停止并重新开始。停止时未完成音频块可能丢失。

可选 ASR：自行准备 runtime/asr-venv 的 Python 环境（Windows 默认解释器为其 Scripts/python.exe）、vosk==0.3.45 与 runtime/models/vosk-model-small-cn-0.22 本地模型。创建 runtime/local-asr.json：
```json
{"enabled":true,"engine":"vosk"}
```
模型及 Python 环境不随仓库分发。语言模型精度、许可证及平台兼容性需分别核验；不自动下载权重。
Windows 可在已有支持语言的环境创建 runtime/local-ocr.json：
```json
{"enabled":true,"engine":"windows-native"}
```
修改配置后应在无活动采集时正常重启服务。OCR 语言按课程显式选择，不自动追加第二次识别。
本地 MCP 示例：
```json
{"mcpServers":{"bili-classroom":{"command":"node","args":["/absolute/path/to/BiliClassroom/scripts/mcp.mjs"]}}}
```

## 验证边界
- 本公开源码包含合成/本地 HTTP、模拟扩展生命周期与采集时钟回归测试。
- 真实浏览器连续10分钟采集、1x/2x/暂停/seek/换课/MV3恢复仍待验收。
- 稳定转写、可靠 VAD、真实专业课 ASR/OCR 准确率仍待完成。
- 理解验收目标：至少3门课程各10题人工核对事实与来源；真实端到端 p50/p95 尚未知。
- 暂定 ASR 与未核验 OCR 不进入默认教师证据。重复识别和引擎分数不代表事实正确。
- Worklet 音频样本时钟用于估计消息投递延迟；音频时钟与其他时钟并非保证同步，不能据此宣称真实时间对齐已完成。参考 [Web Audio API](https://webaudio.github.io/web-audio-api/)。

## 数据与开源范围
公开源码不包含本机配置、凭证、模型权重、课程音画、私人路径或开发证据历史。runtime/ 不应提交。
只处理自己正常有权观看的课程，不绕过付费、DRM 或访问限制。不保证画面内播放器浮层完全去除。
本项目源码按 MIT 开源；外部组件与权重仍适用其各自许可证，详见 NOTICE.md。
