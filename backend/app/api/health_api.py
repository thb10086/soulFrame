"""健康检查：暴露各依赖（DB / embedding / 网关）状态。"""
from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz(req: Request):
    state = req.app.state
    emb = await state.embeddings.status()
    return {
        "service": "soulframe-backend",
        "db": "up" if state.db.available else "degraded(no-db)",
        "embedding": emb,
        "chat_model": state.settings.chat_model,
        "gateway": state.settings.agentllm_base_url,
    }
