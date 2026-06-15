"""生成式资产服务（路线图 P1/P2 核心）：AI 背景、角色立绘、图生 3D 形象。

产物落到本地 storage/ 目录（/files 静态服务），任务状态既保存在内存
（开发态秒查），也尽力写入 avatar_asset 表（重启可追溯）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from pathlib import Path

import httpx

from ..ai.gateway import AgentLLMClient
from ..ai.mesh3d import Mesh3DError, MeshyProvider, TripoProvider, pick_provider
from ..db.database import Database

logger = logging.getLogger(__name__)

# 立绘出图模板：A-pose 全身、纯色底，方便后续图生 3D
PORTRAIT_TMPL = (
    "full body anime character design, standing A-pose, facing viewer, arms slightly apart, "
    "{desc}, complete body visible from head to feet, clean flat pastel background, "
    "character concept art, high quality, single character"
)
BACKGROUND_TMPL = (
    "{desc}, anime background art, scenery illustration, no people, no characters, "
    "wide shot, high quality, detailed"
)

# 文生 3D 的提示词模板：突出"单个全身人形角色"（绑骨要求人形双足）
TEXT3D_TMPL = (
    "{desc}, full body anime style character, standing, single humanoid character, "
    "clearly defined arms and legs, game-ready character"
)

# ---------------------------------------------------------------------------
# 偶像动作白名单池（审美基线，2026-06-12 批量实烘 20 支 + 量化指标 + 逐支目检策展）
#
# 策展标准（缺一不可）：
# 1. 量化预检过关：大腿摆角 <80° 且髋骨下沉 <25%（anim_squat_check.py，裙装穿模主因）；
# 2. 实机目检过关：动作自然流畅、无机械感、气质符合"偶像"定位（评审页 /dev/anim-review）；
# 3. 风格标签：用于按角色性格差异化分配，同角色稳定、不同角色各不相同。
#
# 全目录 680 动作中 Dancing 33 支实烘 17 支筛出 6 支入池；淘汰原因记录见
# 《Meshy接入与角色创建策略设计》§八（78 Rhythmic 深蹲穿模、69 Crystal Beads 髋沉 31% 等）。
# ---------------------------------------------------------------------------
IDLE_POOL: list[tuple[int, str, tuple[str, ...]]] = [
    # 2026-06-12 Momo 实拍评审：12 (Idle 2) 因伸展幅度太大淘汰
    (243, "Idle 3", ()),                       # 大腿 24°/髋沉 2%，安静站立——默认
    (244, "Idle 4", ("温柔", "治愈", "文艺")),   # 大腿 28°，并腿端正淑女
    (11, "Idle 1", ("元气", "活泼", "可爱")),    # 双臂微张放松，气质活泼
]
REACT_POOL: dict[str, tuple[int, str]] = {
    # 按性格标签选触发反应；default 兜底。
    # 注意：键值按 Momo 实拍效果标定（25 实拍为双手高举欢呼、298 为手抚胸舒气，
    # 与 Meshy 目录名相反），以视觉为准
    "default": (290, "Wave One Hand"),   # 单手高举挥手，最偶像（大腿 12°）
    "元气": (25, "双手欢呼"),             # 双手高举欢呼（大腿 35°）
    "活泼": (25, "双手欢呼"),
    "温柔": (298, "手抚胸舒气"),          # 柔和（大腿 41°）
    "治愈": (298, "手抚胸舒气"),
}
DANCE_POOL: list[tuple[int, str, tuple[str, ...]]] = [
    # (action_id, 名称, 适配性格标签)；分配：标签命中优先 → task_id 稳定哈希轮转。
    # 全池经 2026-06-12 Momo 裙装实拍 3 帧评审 + 大腿角/髋沉量化双重过滤；
    # 淘汰：67 Bubble Dance(背面裙摆翻起) / 69 Crystal Beads(98°) / 65 Bass Beats(髋沉31%)
    (81, "Pod Baby Groove", ("温柔", "治愈")),      # 大腿 48°/髋沉 12%，柔和摇摆，全池最安全
    (75, "Indoor Swing", ("文艺", "冷静", "理性")),  # 大腿 58°，转身舒展优雅
    (77, "Magic Genie", ("腹黑", "傲娇")),          # 大腿 66°，单臂上指造型感强
    (82, "Shake It Off Dance", ("元气", "活泼")),   # 大腿 70°，双臂 V 字活力甩动
    (71, "Denim Pop Dance", ("元气", "酷")),        # 大腿 76°，叉腰 K-pop 律动
    (79, "OMG Groove", ("酷", "帅气")),             # 大腿 76°，单腿点地展臂转身
    (83, "Superlove Pop Dance", ("可爱",)),         # 大腿 84°，偶像手势舞（Momo 实测无可见穿模）
]


def pick_actions(task_id: str, style_tags: list[str] | None = None) -> dict[str, int]:
    """按角色气质从白名单池挑 idle/dance/react —— 每个角色舞蹈各不相同。

    dance/idle：性格标签命中优先；dance 未命中按 task_id 稳定哈希在池内
    轮转（同任务幂等），idle 未命中用最安静一支。react：标签映射，默认单手挥手。
    """
    tags = style_tags or []
    h = int(hashlib.md5(task_id.encode()).hexdigest(), 16)
    dance = next(
        (a for a, _n, ts in DANCE_POOL if any(t in tags for t in ts)),
        DANCE_POOL[h % len(DANCE_POOL)][0],
    )
    idle = next(
        (a for a, _n, ts in IDLE_POOL if any(t in tags for t in ts)),
        IDLE_POOL[0][0],
    )
    react = next(
        (REACT_POOL[t][0] for t in tags if t in REACT_POOL),
        REACT_POOL["default"][0],
    )
    return {"idle": idle, "dance": dance, "react": react}


# 余额低于此值不启动管线（三视图链单角色 ≈53 credits，半途断链浪费更大）
MESHY_MIN_BALANCE = 70


class AssetService:
    def __init__(
        self,
        gateway: AgentLLMClient,
        db: Database,
        storage_dir: str,
        image_models: list[str],
        image_timeout: float,
        meshy_key: str = "",
        meshy_key_backup: str = "",
        tripo_key: str = "",
        proxy: str = "",
        tripo_model_version: str = "v3.0-20250812",
    ):
        self._gw = gateway
        self._db = db
        self._models = image_models
        self._timeout = image_timeout
        self._meshy_key = meshy_key
        self._meshy_key_backup = meshy_key_backup
        self._tripo_key = tripo_key
        self._proxy = proxy
        self._tripo_mv = tripo_model_version
        self.root = Path(storage_dir)
        for sub in ("backgrounds", "portraits", "models3d"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        # 图生 3D 任务表（内存态）：task_id -> 状态机
        self.tasks: dict[str, dict] = {}

    # ---------- 提供方信息 ----------

    def providers(self) -> dict:
        return {
            "image_models": self._models,
            "mesh3d": {
                "meshy": bool(self._meshy_key or self._meshy_key_backup),
                "tripo": bool(self._tripo_key),
                "available": bool(self._meshy_key or self._meshy_key_backup or self._tripo_key),
            },
        }

    # ---------- 图片生成（背景 / 立绘） ----------

    async def gen_image(self, kind: str, prompt: str, character_id: int | None = None) -> dict:
        tmpl = BACKGROUND_TMPL if kind == "background" else PORTRAIT_TMPL
        full_prompt = tmpl.format(desc=prompt.strip())
        img, model = await self._gw.image_generate(
            full_prompt, models=self._models, timeout=self._timeout
        )
        sub = "backgrounds" if kind == "background" else "portraits"
        fname = f"{kind}_{int(time.time())}_{uuid.uuid4().hex[:6]}.png"
        (self.root / sub / fname).write_bytes(img)
        url = f"/files/{sub}/{fname}"
        await self._record(kind, prompt, f"gateway:{model}", "done", {"image": url}, character_id)
        return {"url": url, "model": model, "bytes": len(img)}

    # ---------- AI 生成 3D（策略模式：文生/图生 → 贴图 → 绑骨 → 官方动画） ----------

    async def _pick_meshy_key(self) -> str:
        """主/备 Key 中选余额 ≥ 门槛者；均不足时仍返回余额最高者（由 _check_balance 报错）。"""
        keys = [k for k in (self._meshy_key, self._meshy_key_backup) if k]
        if not keys:
            raise Mesh3DError("Meshy 未配置：请在 .env 填 MESHY_API_KEY")
        best_key, best_bal = keys[0], -1.0
        for key in keys:
            p = MeshyProvider(key, proxy=self._proxy)
            try:
                bal = await p.balance()
            except Exception as e:  # noqa: BLE001
                logger.warning("Meshy 余额查询失败 key=…%s: %s", key[-6:], e)
                bal = -1.0
            finally:
                await p.aclose()
            if bal >= MESHY_MIN_BALANCE:
                return key
            if bal > best_bal:
                best_key, best_bal = key, bal
        return best_key

    async def _make_provider(self, strategy: str):
        """按策略实例化供应商；auto 按 Key 可用性选（Meshy 主链优先）。"""
        if strategy in ("meshy_text3d", "meshy_image3d"):
            return MeshyProvider(await self._pick_meshy_key(), proxy=self._proxy)
        if strategy == "tripo_image3d":
            if not self._tripo_key:
                raise Mesh3DError("Tripo 未配置：请在 .env 填 TRIPO_API_KEY")
            return TripoProvider(self._tripo_key, proxy=self._proxy, model_version=self._tripo_mv)
        p = pick_provider(
            self._meshy_key, self._tripo_key,
            proxy=self._proxy, tripo_model_version=self._tripo_mv,
        )
        if p is None:
            raise Mesh3DError(
                "3D 生成服务未配置：请在 .env 填 MESHY_API_KEY 或 TRIPO_API_KEY "
                "（注册 https://meshy.ai 或 https://tripo3d.ai 获取）"
            )
        return p

    @staticmethod
    def _resolve_strategy(strategy: str, prompt: str | None, image_bytes: bytes | None) -> str:
        """auto 策略归一化：有图走图生，纯文本走文生（Meshy）/立绘+图生（Tripo）。"""
        if strategy and strategy != "auto":
            return strategy
        if image_bytes is not None:
            return "meshy_image3d"
        return "meshy_text3d"

    async def start_avatar3d(
        self,
        prompt: str | None,
        image_bytes: bytes | None,
        character_id: int | None = None,
        strategy: str = "auto",
        multiview: bool = True,
        style_tags: list[str] | None = None,
    ) -> str:
        """启动 AI 生成 3D 管线（策略模式），返回任务 id。

        - meshy_text3d : 一句话 → 官方三视图出图(A-pose) → 多视图建模 → 绑骨 → 官方动画
        - meshy_image3d: 立绘/上传图 → 三视图转身图 → 多视图建模 → 绑骨 → 官方动画
        - tripo_image3d: 立绘/上传图 → 图生3D → mixamo 绑骨（动画由前端 UAL 重定向）
        - auto         : 按输入与 Key 可用性自动选择
        multiview=False 时 Meshy 走单图/直出文生降级链（省 9 credits，形体精度降低）。
        """
        strategy = self._resolve_strategy(strategy, prompt, image_bytes)
        if strategy.startswith("meshy") and not (self._meshy_key or self._meshy_key_backup):
            strategy = "tripo_image3d"  # Meshy 未配时回退 Tripo 老链路
        provider = await self._make_provider(strategy)
        if strategy == "meshy_text3d" and not prompt:
            raise Mesh3DError("文生 3D 需要角色描述")
        task_id = uuid.uuid4().hex[:12]
        actions = pick_actions(task_id, style_tags)
        self.tasks[task_id] = {
            "task_id": task_id,
            "status": "queued",
            "stage": "排队中",
            "strategy": strategy,
            "provider": provider.name,
            "multiview": multiview and strategy.startswith("meshy"),
            "prompt": prompt,
            "character_id": character_id,
            "actions": actions,  # 本角色专属动作分配（白名单池，舞蹈各角色不同）
            "urls": {},
            "error": None,
            "created_at": time.time(),
        }
        asyncio.create_task(
            self._run_avatar3d(
                task_id, strategy, provider, prompt, image_bytes, character_id,
                multiview=multiview, actions=actions,
            )
        )
        return task_id

    async def _run_avatar3d(
        self, task_id: str, strategy: str, provider, prompt: str | None,
        image_bytes: bytes | None, character_id: int | None, multiview: bool = True,
        actions: dict[str, int] | None = None,
    ):
        """生成流水线（五阶段，逐阶段更新 task 状态机）：
        余额检查 → 建模/贴图 → 绑骨 → 官方动画 → 下载落盘。
        每阶段一个职责单一的私有方法，分支逻辑收敛在各方法内部。
        """
        t = self.tasks[task_id]
        try:
            await self._check_balance(provider)
            model_res, view_urls = await self._build_model(
                t, strategy, provider, prompt, image_bytes, character_id, multiview
            )
            rig_res = await self._rig(t, provider, model_res)
            anim_urls = await self._bake_animations(
                t, provider, rig_res, actions or pick_actions(task_id)
            )
            await self._download_artifacts(
                t, task_id, provider, model_res, rig_res, anim_urls, view_urls
            )
            t["rigged"] = bool(rig_res.get("rigged"))
            t.update(status="done", stage="完成", error=None)
            await self._record(
                "model3d", prompt or "", f"{provider.name}:{strategy}", "done",
                t["urls"], character_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("avatar3d 任务失败 %s", task_id)
            t.update(status="failed", stage="失败", error=str(e)[:300])
            await self._record(
                "model3d", prompt or "", f"{provider.name}:{strategy}", "failed",
                t["urls"], character_id, error=str(e)[:300],
            )
        finally:
            await provider.aclose()

    # ---------- 流水线各阶段（单一职责，便于独立演进/测试） ----------

    @staticmethod
    async def _check_balance(provider) -> None:
        """阶段 0：Meshy 余额门槛（三视图链 ≈53 credits，半途断链浪费更大）。"""
        if not isinstance(provider, MeshyProvider):
            return
        try:
            bal = await provider.balance()
        except Exception as e:  # noqa: BLE001
            logger.warning("Meshy 余额查询失败（继续执行）: %s", e)
            return
        if bal < MESHY_MIN_BALANCE:
            raise Mesh3DError(
                f"Meshy 余额不足（{bal:.0f} credits < {MESHY_MIN_BALANCE}）："
                "请充值或在 .env 换 MESHY_API_KEY_BACKUP"
            )

    async def _ensure_portrait(
        self, t: dict, prompt: str | None, character_id: int | None
    ) -> bytes:
        """图生链缺图时按描述先出立绘，返回图片字节并回填预览 URL。"""
        t.update(status="portrait", stage="生成角色立绘…")
        res = await self.gen_image("portrait", prompt or "a cute anime girl", character_id)
        t["urls"]["portrait"] = res["url"]
        return (self.root / res["url"].removeprefix("/files/")).read_bytes()

    async def _build_model(
        self, t: dict, strategy: str, provider, prompt: str | None,
        image_bytes: bytes | None, character_id: int | None, multiview: bool,
    ) -> tuple[dict, list[str]]:
        """阶段 1：建模 + 贴图，返回 (model_res, view_urls)。策略分支集中于此：
        Meshy 三视图链（优先）→ 失败降级 → 文生直出 / 单图图生。
        """
        desc = TEXT3D_TMPL.format(desc=(prompt or "").strip())

        # 1a) Meshy 三视图精准链（同一角色 3 视角 → 多视图联合建模）
        if strategy.startswith("meshy") and multiview:
            try:
                if strategy == "meshy_image3d" and image_bytes is None:
                    image_bytes = await self._ensure_portrait(t, prompt, character_id)
                t.update(status="multiview", stage="三视图出图中（正/侧/背，约 1 分钟）…")
                mv = await provider.gen_multiview_images(
                    desc, image=image_bytes if strategy == "meshy_image3d" else None
                )
                t.update(status="modeling", stage="多视图联合建模中（4K 贴图，约 2~4 分钟）…")
                model_res = await provider.multi_image_to_model(
                    mv["task_id"],
                    on_progress=lambda p: t.update(
                        stage=f"多视图联合建模中（4K 贴图）… {int(p)}%"
                    ),
                )
                return model_res, mv["image_urls"]
            except Mesh3DError as e:
                logger.warning("三视图链失败，降级单图/直出链: %s", e)
                t["multiview"] = False

        # 1b) 文生直出（Meshy text-to-3d）
        if strategy == "meshy_text3d":
            def _tprog(p):
                t["status"] = "modeling" if p < 50 else "texturing"
                t["stage"] = f"文生 3D：{'几何生成' if p < 50 else '贴图绘制'}中… {int(p)}%"

            t.update(status="modeling", stage="文生 3D：几何生成中（约 1~2 分钟）…")
            return await provider.text_to_model(desc, on_progress=_tprog), []

        # 1c) 单图图生（Meshy/Tripo image-to-3d）
        if image_bytes is None:
            image_bytes = await self._ensure_portrait(t, prompt, character_id)
        t.update(status="modeling", stage=f"图生 3D 建模中（{provider.name}，约 1~3 分钟）…")
        model_res = await provider.image_to_model(
            image_bytes,
            on_progress=lambda p: t.update(stage=f"图生 3D 建模中（{provider.name}）… {int(p)}%"),
        )
        return model_res, []

    @staticmethod
    async def _rig(t: dict, provider, model_res: dict) -> dict:
        """阶段 2：自动绑骨（不可绑骨时供应商内部回退静态模型）。"""
        names = {"prerigcheck": "骨骼预检中…", "rigging": "自动绑骨中…"}

        def _stage(name, _p):
            t.update(status="rigging", stage=names.get(name, name))

        return await provider.rig_pipeline(model_res, on_stage=_stage)

    @staticmethod
    async def _bake_animations(
        t: dict, provider, rig_res: dict, actions: dict[str, int]
    ) -> dict[str, str]:
        """阶段 3：Meshy 官方动画烘焙（同骨架带皮 GLB，前端零重定向直接播放）。
        非 Meshy / 未绑骨时返回空，前端走 UAL 重定向兜底。
        """
        if not (isinstance(provider, MeshyProvider) and rig_res.get("rigged") and rig_res.get("task_id")):
            return {}
        anim_urls: dict[str, str] = {}
        for i, (key, action_id) in enumerate(actions.items(), 1):
            t.update(status="animating", stage=f"官方动画生成中（{key}，{i}/{len(actions)}）…")
            try:
                anim_urls[key] = await provider.animate(rig_res["task_id"], action_id)
            except Mesh3DError as e:
                logger.warning("动画 %s 生成失败（跳过，前端重定向兜底）: %s", key, e)
        return anim_urls

    async def _download_artifacts(
        self, t: dict, task_id: str, provider, model_res: dict, rig_res: dict,
        anim_urls: dict[str, str], view_urls: list[str],
    ) -> None:
        """阶段 4：产物落盘。一任务一目录 storage/models3d/avatar3d_{task_id}/，
        含 model.glb（绑骨）/ static.glb / anim_*.glb / view_*.png（三视图参考）。
        生成方 URL 带有效期需当场下载；代理按供应商（Tripo 走代理、Meshy 直连）。
        """
        t.update(status="downloading", stage="下载模型文件…")
        task_dir = self.root / "models3d" / f"avatar3d_{task_id}"
        task_dir.mkdir(parents=True, exist_ok=True)
        dl_proxy = getattr(provider, "download_proxy", self._proxy)
        base = f"/files/models3d/avatar3d_{task_id}"
        async with httpx.AsyncClient(
            timeout=300.0, proxy=dl_proxy or None, follow_redirects=True, trust_env=False
        ) as c:

            async def _dl(url: str, fname: str) -> str:
                resp = await c.get(url)
                resp.raise_for_status()
                (task_dir / fname).write_bytes(resp.content)
                return f"{base}/{fname}"

            t["urls"]["glb_static"] = await _dl(model_res["glb_url"], "static.glb")
            if rig_res.get("rigged") and rig_res["glb_url"] != model_res["glb_url"]:
                t["urls"]["glb"] = await _dl(rig_res["glb_url"], "model.glb")
            else:
                t["urls"]["glb"] = t["urls"]["glb_static"]

            anims: dict[str, str] = {}
            for key, url in anim_urls.items():
                try:
                    anims[key] = await _dl(url, f"anim_{key}.glb")
                except Exception as e:  # noqa: BLE001
                    logger.warning("动画 %s 下载失败（跳过）: %s", key, e)
            if anims:
                t["urls"]["anims"] = anims

            views: list[str] = []
            for i, url in enumerate(view_urls, 1):
                try:
                    views.append(await _dl(url, f"view_{i}.png"))
                except Exception as e:  # noqa: BLE001
                    logger.warning("视图 %d 下载失败（跳过）: %s", i, e)
            if views:
                t["urls"]["views"] = views

    def task_status(self, task_id: str) -> dict | None:
        return self.tasks.get(task_id)

    def active_task_for_character(self, character_id: int) -> dict | None:
        """查某角色"进行中/最近"的生成任务，用于中途退出后续接进度。
        优先返回未结束任务；否则返回最近一次（内存态，后端重启后清空）。
        """
        cand = [t for t in self.tasks.values() if t.get("character_id") == character_id]
        if not cand:
            return None
        cand.sort(key=lambda t: t.get("created_at", 0), reverse=True)
        running = next((t for t in cand if t.get("status") not in ("done", "failed")), None)
        return running or cand[0]

    # ---------- 资产列表 ----------

    def list_files(self, kind: str) -> list[dict]:
        sub = {"background": "backgrounds", "portrait": "portraits", "model3d": "models3d"}.get(kind)
        if not sub:
            return []
        out = []
        # rglob 兼容两代归档：models3d 老平铺文件 + 新一任务一子目录
        for p in sorted((self.root / sub).rglob("*"), key=lambda x: -x.stat().st_mtime):
            if p.is_file():
                rel = p.relative_to(self.root / sub).as_posix()
                out.append({"url": f"/files/{sub}/{rel}", "name": rel, "size": p.stat().st_size})
        return out[:50]

    # ---------- 落库（尽力而为） ----------

    async def _record(
        self, kind: str, prompt: str, provider: str, status: str,
        urls: dict, character_id: int | None, error: str | None = None,
    ):
        if not self._db.available:
            return
        try:
            async with self._db.pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO avatar_asset (character_id, kind, prompt, provider, status, urls, error)
                       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)""",
                    character_id, kind, prompt, provider, status, json.dumps(urls), error,
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("avatar_asset 落库失败（忽略）: %s", e)
