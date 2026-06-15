# SoulFrame · AI 虚拟角色系统

可创建、可驱动、可交互、有人格、有记忆的 AI 虚拟角色平台。形象层为 **VRM 3D 主线 + Live2D 模板线** 双渲染体系（V1.2，三层定制：模板 → 捏脸 → AI 全自动生成）。
AI 能力统一通过 [AgentLLM Gateway](https://agentllm.linkyun.co/docs) 获取。

## 仓库结构

```
backend/         FastAPI 模块化单体（AI Adapter / Embedding 抽象层 / 角色与人设 / 记忆服务 / WS 实时协议）
frontend/        Vite + React + AntD 控制台（工作台/角色管理/创建向导/Live2D 聊天页/记忆/设置）
docs/            需求文档 / 技术架构 / 原型清单（V1.0 rtf+txt，V1.1 优化版 md）
preflight/       AI 平台前置预检脚本（LLM/TTS/ASR/实时对话/文生图/RAG/网络基线）
live2d-demo/     Live2D 浏览器渲染 + 口型同步验证页（独立最小验证）
docker-compose.yml  PostgreSQL(pgvector,5433) / Redis / MinIO
.env.example     环境变量模板（密钥放 .env，已被 git 忽略）
```

## 端口约定

| 端口 | 服务 |
| --- | --- |
| 5173 | 前端 Vite 开发服务器（`/api`、`/healthz` 代理到 8787，含 WS） |
| 8787 | 后端 FastAPI（本机 8000/8080 已被其他服务占用，勿用；可用 .env 的 `API_PORT` 调整） |
| 5433 | PostgreSQL/pgvector 容器（宿主机 5432 已占用） |

## 后端启动

```bash
# 1. 基础设施（pgvector 映射在宿主机 5433，避开本机已有的 5432）
docker compose up -d

# 2. 依赖（Python 3.12）
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# 3. 启动（首次会下载本地 embedding 模型 BAAI/bge-small-zh-v1.5 ≈95MB）
cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
# 文档: http://127.0.0.1:8787/docs   健康: /healthz
```

### Embedding 双提供方（本地 ↔ 线上热切换）

当前网关未开通 `/v1/embeddings`，默认走**本地模型**；管理员开通后一行命令切到线上：

```bash
# 查看当前提供方
curl http://127.0.0.1:8787/api/v1/embeddings/provider
# 切到网关线上模型（切换前自动探活，失败会拒绝并保持原提供方）
curl -X PUT http://127.0.0.1:8787/api/v1/embeddings/provider \
  -H "Content-Type: application/json" \
  -d '{"kind":"gateway","model":"实际模型名"}'
# 维度变化时重建已入库向量
curl -X POST http://127.0.0.1:8787/api/v1/memories/reindex
```

本地模型升级（生产推荐 bge-m3，1024 维）：`.env` 设 `LOCAL_EMBEDDING_MODEL=BAAI/bge-m3` 后重启，并执行一次 reindex。

### 常用接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/embeddings/similarity` | 语义相似度（无需DB，快速验证） |
| `POST /api/v1/memories` / `GET /api/v1/memories/search?q=` | 记忆写入 / pgvector 语义检索 |
| `GET/POST/PUT/DELETE /api/v1/characters` | 角色 CRUD（草稿 draft_config） |
| `POST /api/v1/characters/{id}/publish` | 发布：草稿固化为不可变版本快照 v1,v2,… |
| `WS /api/v1/realtime` | V1.1 §5 实时事件协议：文本回合（`text.input`→`llm.delta`流→`turn.end`）+ 语音通话（`voice.start`→二进制PCM上行/下行→`vad.*`/`asr.final`/`turn.*(motion)`），均支持 `interrupt` |
| `POST /api/v1/characters/agent-draft` | Agent 建角：描述 → 完整角色配置 JSON（确认后再落库） |
| `POST /api/v1/assets/background` / `portrait` | AI 生成舞台背景 / 角色立绘（gpt-image-2 降级链，产物落 `storage/` 经 `/files` 服务） |
| `POST /api/v1/assets/avatar3d` → `GET .../{task_id}` | AI 形象工厂：立绘/图片 → 图生3D → 自动绑骨 GLB（需 `MESHY_API_KEY` 或 `TRIPO_API_KEY`） |

## 前端启动

```bash
cd frontend && npm install && npm run dev
# 打开 http://localhost:5173 （需先启动后端 8787）
```

已实现页面（对照产品原型 V1.1）：

- **工作台首页**：角色统计、最近角色、推荐模板快速建角
- **我的角色**：卡片列表，互动 / 编辑 / 发布 / 删除
- **创建角色**：创建方式二选一
  - *Agent 智能创建*：一句话描述 → `POST /characters/agent-draft` 生成完整设定（名字/性格/背景/外观/音色）→ 确认发布 或 进向导微调
  - *手动 8 步向导*：基础信息→外观→声音→人格→知识库→能力→形象(2D/3D)→预览发布
- **形象系统（V1.2 核心）**：`AvatarStage` 统一抽象，按角色配置切换渲染
  - *VRM 3D 主线*：`VRMStage`（three.js + @pixiv/three-vrm），全身取景，表情/自动眨眼/口型 viseme、程序化动作（挥手/点头/歪头/低落/惊讶）；VRM0/VRM1 旋转方向自动适配
  - **真舞蹈（VMD mocap）**：跳舞开关播放 MMD 成品舞 wavefile（含配乐，`frontend/public/motions/`），`lib/vmdDance.ts` 重定向到任意 VRM（日文骨名映射 + rest-pose 补偿 + 下半身/上半身结构差修正），加载失败退回程序化节拍舞
  - *AI 生成形象线*：`GLBStage` 渲染绑骨 GLB（自动取景 + 内嵌动画播放）
  - *Live2D 模板线*：`Live2DStage`（Haru），口型参数 + 动作组
  - **模型资产全部本地化**在 `frontend/public/models/`（VRoid 官方 AvatarSample A/B + Alicia + Seed-san 四套 VRM + Haru Live2D 全套），不依赖外部 CDN
  - **舞台背景可设置**：6 种预设渐变 / **AI 一句话生成背景**（自动入背景库复用）/ 自定义图片 URL，按角色记忆
- **AI 形象工厂（路线图 P2）**：向导第 7 步「AI 生成专属形象」——描述（按设定预填）→ 生成 A-pose 全身立绘 → 确认 → 图生 3D + 自动绑骨（Meshy/Tripo，配 Key 启用）→ GLB 预览上台
  - Agent 建角与向导均输出 `avatar` 字段；旧角色自动兼容
- **角色聊天页**：左 Avatar 舞台（2D/3D 自适应）+ 右流式聊天
  - 文字模式：LLM 流式回复，正弦口型，显示首字延迟
  - **电话式语音通话**：点「开始通话」后连续收音（无需按住说话），Qwen-Omni Realtime 端到端，server VAD 自动断句，**开口即打断**；下行音频 RMS 直驱口型；情绪→动作反馈（happy→挥手/TapBody 等，2D/3D 通用）
- **记忆管理**：记忆增删 + pgvector 语义搜索（显示相似度）
- **个人设置**：系统状态总览、Embedding 本地⇄网关热切换、重建向量索引

人设链路：向导/Agent 保存的 persona 配置 → 发布快照 → 聊天页按 character_id 拼装系统提示词（`backend/app/services/persona.py`），文字与语音两条路共用。

### 语音通话链路（实测回环 OK）

```
浏览器麦克风 → AudioWorklet(PCM16@16k, 80ms帧) → WS 二进制 → 后端 OmniRelay
  → 网关 /v1beta/dashscope/realtime/ws (qwen3-omni-flash-realtime, server_vad)
  → 下行 PCM16@24k 二进制帧 → 前端 AudioBuffer 队列播放 → Analyser RMS → Live2D 口型
事件流：voice.start → voice.ready → vad.speech_start/stop → asr.final + llm.delta
        + turn.start/end(motion)；用户开口 → response.cancel + 前端停播 = 打断
```

防"连发多条回复"机制：server VAD 调参（threshold 0.6 / 静音 700ms 判停）+
前端回声门控（助手播音期间低于打断阈值的麦克风帧替换为静音上传，保留大声打断）。

实测（本机 → 网关）：VAD 断句后 0.2s 出 turn.start、随即流式音频；角色人设（口头禅/性格）在语音回复中保持。

## 前置条件验证（开发前必跑）

```bash
# 1. 配置密钥
cp .env.example .env   # 填入 AGENTLLM_API_KEY

# 2. 安装依赖
python3 -m venv .venv
.venv/bin/pip install -r preflight/requirements.txt

# 3. 全量预检（约 2~4 分钟，消耗少量额度）
cd preflight && ../.venv/bin/python run_all.py
# 可跳过某些项：run_all.py --skip image rag
# 结果写入 preflight/output/report.json
```

最近一次预检结论见 `docs/前置条件验证报告.md`。

## Live2D 渲染 + 口型同步验证

```bash
# 需先跑过预检（生成 TTS 语音样本），然后从项目根目录启动静态服务：
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/live2d-demo/
```

页面验证：官方示例模型渲染、随机动作、用豆包 TTS 真实语音经 WebAudio RMS 驱动 `ParamMouthOpenY` 口型。

## 关键文档

| 文档 | 说明 |
| --- | --- |
| `docs/AI虚拟角色系统技术架构设计文档 V1.2.md` | 最新架构：Avatar 三层定制体系（V1.2）、收敛选型、WS 实时协议、实测延迟预算 |
| `docs/虚拟人物可定制化可行性研究.md` | VRM 3D 主线决策依据：路线对比、技术拼图、分期计划 |
| `docs/需求文档与原型清单 V1.1 修订说明.md` | 对 V1.0 需求/原型文档的修订项 |
| `docs/前置条件验证报告.md` | AgentLLM 平台实测能力矩阵与缺口清单 |

## 安全提醒

- 租户密钥只放 `.env`（已 gitignore），**严禁**写入前端代码或提交到仓库。
- 浏览器端一律不直连网关（会暴露密钥），所有 AI 调用经由后端代理。
