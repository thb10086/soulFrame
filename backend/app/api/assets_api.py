"""生成式资产接口：AI 背景 / 角色立绘 / 图生 3D 形象（路线图 P1/P2）。"""
from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..ai.mesh3d import Mesh3DError

router = APIRouter(prefix="/api/v1/assets", tags=["assets"])


def _svc(req: Request):
    return req.app.state.assets


class ImageGenIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=600)
    character_id: int | None = None


class Avatar3DIn(BaseModel):
    """二选一：描述（文生 3D / 自动先出立绘）或直接给图（base64，去掉 data: 前缀也可）。

    strategy 创建策略（设计见《Meshy接入与角色创建策略设计》§2.1）：
    auto | meshy_text3d | meshy_image3d | tripo_image3d
    """

    prompt: str | None = Field(default=None, max_length=600)
    image_b64: str | None = None
    character_id: int | None = None
    strategy: str = Field(default="auto", pattern="^(auto|meshy_text3d|meshy_image3d|tripo_image3d)$")
    # 三视图精准建模（仅 Meshy）：官方多视图出图 → 多视图联合建模，形体/背面更准
    multiview: bool = True
    # 角色性格标签（如 元气/温柔/傲娇）：从白名单动作池差异化分配舞蹈/反应动作
    style_tags: list[str] = Field(default_factory=list, max_length=8)


@router.get("/providers")
async def providers(req: Request):
    return _svc(req).providers()


@router.post("/background")
async def gen_background(req: Request, body: ImageGenIn):
    try:
        return await _svc(req).gen_image("background", body.prompt, body.character_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"背景生成失败：{e}") from e


@router.post("/portrait")
async def gen_portrait(req: Request, body: ImageGenIn):
    try:
        return await _svc(req).gen_image("portrait", body.prompt, body.character_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"立绘生成失败：{e}") from e


@router.post("/avatar3d")
async def start_avatar3d(req: Request, body: Avatar3DIn):
    if not body.prompt and not body.image_b64:
        raise HTTPException(422, "prompt 与 image_b64 至少传一个")
    image = None
    if body.image_b64:
        raw = body.image_b64.split(",", 1)[-1]  # 兼容 dataURI
        try:
            image = base64.b64decode(raw)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, "image_b64 不是合法的 base64") from e
    try:
        task_id = await _svc(req).start_avatar3d(
            body.prompt, image, body.character_id,
            strategy=body.strategy, multiview=body.multiview,
            style_tags=body.style_tags,
        )
    except Mesh3DError as e:
        raise HTTPException(409, str(e)) from e
    return {"task_id": task_id}


@router.get("/avatar3d/active")
async def avatar3d_active(req: Request, character_id: int):
    """某角色进行中/最近的生成任务（中途退出后前端据此续接进度）。无则返回 {}。"""
    return _svc(req).active_task_for_character(character_id) or {}


@router.get("/avatar3d/{task_id}")
async def avatar3d_status(req: Request, task_id: str):
    t = _svc(req).task_status(task_id)
    if not t:
        raise HTTPException(404, "任务不存在（服务重启后内存任务会丢失）")
    return t


@router.get("/list/{kind}")
async def list_assets(req: Request, kind: str):
    return {"items": _svc(req).list_files(kind)}
