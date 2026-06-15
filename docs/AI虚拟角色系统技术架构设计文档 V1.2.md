# AI 虚拟角色系统 技术架构设计文档 V1.2

| 项 | 内容 |
| --- | --- |
| 版本 | V1.2（V1.1 基础上新增 Avatar 可定制体系；替代 V1.0 rtf 版） |
| 日期 | 2026-06-11 |
| 适用对象 | 架构师、前端、后端、AI 工程、Avatar/Live2D 工程、运维 |
| 配套文档 | 《前置条件验证报告.md》《需求文档与原型清单 V1.1 修订说明.md》《虚拟人物可定制化可行性研究.md》 |

## 0a. V1.1 → V1.2 修订记录（核心：虚拟人物可定制、可由 AI 构建）

| # | 修订 | 原因 |
| --- | --- | --- |
| 1 | 形象层从「单一 Live2D」升级为 **Avatar 双渲染体系**：VRM 3D 主线 + Live2D 模板线，前端统一 `AvatarStage` 接口 | 核心需求：人物不写死，要捏脸式定制并由 AI 构建；Live2D 自动生成无可靠方案（见可行性研究） |
| 2 | 新增 **三层定制体系**：L1 模板库 → L2 traits 捏脸 → L3 AI 全自动生成（文生图→3D→自动绑骨） | 「像捏脸游戏 + 对话调整 + AI 构造」的落地路径 |
| 3 | 角色配置新增 **avatar 字段**（替代原 live2d 字段，向下兼容） | 一份配置同时描述 2D/3D 形象与 traits |
| 4 | 新增 **动作/舞蹈系统**：Mixamo 动作经 vrm-mixamo-retarget 重定向 + VMD(MMD) 舞蹈；情绪→动作映射复用 `motion` 事件 | 动作一次建设、全角色通用（VRM 标准人形骨骼） |
| 5 | WS 协议下行新增 `motion` 载荷（已实现）、规划 `avatar.update`（对话式捏脸，P1） | 与实现同步 + 对话调整外观的协议位 |
| 6 | 数据模型新增 `avatar_asset` 表（AI 生成资产的任务状态机） | L3 异步生成管线需要 |
| 7 | 实时语音已实现为 **路线B 优先**（Omni Realtime 中继，电话式 + server VAD + barge-in），路线A 退为文本/备选 | 实现进度超前于 V1.1 规划，按实际收敛 |

## 0. V1.0 → V1.1 修订记录

| # | 修订 | 原因 |
| --- | --- | --- |
| 1 | 技术选型从「每项 2~3 候选」收敛为单一栈 | V1.0 未拍板，无法开工 |
| 2 | MVP 架构从微服务改为**模块化单体** | 微服务+网关+MQ 与 4~6 周排期矛盾 |
| 3 | 统一AI聚合平台落实为 **AgentLLM Gateway**，给出实测模型清单与端点映射 | 平台已实测打通（见前置条件验证报告） |
| 4 | 新增 **WebSocket 实时事件协议** 完整定义 | V1.0 只有 REST，实时链路无协议依据 |
| 5 | 实时链路明确两条路线：三段式管线 + Realtime 端到端，且 MVP 两者都接 | 平台原生支持 Qwen-Omni Realtime（实测可用） |
| 6 | 性能指标改为首包口径，并按实测数据修正 | V1.0 文字<2s 与需求 2~5s 互相矛盾，且未考虑网络基线 |
| 7 | 移除 Celery 在实时链路中的角色（仅离线任务）；移除 MVP 阶段的 MQ/Mongo/Milvus/Kong | 任务队列不能进实时流 |
| 8 | 数据模型补 Message 表、角色配置版本化、记忆 embedding 字段 | V1.0 缺口 |
| 9 | 新增部署位置约束：后端必须与 AI 网关低 RTT 部署 | 实测发现网络是延迟第一瓶颈 |
| 10 | ASR/TTS/LLM 选型按实测更新（弃用 Whisper/VITS/Coqui 方案） | 平台已提供更优托管能力 |

## 1. 总体架构

分层不变（用户端/接入层 → 角色创建工作台 → 角色资产与驱动层 → 实时交互引擎 → 统一AI聚合平台 → 数据与平台支撑层 → 输出能力层），实现形态修订为：

- **MVP：模块化单体**（FastAPI 单服务 + 前端 SPA），模块边界清晰（character / session / realtime / asset / memory / ai-adapter / admin），二期再按模块拆微服务。
- **统一AI聚合平台 = AgentLLM Gateway**：LLM、文生图、ASR、TTS、Realtime、（音乐/视频，远期）全部经网关获取，密钥仅存在于后端。
- **浏览器永不直连网关**（避免租户密钥泄露），实时音频经由自建后端 WS 代理转发。

```
浏览器/桌面端 (React + PixiJS + Live2D + AudioWorklet)
      │  WSS（自定义实时事件协议） + HTTPS（REST）
      ▼
后端 模块化单体 (FastAPI, asyncio)
  ├─ REST: 账号/角色CRUD/资产/记忆/后台
  ├─ Realtime Orchestrator: VAD边界→ASR→人格Prompt→LLM→切句→TTS→音频帧
  ├─ AI Adapter: AgentLLM Gateway 客户端（流式、超时、降级、用量记账）
  └─ Offline Worker (Celery+Redis): 记忆抽取/文档向量化/资产处理
      │  低RTT内网/同区域（硬性要求 <50ms）
      ▼
AgentLLM Gateway ──► LLM / 文生图 / ASR / TTS / Realtime
      ▼
PostgreSQL(+pgvector) · Redis · MinIO/S3
```

## 2. 技术选型（已收敛，MVP 拍板）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | React 18 + TypeScript + Vite | SPA，后台共用组件库（Ant Design） |
| Avatar 渲染（3D 主线） | three.js + @pixiv/three-vrm | VRM 标准人形骨骼/表情/口型；承接捏脸与 AI 生成形象 |
| Avatar 渲染（2D 模板线） | PixiJS 6 + pixi-live2d-display (Cubism 4) | 模板风格选项；已在 `live2d-demo/` 验证 |
| 动作/舞蹈 | `vrmMotions.ts` 通用动作库（Mixamo FBX/GLB → VRM 世界方向跟随重定向，manifest drop-in，UAL CC0 兜底）+ VMD 舞蹈（最高优先级） | 模型与动作彻底解耦，动作库全 VRM 角色通用；程序化动作最终兜底。重定向算法：源骨世界指向恒等转移 + 绑定姿态差吸收（A/T-pose 兼容）+ 源朝向校正，逐帧采样不解析轨道名 |
| 音频采集/播放 | Web Audio API（AudioWorklet）+ 浏览器内建 AEC | PCM16 分帧上行；下行帧低缓冲播放 |
| 实时通信 | WebSocket（自定义事件协议，见 §5） | WebRTC 留作二期移动端弱网优化 |
| 后端 | Python 3.12 + FastAPI + asyncio | 单体多模块；uvicorn 多 worker |
| 离线任务 | Celery + Redis | 仅离线：记忆抽取、向量化、拆图辅助 |
| 数据库 | PostgreSQL 16 + pgvector | 结构化 + 向量一库搞定，MVP 不上独立向量库 |
| 缓存/会话 | Redis 7 | 会话状态、短期记忆、限流计数 |
| 对象存储 | MinIO（私有化）或云 OSS | Live2D 资产包、原画、语音样本 |
| 反向代理 | Nginx | TLS 终结、静态资源、WS 升级 |
| 部署 | Docker Compose（MVP）→ K8s（二期） | 单区域，与 AI 网关低 RTT |
| 监控 | Prometheus + Grafana + Loki | 含语音链路分段延迟埋点 |

**MVP 明确不引入**：微服务拆分、Kafka/RabbitMQ、独立 API 网关（Kong 等）、MongoDB、Milvus/Pinecone、Unity。

## 3. 统一AI聚合平台接入（AgentLLM Gateway，实测）

### 3.1 模型选型矩阵（依据 2026-06-11 实测）

| 用途 | 模型 | 端点 | 实测结论 |
| --- | --- | --- | --- |
| 实时语音对话 LLM | **M2-her** | `POST /v1/chat/completions` (stream) | 首token最快（扣网络后≈0.6s）、真增量流式、角色扮演调优；注意剥离说话人前缀 |
| 文本聊天 LLM（降级链） | M2-her → MiniMax-M2.7-highspeed → deepseek-v4-flash | 同上 | M2.7 需过滤 `<think>`；deepseek 防思考耗尽需设 max_tokens≥256 |
| 人设生成/审核辅助 | claude-sonnet | 同上 | 质量最好，非实时场景 |
| TTS 主链路 | **doubao-tts**（vivi 2.0 等 4 音色） | `POST /v1/audio/speech`（流式 wav/pcm/opus） | 稳定；首字节扣网络后≈0.5s；增量合成可升级 `WS /v1beta/volc/tts/ws` |
| TTS 备份 | speech-02-turbo | `POST /v1beta/minimax/t2a_v2` (SSE) | 实测不稳定，仅降级用 |
| 流式 ASR | **fun-asr-realtime**（或 paraformer-realtime-v2） | `WS /v1beta/dashscope/asr/ws` | DashScope 协议，`task_id` 必填 UUID；回环识别召回 0.85 |
| 端到端语音对话 | **qwen3-omni-flash-realtime** | `WS /v1beta/dashscope/realtime/ws` | OpenAI Realtime 协议，自带 barge-in，74 音色 |
| 文生图（立绘） | **gpt-image-2**（首选） / linkyun-image-default（降级） | `POST /v1/images/generations` | gpt-image-2 已开通：57s/1024²，质量高；默认模型 11s/1024² 作快速降级 |
| Embedding / Rerank | **缺口** | `/v1/embeddings` `/v1/rerank` | 全部 404 未开通 → 找管理员开通，或本地 bge-m3（MVP 推荐） |
| 声音克隆 | minimax voice_clone | `/v1beta/minimax/voice_clone` | 平台支持，合规评审后二期接入 |

### 3.2 接入规范

- 密钥：仅后端 `.env`（`AGENTLLM_API_KEY`），按服务实例一 key 便于审计。
- 降级：AI Adapter 内置模型降级链 + 超时（LLM 首包 8s、TTS 首包 6s）+ 一次重试；也可用网关 `c-` 别名做 fallback 链。
- 缓存：确定性请求自动命中网关缓存（`x-cache` 头）；实时链路显式 `x-cache: off`。
- 记账：每次调用落 `usage_log`（tenant/user/character/model/tokens/时长），与网关 dashboard 对账。
- 思考段过滤：编排器统一剥离 `<think>…</think>` 与说话人前缀，再进 TTS。

## 4. 实时语音架构：双路线并存

| | 路线A：三段式管线 | 路线B：Realtime 端到端 |
| --- | --- | --- |
| 链路 | VAD→ASR→LLM→切句→TTS | 浏览器→后端代理→qwen3-omni-realtime |
| 延迟（后端与网关低RTT时） | ≈2.4~3.2s | 预计 ≈2~3s（本机直连实测5.9s，主因RTT） |
| 可控性 | 人格Prompt/记忆/RAG/工具全可插 | instructions 一次性注入，中途换人设需重连 |
| 音色 | 豆包 4 音色（可加购） | Qwen 74 音色 |
| 打断 | 自实现（客户端VAD+全链路取消） | 模型自带 barge-in |
| MVP 角色 | **默认路线**（功能完整） | **加分路线**（低延迟模式/快速演示） |

编排器抽象统一的 `VoiceSession` 接口，两条路线可按角色配置切换。

## 5. WebSocket 实时事件协议（前后端契约，第 1 周冻结）

连接：`WSS /api/v1/realtime?character_id=...&mode=voice|text`，子协议 JSON 文本帧 + 二进制音频帧。

### 5.1 上行（客户端 → 服务端）

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `session.start` | `{character_id, mode, voice_id?}` | 开始会话 |
| `audio.chunk` | 二进制帧（PCM16 16kHz mono，100ms/帧） | 持续推流（说话间隙也推，便于服务端VAD兜底） |
| `audio.end` | `{}` | 客户端 VAD 判停（主判停在客户端） |
| `text.input` | `{text}` | 文字输入 |
| `interrupt` | `{}` | 打断：服务端级联取消 ASR/LLM/TTS |
| `session.end` | `{}` | 结束会话 |

### 5.2 下行（服务端 → 客户端）

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `session.ready` | `{session_id, route: "pipeline"\|"realtime"}` | 就绪 |
| `asr.partial` / `asr.final` | `{text}` | 识别中间/最终结果（UI 实时上屏） |
| `llm.delta` | `{text}` | 回复文本增量（字幕） |
| `emotion` | `{label, intensity}` | 句级情绪标签 → 前端查表映射表情/动作 |
| `tts.chunk` | 二进制帧（PCM16 24kHz）+ 序号头 | 边合成边推；前端 RMS 驱动口型 |
| `tts.sentence_end` | `{index}` | 句边界（驱动动作节奏） |
| `turn.end` | `{usage, motion}` | 本轮结束；`motion:{emotion, group}` 驱动动作反馈（已实现） |
| `interrupted` | `{at_index}` | 打断确认（保留已输出文本） |
| `avatar.update` | `{traits_diff}` | （P1 规划）对话式捏脸：LLM 解析外观指令后下发，前端实时重渲染 |
| `error` | `{code, message, recoverable}` | 错误与降级提示 |

情绪标签来源：要求 LLM 在系统提示词约定下输出轻量标记（如句首 `[happy]`），编排器解析剥离后下发 `emotion` 事件，前端按《原型清单 §11.3 表情联动规则》映射。

### 5.3 打断语义

收到 `interrupt`：取消 LLM 流 → 停止 TTS 任务 → 丢弃未发送音频帧 → 回 `interrupted`。客户端立即停播、口型归零。已上屏文本保留（与原型清单 11.4 一致）。

## 6. 性能指标（V1.1 修订，统一首包口径）

| 指标 | 口径 | MVP 验收（P50 / P95） | 目标值（优化后） |
| --- | --- | --- | --- |
| 文本首字 | 发送 → 首个 `llm.delta` | ≤2.5s / ≤5s | ≤1s |
| 语音首响 | 用户说完(VAD判停) → 首个 `tts.chunk` 播放 | ≤4s / ≤6s | ≤3s |
| 打断生效 | `interrupt` → 停播 | ≤300ms / 500ms | ≤200ms |
| Live2D 渲染 | 前端帧率 | ≥30fps | 60fps |
| 并发语音会话 | 单部署 | 50~100（压测定容） | 1000+（二期扩容） |
| 可用率 | 核心服务 | ≥99% | ≥99.5% |

**硬性前置（实测结论）**：后端部署区域到 AI 网关 RTT 必须 <50ms。开发机直连实测 RTT≈1.35s 时，三段式管线端到端≈11s（不可用）；扣除网络后模型耗时≈2.4~3.2s（达标）。上线前用 `preflight/check_net.py` 在目标机房复测。

## 7. 数据模型（V1.1 修订）

V1.0 对象保留，新增/修订：

```sql
-- 角色配置版本化：发布 = 不可变快照，编辑草稿不影响线上
character(id, owner_id, tenant_id, status, draft_config jsonb, created_at, ...)
character_release(id, character_id, version, config jsonb, live2d_asset_id,
                  published_at, status)  -- 会话绑定 release 而非草稿

-- 消息级记录（V1.0 只有 session，缺口）
message(id, session_id, role, content, emotion_label, input_mode,
        asr_final text, tool_calls jsonb, latency_ms jsonb, created_at)
-- latency_ms 记录 {vad, asr, llm_ttft, first_sentence, tts_first, e2e} 用于线上延迟看板

-- 记忆补向量与生命周期
memory(id, user_id, character_id, memory_type, content, tags,
       importance_score, embedding vector(1024), source_session_id,
       expires_at, user_visible bool default true, created_at)

usage_log(id, tenant_id, user_id, character_id, model, kind,  -- llm/tts/asr/image/realtime
          tokens_in, tokens_out, audio_seconds, chars, cost_est, created_at)

-- V1.2：AI 生成形象资产的任务状态机（L3 管线）
avatar_asset(id, character_id, kind,          -- portrait/model3d/rigged/vrm
             status,                          -- pending/generating/preview/confirmed/failed
             provider, provider_task_id,      -- meshy/tripo/gateway
             source_image_url, model_url, preview_url,
             cost_est, error, created_at, updated_at)
```

## 8. 关键流程

### 8.1 三段式语音回合（路线A）

1. 客户端持续推 `audio.chunk`，本地 VAD 判停发 `audio.end`（服务端 ASR 静音检测兜底）
2. ASR final → 编排器拼装 Prompt：人格(release快照) + 画像槽位记忆 + 近N轮摘要 +（命中时）RAG 片段
3. M2-her 流式生成；按 `。！？；` 或 ≥24 字切句；剥离 think/前缀/情绪标记
4. 句级并行送 doubao-tts（流式 wav），音频帧按句序下发；同时发 `llm.delta`、`emotion`
5. `turn.end` 后异步：消息落库、延迟埋点、（每5轮或会话结束）Celery 记忆抽取

### 8.2 记忆

- 短期：Redis 会话上下文 + 超过 N 轮滚动摘要（LLM 离线压缩）
- 长期（MVP）：画像槽位（称呼/偏好/关系/关键事实，固定 schema）注入系统提示词
- 长期（二期）：episodic 向量记忆（pgvector 检索 top-k 注入），依赖 embedding 缺口关闭
- 合规：记忆用户可见可删（前台记忆管理页），`禁止记忆` 规则在抽取阶段过滤

### 8.3 Avatar 资产体系（V1.2 核心：三层定制，互为兜底）

角色配置中的形象描述统一为 `avatar` 字段：

```jsonc
"avatar": {
  "type": "vrm_template | vrm_traits | ai_generated | live2d_template",
  "template_id": "sample_a",        // L1：模板
  "vrm_url": "https://.../x.vrm",   // 模型地址（模板内置 / 生成后回填）
  "traits": {                        // L2：捏脸参数（部件 + 调色），LLM 可直接生成/修改
    "hair_style": "long_twin", "hair_color": "#C0C8FF",
    "eye_color": "#7B5CFF", "skin_tone": "fair",
    "outfit": "sailor_blue", "accessories": ["ribbon"]
  },
  "motions": {"idle": "breath", "happy": "wave", "dance": "dance_01"},  // 情绪→动作映射
  "portrait_url": "..."              // 文生图立绘（头像/参考图）
}
```

- **L1 模板库**：VRM 模板（商用授权/CC0）+ Live2D 模板（Haru 等）。选完即用；Agent 建角由 LLM 按描述挑模板。
- **L2 traits 捏脸**：部件化组装 + 材质调色，traits JSON 全量描述外观。AI 捏脸 = LLM 描述→traits（与 agent-draft 同构）；对话调整 = 聊天指令→traits diff→`avatar.update` 事件→前端实时重渲染。资产规范借鉴 CharacterStudio（MIT）。
- **L3 AI 全自动**：网关文生图立绘（用户确认）→ Meshy/Tripo image-to-3D → 自动绑骨（优先 Mixamo 骨架）→ 转 VRM / rigged GLB → `avatar_asset` 入库回填 `vrm_url`。Celery 异步任务（1~3 分钟），质量门控（预览→确认→重roll），失败兜底回 L2/L1。
  - **2026-06-12 实测落地（Tripo3D 直连）**：`upload/sts`（上传立绘）→ `image_to_model`（model_version v3.0-20250812，~2min）→ `animate_prerigcheck`（免费人形预检）→ `animate_rig`（model_version v1.0-20240301 + spec=mixamo，~2min），端到端 ≈4.5 分钟，产出 mixamorig 标准骨架 T-pose GLB（静态 + 绑骨双版本落盘 `storage/models3d/`）。动画不再用 `animate_retarget` 烘焙（仅 preset 动作、姿态僵硬）：前端内置 Quaternius UAL 动作库（CC0，46 clips），`glbMotions.ts` 世界空间重定向实时驱动 站立/说话/舞蹈/互动，非 mixamo 命名骨架走拓扑推断映射。注意：实测 v2.5-20260210 的 GLB 输出忽略 spec 恒为 tripo:: 私有命名，仅 v1.0 + spec=mixamo 直出标准骨架。外网访问经 `.env OUTBOUND_PROXY` 代理，网关调用强制 `trust_env=False` 直连。Meshy 适配器保留为降级链路（Key 待充值）。
- **动作/舞蹈**：Mixamo 动作集经 vrm-mixamo-retarget 重定向（一次建设全角色通用）+ VMD 舞蹈播放（参考 lobe-vidol，Apache-2.0）；程序化动作（呼吸/点头/挥手/眨眼）作为零资产兜底。口型用 VRM 标准 viseme `aa`，沿用 RMS 直驱。
- **用户上传**：VRM 文件直传（校验 + 抽取缩略图）；Live2D model3.json 资源包（服务端校验完整性）。
- 原 V1.1「自动拆图绑定不进 MVP」结论不变 —— 该诉求由 VRM 3D 路线承接。

## 9. 安全与合规

- 密钥隔离：网关密钥仅后端持有；前端零密钥（已在 README 标注红线）
- 内容安全：公开角色上线门槛 = 设定审核 + 输入/输出审核（输出按句级流式审核）；私有角色 MVP 抽检
- 额度熔断：usage_log 实时计数，超额拒绝并提示（防语音链路成本失控）
- 语音克隆：仅在取得声音权利人授权后开放（二期，含授权存证）
- AI 生成内容显著标识（生成式AI管理办法要求）

## 10. 部署架构（MVP）

```
[云区域：与 AgentLLM Gateway 低 RTT]
  Nginx ── 静态前端(SPA) / api.* 反代
  app (FastAPI ×2 worker) ── WS + REST
  worker (Celery)  redis  postgres(+pgvector)  minio
  prometheus + grafana + loki
```

单 Compose 文件管理；数据库每日备份；灰度发布用双实例轮换。二期迁 K8s 时按模块拆 realtime / api / worker 三服务即可。

## 11. 风险与对策（V1.1 更新）

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 部署区域与网关 RTT 不达标 | 高 | 上线前实测；不达标则与网关方协商同机房/专线，或改路线B直连区域 |
| Embedding 未开通拖累知识库 | 中 | MVP 本地 bge-m3 兜底，已列入前置缺口清单 |
| 豆包音色数量少 | 中 | 火山控制台加购；Realtime 路线 74 音色补充 |
| M2-her 单点依赖 | 中 | 降级链 M2.7-highspeed（带think过滤）；网关 `c-` 别名容灾 |
| 自动拆图预期管理 | 高 | 产品文案明确「模板+上传」；该诉求改由 VRM 3D 路线承接（V1.2） |
| 文生 3D 质量方差（脸/手细节） | 中 | 立绘先确认再 3D 化；预览+重roll 门控；失败回退 L2 捏脸 |
| GLB→VRM 转换链未验证 | 中→已缓解 | ✅ 2026-06-12 验证：Tripo rigged GLB（mixamo 标准骨架）+ 前端 UAL 动作库重定向直驱 GLBStage，无需 VRM 转换即可上台（站立/说话/舞蹈/互动全套）；GLB→VRM（统一表情/口型）留 P4 |
| 捏脸部件美术投入 | 中 | 首发 30~50 件核心部件 + 调色放大组合数；复用 CharacterStudio 资产规范 |
| VRM 模板商用授权 | 中 | VRoid Hub 明确商用许可 / 委托定制 / CC0 资产清单化管理 |
