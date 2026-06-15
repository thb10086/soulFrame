"""文生/图生 3D + 自动绑骨 + 官方动画适配器（AI 形象工厂主链路）。

双供应商（设计详见《Meshy接入与角色创建策略设计》）：
- Meshy : 三视图主链——text-to-image / image-to-image（generate_multi_view 同一角色 3 视角）
          → multi-image-to-3d（input_task_id 串链，4K 贴图）→ rigging → animations（官方动作库）
          直出 text-to-3d(preview→refine) / image-to-3d 作为多视图失败时的降级链
          https://docs.meshy.ai/en/api （2026-06-12 双 Key 实测接入）
- Tripo : upload → image_to_model → animate_prerigcheck → animate_rig(spec=mixamo)
          https://docs.tripo3d.ai （2026-06-12 实测全链路可用）

动画双层策略：
1. Meshy 官方动画优先——动画 GLB 与绑骨模型同骨架，前端抽 clip 直接播放（零重定向误差）；
2. UAL 重定向兜底——无烘焙动画（Tripo/旧资产）时前端动作库世界空间重定向驱动。

网络：本机直连 api.tripo3d.ai 超时需走 OUTBOUND_PROXY；api.meshy.ai 实测直连可用（不走代理）。
"""
from __future__ import annotations

import asyncio
import base64
import logging

import httpx

logger = logging.getLogger(__name__)

MESHY_BASE = "https://api.meshy.ai"
TRIPO_BASE = "https://api.tripo3d.ai"


class Mesh3DError(RuntimeError):
    pass


def _data_uri(image: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(image).decode()}"


class MeshyProvider:
    """Meshy：text/image → 3D（含贴图）→ rigging → 官方动画。

    任务串链全部走 input_task_id/rig_task_id（免传文件、避开 +Z 朝向限制）；
    产物 URL 带有效期，调用方须当场下载落盘。
    """

    name = "meshy"
    download_proxy = ""  # assets.meshy.ai 实测直连可用

    def __init__(self, api_key: str, proxy: str = ""):
        # 实测 api.meshy.ai 直连可用，不走 OUTBOUND_PROXY（代理挂掉不应影响 Meshy）
        self._c = httpx.AsyncClient(
            base_url=MESHY_BASE,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60.0,
            trust_env=False,
        )

    async def aclose(self):
        await self._c.aclose()

    async def balance(self) -> float:
        r = await self._c.get("/openapi/v1/balance")
        r.raise_for_status()
        return r.json().get("balance") or 0

    async def _create(self, path: str, body: dict) -> str:
        r = await self._c.post(path, json=body)
        if r.status_code >= 400:
            raise Mesh3DError(f"Meshy {path} HTTP {r.status_code}: {r.text[:300]}")
        task_id = r.json().get("result")
        if not task_id:
            raise Mesh3DError(f"Meshy {path} 未返回任务 id: {r.text[:200]}")
        return task_id

    async def _poll(self, path: str, task_id: str, timeout_s: float = 900.0, on_progress=None) -> dict:
        deadline = asyncio.get_event_loop().time() + timeout_s
        while True:
            r = await self._c.get(f"{path}/{task_id}")
            r.raise_for_status()
            data = r.json()
            status = data.get("status")
            if on_progress:
                on_progress(data.get("progress") or 0)
            if status == "SUCCEEDED":
                return data
            if status in ("FAILED", "CANCELED"):
                err = (data.get("task_error") or {}).get("message") or status
                raise Mesh3DError(f"Meshy 任务失败: {err}")
            if asyncio.get_event_loop().time() > deadline:
                raise Mesh3DError("Meshy 任务超时")
            await asyncio.sleep(4)

    async def text_to_model(self, prompt: str, on_progress=None) -> dict:
        """文生 3D 两段式：preview 出几何（A-pose 利于绑骨）→ refine 上贴图。"""
        prev_id = await self._create(
            "/openapi/v2/text-to-3d",
            {
                "mode": "preview",
                "prompt": prompt[:600],
                "ai_model": "latest",
                "pose_mode": "a-pose",
                "topology": "triangle",
                "should_remesh": True,
                "target_polycount": 60000,
            },
        )
        await self._poll(
            "/openapi/v2/text-to-3d", prev_id,
            on_progress=(lambda p: on_progress(p * 0.5)) if on_progress else None,
        )
        refine_id = await self._create(
            "/openapi/v2/text-to-3d", {"mode": "refine", "preview_task_id": prev_id}
        )
        data = await self._poll(
            "/openapi/v2/text-to-3d", refine_id,
            on_progress=(lambda p: on_progress(50 + p * 0.5)) if on_progress else None,
        )
        glb = (data.get("model_urls") or {}).get("glb")
        if not glb:
            raise Mesh3DError("Meshy 文生 3D 未返回 GLB 地址")
        return {"task_id": refine_id, "glb_url": glb}

    async def image_to_model(self, image: bytes, on_progress=None) -> dict:
        task_id = await self._create(
            "/openapi/v1/image-to-3d",
            {
                "image_url": _data_uri(image),
                "ai_model": "latest",
                "should_texture": True,
                "should_remesh": True,
                "enable_pbr": False,
                "pose_mode": "a-pose",  # 立姿摊手，绑骨成功率与蒙皮质量关键
                "target_polycount": 60000,
            },
        )
        data = await self._poll("/openapi/v1/image-to-3d", task_id, on_progress=on_progress)
        glb = (data.get("model_urls") or {}).get("glb")
        if not glb:
            raise Mesh3DError("Meshy 未返回 GLB 地址")
        return {"task_id": task_id, "glb_url": glb}

    async def gen_multiview_images(
        self, prompt: str, image: bytes | None = None, on_progress=None
    ) -> dict:
        """官方多视图参考图（三视图精准建模的第一步）。

        - 纯文本：text-to-image + generate_multi_view + a-pose → 同一角色 3 视角图
        - 给参考图：image-to-image + generate_multi_view → 忠于原图的 3 视角转身图
        返回 {task_id, image_urls}，task_id 可直接 input_task_id 串进 multi-image-to-3d。
        """
        if image is None:
            path = "/openapi/v1/text-to-image"
            body = {
                "ai_model": "nano-banana-pro",  # 9cr，质量优先
                "prompt": prompt[:580],
                "generate_multi_view": True,
                "pose_mode": "a-pose",
            }
        else:
            path = "/openapi/v1/image-to-image"
            body = {
                "ai_model": "nano-banana-pro",
                "prompt": (
                    "multi-view turnaround of this exact character, identical outfit, "
                    "colors and hairstyle, full body head to toe, A-pose, "
                    "clean flat background"
                ),
                "reference_image_urls": [_data_uri(image)],
                "generate_multi_view": True,
            }
        task_id = await self._create(path, body)
        data = await self._poll(path, task_id, timeout_s=300, on_progress=on_progress)
        urls = data.get("image_urls") or []
        if not urls:
            raise Mesh3DError("Meshy 多视图出图未返回图片")
        return {"task_id": task_id, "image_urls": urls}

    async def multi_image_to_model(self, input_task_id: str, on_progress=None) -> dict:
        """多视图 → 3D（30cr）：几何由 3 视角联合约束，形体/背面精度高于单图。

        4K 贴图 + 80k 面（绑骨上限 30 万面内），只产 GLB 省时。
        """
        task_id = await self._create(
            "/openapi/v1/multi-image-to-3d",
            {
                "input_task_id": input_task_id,
                "ai_model": "latest",
                "should_texture": True,
                "hd_texture": True,  # 4K base color：通话全屏近景不糊
                "enable_pbr": False,
                "should_remesh": True,
                "topology": "triangle",
                "target_polycount": 80000,
                "pose_mode": "a-pose",
                "target_formats": ["glb"],
            },
        )
        data = await self._poll(
            "/openapi/v1/multi-image-to-3d", task_id, on_progress=on_progress
        )
        glb = (data.get("model_urls") or {}).get("glb")
        if not glb:
            raise Mesh3DError("Meshy 多视图建模未返回 GLB 地址")
        return {"task_id": task_id, "glb_url": glb}

    async def rig_pipeline(self, model: dict, on_stage=None) -> dict:
        """贴图模型 → 绑骨 GLB。input_task_id 串链（免下载上传、免 +Z 朝向要求）。

        绑骨失败（非人形/姿态识别失败）回退静态模型，沿用 Tripo 语义。
        """
        if on_stage:
            on_stage("rigging", 0)
        body: dict = {"height_meters": 1.6}
        if model.get("task_id"):
            body["input_task_id"] = model["task_id"]
        else:
            body["model_url"] = model["glb_url"]
        try:
            task_id = await self._create("/openapi/v1/rigging", body)
            data = await self._poll("/openapi/v1/rigging", task_id, timeout_s=600)
        except Mesh3DError as e:
            logger.warning("Meshy 绑骨失败，回退静态模型: %s", e)
            return {**model, "rigged": False}
        result = data.get("result") or {}
        glb = result.get("rigged_character_glb_url")
        if not glb:
            logger.warning("Meshy 绑骨未返回 GLB，回退静态模型")
            return {**model, "rigged": False}
        return {"task_id": task_id, "glb_url": glb, "rigged": True}

    async def animate(self, rig_task_id: str, action_id: int) -> str:
        """对绑骨角色应用官方动作库动画（3 credits/个），返回带皮动画 GLB 地址。

        动作目录公开接口 GET /web/public/animations/resources（680 个动作）。
        """
        task_id = await self._create(
            "/openapi/v1/animations", {"rig_task_id": rig_task_id, "action_id": action_id}
        )
        data = await self._poll("/openapi/v1/animations", task_id, timeout_s=600)
        url = (data.get("result") or {}).get("animation_glb_url")
        if not url:
            raise Mesh3DError(f"Meshy 动画任务未返回 GLB（action_id={action_id}）")
        return url


class TripoProvider:
    """Tripo v2 OpenAPI（已实测）：

    upload(multipart) → {image_token}
    POST /v2/openapi/task {type:image_to_model, file:{type,file_token}, model_version}
    GET  /v2/openapi/task/{id} → data.status: queued|running|success|failed
    然后 animate_prerigcheck → animate_rig(spec=tripo) → animate_retarget(preset:idle)
    """

    name = "tripo"

    def __init__(self, api_key: str, proxy: str = "", model_version: str = "v3.0-20250812"):
        self._mv = model_version
        self.download_proxy = proxy  # Tripo CDN 同样需要代理
        self._c = httpx.AsyncClient(
            base_url=TRIPO_BASE,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60.0,
            proxy=proxy or None,
            trust_env=False,
        )

    async def aclose(self):
        await self._c.aclose()

    async def balance(self) -> float:
        r = await self._c.get("/v2/openapi/user/balance")
        r.raise_for_status()
        return ((r.json().get("data") or {}).get("balance")) or 0

    async def _poll(self, task_id: str, timeout_s: float = 900.0, on_progress=None) -> dict:
        deadline = asyncio.get_event_loop().time() + timeout_s
        while True:
            r = await self._c.get(f"/v2/openapi/task/{task_id}")
            r.raise_for_status()
            data = r.json().get("data") or {}
            status = data.get("status")
            if on_progress:
                on_progress(data.get("progress") or 0)
            if status == "success":
                return data
            if status in ("failed", "cancelled", "banned", "expired", "unknown"):
                raise Mesh3DError(f"Tripo 任务失败: {status}")
            if asyncio.get_event_loop().time() > deadline:
                raise Mesh3DError("Tripo 任务超时")
            await asyncio.sleep(4)

    async def _create_task(self, body: dict) -> str:
        r = await self._c.post("/v2/openapi/task", json=body)
        if r.status_code >= 400:
            raise Mesh3DError(f"Tripo task HTTP {r.status_code}: {r.text[:300]}")
        payload = r.json()
        if payload.get("code") not in (0, None):
            raise Mesh3DError(f"Tripo task 拒绝: {payload}")
        task_id = (payload.get("data") or {}).get("task_id")
        if not task_id:
            raise Mesh3DError(f"Tripo 未返回 task_id: {payload}")
        return task_id

    @staticmethod
    def _model_url(data: dict) -> str | None:
        """兼容 output.{pbr_model|model|base_model}（字符串）与 result.*.url（对象）两种返回。"""
        out = data.get("output") or {}
        for key in ("pbr_model", "model", "base_model"):
            v = out.get(key)
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict) and v.get("url"):
                return v["url"]
        result = data.get("result") or {}
        for key in ("pbr_model", "model", "base_model"):
            v = result.get(key)
            if isinstance(v, dict) and v.get("url"):
                return v["url"]
        return None

    async def image_to_model(self, image: bytes, on_progress=None) -> dict:
        up = await self._c.post(
            "/v2/openapi/upload",
            files={"file": ("input.png", image, "image/png")},
        )
        if up.status_code >= 400:
            raise Mesh3DError(f"Tripo upload HTTP {up.status_code}: {up.text[:200]}")
        token = (up.json().get("data") or {}).get("image_token")
        if not token:
            raise Mesh3DError(f"Tripo upload 未返回 image_token: {up.text[:200]}")
        task_id = await self._create_task(
            {
                "type": "image_to_model",
                "file": {"type": "png", "file_token": token},
                "model_version": self._mv,
                "texture": True,
                "pbr": True,
                # 自动旋转模型对齐原图朝向，正面立绘 → 正面模型
                "orientation": "align_image",
            }
        )
        data = await self._poll(task_id, on_progress=on_progress)
        glb = self._model_url(data)
        if not glb:
            raise Mesh3DError(f"Tripo 未返回模型地址: keys={list((data.get('output') or {}).keys())}")
        return {"task_id": task_id, "glb_url": glb}

    async def rig_pipeline(self, model: dict, on_stage=None) -> dict:
        """预检 → mixamo 标准骨架绑骨（T-pose，动画由前端动作库实时重定向）。

        返回 {task_id, glb_url, rigged}；不可绑骨时回退静态模型。
        """
        src_id = model["task_id"]
        # 1) 预检（免费）：人形才可绑骨
        if on_stage:
            on_stage("prerigcheck", 0)
        try:
            chk_id = await self._create_task(
                {"type": "animate_prerigcheck", "original_model_task_id": src_id}
            )
            chk = await self._poll(chk_id, timeout_s=300)
            riggable = bool((chk.get("output") or {}).get("riggable"))
        except Mesh3DError as e:
            logger.warning("Tripo 预检失败，按不可绑骨处理: %s", e)
            riggable = False
        if not riggable:
            return {**model, "rigged": False}

        # 2) 绑骨：mixamo 标准骨架命名，前端 UAL 动作库按骨骼名重定向驱动。
        #    实测（2026-06-12）：v2.5 的 GLB 输出忽略 spec 恒为 tripo:: 私有命名，
        #    只有 v1.0-20240301 + spec=mixamo 的 GLB 才带 mixamorig:* 标准骨骼。
        if on_stage:
            on_stage("rigging", 0)
        rig_id = await self._create_task(
            {
                "type": "animate_rig",
                "original_model_task_id": src_id,
                "out_format": "glb",
                "model_version": "v1.0-20240301",
                "spec": "mixamo",
            }
        )
        rig = await self._poll(rig_id)
        rig_url = self._model_url(rig)
        if not rig_url:
            raise Mesh3DError("Tripo 未返回绑骨模型地址")
        return {"task_id": rig_id, "glb_url": rig_url, "rigged": True}


def pick_provider(meshy_key: str, tripo_key: str, proxy: str = "", tripo_model_version: str = "v3.0-20250812"):
    """Meshy 主链优先（2026-06-12 双 Key 已充值实测：文生/图生+绑骨+官方动画全链路）；
    Tripo 备用；都没配返回 None（接口层给可操作报错）。"""
    if meshy_key:
        return MeshyProvider(meshy_key, proxy=proxy)
    if tripo_key:
        return TripoProvider(tripo_key, proxy=proxy, model_version=tripo_model_version)
    return None
