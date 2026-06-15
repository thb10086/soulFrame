"""Embedding 接口：向量化、相似度演示、提供方查询与热切换。"""
from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v1/embeddings", tags=["embeddings"])


class EmbedIn(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class SimilarityIn(BaseModel):
    query: str
    candidates: list[str] = Field(min_length=1, max_length=32)


class SwitchIn(BaseModel):
    kind: str = Field(pattern="^(local|gateway)$")
    model: str | None = None


@router.post("")
async def embed(req: Request, body: EmbedIn):
    manager = req.app.state.embeddings
    try:
        vecs = await manager.embed(body.texts)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"向量化失败: {e}") from e
    return {
        "provider": manager.active.info(),
        "dim": len(vecs[0]) if vecs else 0,
        "count": len(vecs),
        "embeddings": vecs,
    }


@router.post("/similarity")
async def similarity(req: Request, body: SimilarityIn):
    """语义相似度演示（无需数据库）：query 与每个候选的余弦相似度。"""
    manager = req.app.state.embeddings
    vecs = await manager.embed([body.query] + body.candidates)
    q, cands = vecs[0], vecs[1:]

    def cos(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        return dot / (na * nb) if na and nb else 0.0

    ranked = sorted(
        ({"text": t, "similarity": round(cos(q, v), 4)} for t, v in zip(body.candidates, cands)),
        key=lambda x: -x["similarity"],
    )
    return {"provider": manager.active.info(), "query": body.query, "ranked": ranked}


@router.get("/provider")
async def provider_status(req: Request):
    return await req.app.state.embeddings.status()


@router.put("/provider")
async def switch_provider(req: Request, body: SwitchIn):
    result = await req.app.state.embeddings.switch(body.kind, body.model)
    if not result["switched"]:
        raise HTTPException(409, result["message"])
    return result
