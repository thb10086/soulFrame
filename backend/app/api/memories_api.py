"""记忆接口：写入 / 语义检索 / 列表 / 删除 / 重建向量索引。依赖 PostgreSQL。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..services.memory import DimMismatch

router = APIRouter(prefix="/api/v1/memories", tags=["memories"])


class MemoryIn(BaseModel):
    user_id: int = 1
    character_id: int = 1
    content: str = Field(min_length=1, max_length=2000)
    memory_type: str = "fact"
    tags: list[str] = []
    importance: float = Field(default=0.5, ge=0, le=1)


def _svc(req: Request):
    if not req.app.state.db.available:
        raise HTTPException(503, "数据库未连接（docker compose up -d 后重启服务）")
    return req.app.state.memory_service


@router.post("")
async def add_memory(req: Request, body: MemoryIn):
    try:
        return await _svc(req).add(
            body.user_id, body.character_id, body.content,
            body.memory_type, body.tags, body.importance,
        )
    except DimMismatch as e:
        raise HTTPException(409, str(e)) from e


@router.get("/search")
async def search_memories(
    req: Request,
    q: str,
    user_id: int = 1,
    character_id: int = 1,
    top_k: int = Query(default=5, ge=1, le=20),
):
    try:
        return {"query": q, "results": await _svc(req).search(user_id, character_id, q, top_k)}
    except DimMismatch as e:
        raise HTTPException(409, str(e)) from e


@router.get("")
async def list_memories(req: Request, user_id: int = 1, character_id: int = 1):
    return {"memories": await _svc(req).list_all(user_id, character_id)}


@router.delete("/{memory_id}")
async def delete_memory(req: Request, memory_id: int):
    if not await _svc(req).delete(memory_id):
        raise HTTPException(404, "记忆不存在")
    return {"deleted": memory_id}


@router.post("/reindex")
async def reindex(req: Request):
    """切换 embedding 提供方且维度变化后，重建全部记忆向量。"""
    return await _svc(req).reindex()
