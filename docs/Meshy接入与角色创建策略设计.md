# Meshy 接入与角色创建策略设计

> 2026-06-12 · 依据 [docs.meshy.ai](https://docs.meshy.ai/en) 全量研读 + 双 Key 实测（余额 2150 / 1100 credits）
> 关联：《系统优化路线图 V1.0》P2 形象工厂、《AI虚拟角色系统技术架构设计文档 V1.2》§8.3

## 一、结论先行

**用户文本/图片 → 建模 → 贴图（贴皮）→ 绑骨 → 动画，Meshy 一家全链路可达**，且各环节均为
正式 OpenAPI（任务制 + 轮询/SSE），与现有 `mesh3d.py` 适配器架构完全兼容：

| 环节 | 接口 | 耗时实测/官方 | 价格（meshy-6） |
| --- | --- | --- | --- |
| 文生建模 | `POST /openapi/v2/text-to-3d` mode=preview（几何，支持 `pose_mode=a-pose`） | 1~2 min | 20 credits |
| 贴图 | 同端点 mode=refine（preview_task_id 串链，支持 texture_prompt） | 1~2 min | 10 credits |
| 图生建模+贴图 | `POST /openapi/v1/image-to-3d`（支持 a-pose / texture_prompt / `target_formats:[glb]`） | 1~3 min | 30 credits |
| 自动绑骨 | `POST /openapi/v1/rigging`（**input_task_id 直接串链**免传文件；附送走/跑两个动画） | <30s | 5 credits |
| 官方动画 | `POST /openapi/v1/animations`（rig_task_id + action_id；同骨架带皮 GLB） | <30s | 3 credits/个 |
| 动作目录 | `GET /web/public/animations/resources`（公开，680 个：Idle×多套、Dancing×33、挥手/鞠躬/倾听/欢呼…） | 即时 | 免费 |
| 余额 | `GET /openapi/v1/balance` | 实测通过 | 免费 |

**单角色成本**：文生路线 20+10+5+3×N ≈ **41 credits**（N=2 动画）；图生路线 30+5+3×N ≈ **41 credits**。
两个 Key 共 3250 credits ≈ **可生成约 75 个完整角色**。

注意事项（文档明确）：
- 绑骨仅支持**人形双足**、贴图后的模型、≤30 万面；`model_url` 方式要求 +Z 朝向，**用 `input_task_id` 串链可避开**（同账号任务链）；
- 任务产物 URL 带有效期（`expires_at`），**必须当场下载落盘**（沿用现有 `storage/models3d/` 方案）；
- 生成失败自动退款（FAILED 任务 `consumed_credits=0`）。

## 二、角色创建策略模式（Strategy）

### 2.1 策略清单

```
CreationStrategy（创建策略）
├── vrm_template      VRM 精选模板（即时、最高质量、口型表情舞蹈全能力）   —— 主推
├── live2d_template   Live2D 2D 模板（即时、口型/动作组）                  —— 2D 线
├── meshy_text3d      一句话 → 三视图出图 → 多视图建模→绑骨→官方动画（~6min）—— Meshy 主链
├── meshy_image3d     立绘/上传图 → 三视图转身图 → 多视图建模→绑骨→动画     —— Meshy 主链
├── tripo_image3d     立绘/上传图 → Tripo 图生3D→mixamo绑骨（~6min）       —— 保留（降级/对比）
└── capsule（规划）    固定基底 + 捏脸换装（P-后1，依赖商用授权基底）
```

后端 `start_avatar3d(strategy=..., multiview=...)` 显式分发；`strategy=auto` 时按 Key
可用性自动选（Meshy 有余额优先 Meshy，文本无图走 meshy_text3d）。**生成引擎在向导内
显式可选**（Meshy 推荐 / Tripo 备选，按 Key 可用性禁用）。

**三视图精准建模（multiview，默认开，2026-06-12 实测上线）**：

```
文本 → text-to-image  (generate_multi_view + a-pose, nano-banana-pro 9cr) ┐
立绘 → image-to-image (generate_multi_view，忠于原图转身, 9cr)            ├→ 同一角色 3 视角图
                                                                          ↓
multi-image-to-3d（input_task_id 串链，30cr，4K 贴图 + 80k 面 + a-pose）→ rigging(5) → 动画(3×3)
```

- 三视角（正/侧/背）联合约束几何，背面/侧面形体精度显著优于单图；
- 全链官方 task 串接（input_task_id），无需自切图/上传中转；
- 三视图参考图随产物落盘（view_1/2/3.png），向导完成态可见（建模依据可追溯）；
- 任一步失败自动降级老链路（直出文生 / 单图图生），任务不整体失败；
- 单角色全链 ≈53 credits（多视图出图 9 + 建模 30 + 绑骨 5 + 动画 9）。

### 2.2 产物统一与舞台兼容

所有 AI 生成策略产出统一为（**归档规范：一任务一子目录**，杜绝平铺散落）：

```jsonc
// storage/models3d/avatar3d_{task_id}/ 下：
//   model.glb（绑骨主模型）/ static.glb / anim_idle|dance|react.glb / view_1|2|3.png
avatar: {
  "type": "ai_generated",
  "glb_url": "/files/models3d/avatar3d_xxx/model.glb",
  "anim_urls": {                                       // Meshy 官方动画（同骨架带皮 GLB）
    "idle":  "/files/models3d/avatar3d_xxx/anim_idle.glb",
    "dance": "/files/models3d/avatar3d_xxx/anim_dance.glb",
    "react": "/files/models3d/avatar3d_xxx/anim_react.glb"
  }
}
```

**动画双层策略**（关键设计）：
1. **Meshy 官方动画优先**：动画 GLB 与绑骨模型同骨架，前端抽取 AnimationClip 直接
   `mixer.clipAction()` 播放（零重定向、零误差，质量=Meshy 官网效果）；
2. **UAL 重定向兜底/扩展**：无 anim_urls（旧资产/Tripo 产物）时沿用 `glbMotions.ts`
   世界空间重定向（拓扑推断映射），动作丰富度不受限。

烘焙动作选型（默认 3 个 9 credits）：`idle`（id 0 Idle）、`dance`（id 83 Superlove Pop）、
`react`（Big Wave Hello id 28，点击互动用）。说话状态用 idle + 程序化头部/手势叠加
（与 VRM 线一致），不烧额外 credits。

**舞蹈选型与穿模治理（2026-06-12 专项）**：AI 绑骨无裙摆骨/布料解算，深蹲/高抬腿
动作必然导致裙装大腿穿模（实测 id 78 Rhythmic Dance 蹲姿帧明显穿模）。治理手段：

1. 量化预检 `backend/scripts/anim_squat_check.py`：零依赖解析 GLB 动画轨道，输出
   髋骨下沉比例 + 大腿最大摆角（<60° 低风险 / 60~90° 中 / >90° 或深蹲 高风险）；
2. 数据驱动选舞 `backend/scripts/bake_dance_candidates.py`：对同一绑骨任务批量烘
   候选舞并跑指标排序（实测：78→59°、83→84°、64→87.6°、76→94°、68→102°，
   舞蹈类大腿摆角普遍 60°+，瞬时轻微穿模属行业常态）；
3. 默认舞改为 **83 Superlove Pop**（站立系无深蹲；分层短裙+过膝靴角色 5 帧逐帧
   目检零可见穿模），GIF 预览抽帧不可靠，以指标+实机目检为准；
4. 绑骨精准度核验：GLBStage 调试句柄 `__glbStage.skeleton(true)` 叠加骨架线框
   （关深度测试透出网格），实测脊柱居中、肩肘膝腕与网格解剖位对齐。

**审美基线与白名单池（2026-06-12 夜，20 支候选 Momo 裙装实拍定稿）**：

流程 = `bake_action_pool.py` 批量烘焙 → 量化指标过滤 → `/dev/anim-review`
逐支多帧截图目检（评审帧存 `/tmp/sf_review/`）。双重过滤后入池
（`backend/app/services/assets.py`）：

| 池 | 入选 | 淘汰及原因 |
| --- | --- | --- |
| idle | 243 安静站立（默认）、244 并腿淑女（温柔/治愈/文艺）、11 放松活泼（元气/可爱） | 12（伸懒腰幅度太大，循环待机抢戏） |
| react | 290 单手挥手（默认）、25 双手欢呼（元气/活泼）、298 抚胸舒气（温柔/治愈） | 41 Formal Bow（触发周期内动作可读性弱） |
| dance | 81(48°)、75(58°)、77(66°)、82(70°)、71(76°)、79(76°)、83(84°·实测无可见穿模) | 67 Bubble Dance（背面裙摆翻起走光感）、69(98°)、65（髋沉 31%） |

注意：Meshy 动作目录名与实际效果存在错位（25 目录名 Agree Gesture 实拍为双手
欢呼、298 反之），**池内键值一律以实拍为准**。

分配规则 `pick_actions(task_id, style_tags)`：性格标签命中优先 → 未命中按
task_id 稳定哈希在池内轮转（同任务幂等），保证**每个角色舞蹈/待机/反应组合
各不相同**。实测：元气可爱={11,82,25}、温柔治愈={244,81,298}、酷={243,71,290}。

**GLB 活感叠加（GLBStage）**：GLB 无 VRM lookAt/眨眼 blendshape，待机像人偶。
在 mixer 写入骨骼后逐帧叠加：① 头骨随鼠标视线跟随（yaw ±12.6°/pitch ±6.9°，
4.5/s 阻尼）；② 胸骨 3.6s 周期呼吸微俯仰。仅 idle/talk 叠加（dance/react 全身
朝向多变会怪异）；采用"先撤销上帧叠加量再施新值"写法，骨骼无动画轨道时不累积。

### 2.3 渲染能力矩阵（产品交互约束）

| 能力 | VRM 模板 | Live2D | AI 生成 GLB |
| --- | --- | --- | --- |
| 口型（音频驱动） | ✅ viseme `aa` | ✅ ParamMouth | ⚠️ 无 blendshape → 头部微动代偿 |
| 表情 | ✅ 5 预设 | ✅ 动作组 | ❌（远期 GLB→VRM 转换补全） |
| 待机/说话/舞蹈 | ✅ 动作库+VMD | ✅ 动作组 | ✅ Meshy 官方动画 + UAL 重定向 |
| 点击互动 | ✅ | ✅ | ✅（react 动画/弹跳） |
| 语音通话 | ✅ | ✅ | ✅ |
| 创建耗时 | 即时 | 即时 | ~4 分钟（全程进度条） |

交互原则：**三舞台对外接口完全一致**（AvatarHandle：setSpeaking/setMouth/motion/dance），
聊天/通话页零感知；向导内 AI 生成卡明示耗时与"实验性"定位，失败一键回退模板。

### 2.4 创建向导交互（CreateWizard）

形象步骤维持「3D / 2D」Segmented，3D 组内卡片：
1. VRM 精选模板 ×4（即时上台）
2. **AI 生成 · 一句话直出**（meshy_text3d：描述 → 4min 出绑骨+动画模型）
3. **AI 生成 · 立绘定制**（meshy_image3d：先出立绘确认形象 → 再 3D 化；可上传自有图）

生成过程沿用现有任务轮询 UI（阶段文案 + 百分比），新增"建模→贴图→绑骨→动画→下载"
五阶段细分；预览即 GLBStage 转台，确认后写入角色 avatar 配置。

## 三、AgentMem 记忆模块预留

用户决策：**统一记忆由外部 AgentMem 承担，本平台不实现记忆逻辑，只留对接位**。

### 3.1 接口抽象（backend/app/ai/memory_provider.py）

```python
class MemoryProvider(Protocol):
    name: str
    enabled: bool
    async def fetch_context(character_id, user_id, query, limit=5) -> str | None: ...
    async def append(character_id, user_id, turns: list[dict]) -> None: ...
    async def aclose() -> None: ...

NullMemoryProvider     # 默认：全部 no-op（当前行为，零开销）
AgentMemProvider       # 预留：读 .env AGENTMEM_BASE_URL / AGENTMEM_API_KEY
                       # REST 占位（/v1/memories/search、/v1/memories），SDK 到位后只改此类
```

### 3.2 挂点（已选定，本次实现）

| 挂点 | 位置 | 行为 |
| --- | --- | --- |
| 文本回合·检索 | `realtime_api.generate()` 组装 messages 前 | `fetch_context()` 非空则注入 system 第二条（`[相关记忆]…`） |
| 文本回合·写入 | `turn.end` 后 fire-and-forget | `append([user, assistant])` |
| 语音通话·检索 | `voice.start` 建 OmniRelay 前 | 记忆上下文拼入 persona 尾部 |
| 语音通话·写入 | Omni `turn.end`（带 ASR+回复文本） | 同上 append |

失败语义：记忆服务任何异常**只告警不阻断对话**（asyncio.shield + try/except）。
user_id 当前单机取 `"local"` 占位，多用户化时替换为会话用户。

## 四、实施顺序

1. `mesh3d.py`：MeshyProvider 补全（text_to_model、a-pose、input_task_id 串链 rig、
   animate(action_id)、balance、SSE 可后续优化为轮询替代）
2. `assets.py`：strategy 分发 + Meshy 全管线（建模→贴图→绑骨→动画→下载）+ anim_urls 产物
3. API/前端：avatar3d 入参加 strategy；client.ts / 向导卡片 / GLBStage 官方动画接入
4. `memory_provider.py` + realtime_api 四挂点
5. 真实 Key 端到端验证（一次文生角色 ≈41 credits）+ 文档回写

## 五、Key 管理

- Key 写入 `.env`（MESHY_API_KEY 主用 2150 分；MESHY_API_KEY_BACKUP 备用 1100 分，
  402 时人工切换），不入库不进前端；
- 每次管线启动前查 balance，<60 credits 拒绝任务并提示充值（避免半途断链浪费）。

## 六、端到端实测（2026-06-12，真实 Key）

`meshy_text3d` 全链路一次通过，**总耗时 4 分 10 秒，消耗 44 credits**（20 几何 + 10 贴图
+ 5 绑骨 + 3×3 动画，与官方计价完全一致）：

| 阶段 | 耗时 | 产物 |
| --- | --- | --- |
| 文生几何（a-pose） | ~80s | preview task |
| 贴图 refine | ~75s | `avatar3d_*_static.glb`（5.0MB） |
| 自动绑骨 | ~30s | `avatar3d_*.glb`（8.9MB，标准 Hips/Spine/…Mixamo 命名骨架） |
| 官方动画 ×3 | ~60s | `*_anim_idle/dance/react.glb`（各 ~9MB，同骨架带皮） |
| 下载落盘 | ~8s | `storage/models3d/` 共 5 文件 |

舞台验证（角色 Luna，`/chat/8`）：
- 烘焙动画按骨骼名直接绑定播放成功，动作句柄实测 `actions: idle/react/dance/talk`
  （前三个 Meshy 烘焙，talk 由 UAL 重定向自动补缺——双层策略按设计生效）；
- 待机重心移动自然，点击触发 Big Wave Hello 挥手后自动回落待机；
- 文字对话正常（首字 4.1s），站立面向镜头、贴地、无穿模；
- 模型质量：贴图清晰、与描述（银白长发/蓝瞳/白裙）高度一致，绑骨蒙皮裙摆无明显破面。

遗留观察项：内置 idle（action_id 0）动作幅度偏活泼，如需"安静站立"可换
id 11/12（style_03 Idle 1/2），改 `assets.py MESHY_BAKED_ACTIONS` 即可。

## 七、三视图链路实测（2026-06-12 晚，角色 Momo `/chat/9`）

任务 `680a57a8f34c`（meshy_text3d + multiview，提示词：粉色双马尾偶像/白粉演出服
短裙/白色长靴），全链一次通过，总耗时 **6 分 26 秒**，约 53 credits：

| 阶段 | 耗时 | 产物 |
| --- | --- | --- |
| 三视图出图（nano-banana-pro，a-pose） | ~70s | 正/侧/背 3 视角，发型服饰跨视角一致 |
| 多视图联合建模（4K 贴图，80k 面） | ~3min | static.glb 21MB |
| 自动绑骨 | ~40s | model.glb 30MB，标准 Mixamo 命名骨架 |
| 官方动画 ×3（idle/83 dance/react） | ~70s | anim_*.glb 各 30MB |
| 落盘 | ~10s | `storage/models3d/avatar3d_680a57a8f34c/`（8 文件含三视图 png） |

结论：
- **形体精度**：双马尾、后腰蝴蝶结、分层裙摆、过膝靴全部还原，背面细节（蝴蝶结）
  与背视图一致——单图链路最弱的背面/侧面问题被三视图直接解决；
- **绑骨精准**：骨架叠加层目检（正/侧/背 + 舞蹈中帧）关节与网格解剖位全对齐；
- **穿模**：idle/react/dance（83）5 帧逐帧目检零可见穿模；
- **体积注意**：4K+80k 面使单动画 GLB 达 30MB（旧 60k/2K 约 9MB），本地/内网无感，
  公网部署可把 `multi_image_to_model` 的 `target_polycount` 降至 40~60k 或关 hd_texture。
