"""记忆服务：写入（向量化入库）、语义检索（pgvector 余弦）、重建索引。

切换 embedding 提供方后若维度变化，调用 reindex() 用当前提供方
重算全部记忆向量并重建列（这是「随时切换」的配套保障）。
"""
from __future__ import annotations

import json
import logging

from ..ai.embeddings import EmbeddingManager
from ..db.database import Database

logger = logging.getLogger(__name__)


def _vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


class MemoryService:
    def __init__(self, db: Database, embeddings: EmbeddingManager):
        self._db = db
        self._emb = embeddings

    async def _record_meta(self, conn):
        info = self._emb.active.info()
        dim = await self._emb.active.dim()
        await conn.execute(
            """INSERT INTO embedding_meta(id, kind, model, dim, updated_at)
               VALUES (1, $1, $2, $3, now())
               ON CONFLICT (id) DO UPDATE
               SET kind = $1, model = $2, dim = $3, updated_at = now()""",
            info["kind"], info["model"], dim,
        )

    async def stored_dim(self) -> int | None:
        async with self._db.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT dim FROM embedding_meta WHERE id = 1")
            return row["dim"] if row else None

    async def add(
        self,
        user_id: int,
        character_id: int,
        content: str,
        memory_type: str = "fact",
        tags: list[str] | None = None,
        importance: float = 0.5,
    ) -> dict:
        stored = await self.stored_dim()
        current = await self._emb.active.dim()
        if stored is not None and stored != current:
            raise DimMismatch(stored, current)
        vec = (await self._emb.embed([content]))[0]
        async with self._db.pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO memory(user_id, character_id, memory_type, content,
                                      tags, importance_score, embedding)
                   VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                   RETURNING id, created_at""",
                user_id, character_id, memory_type, content,
                tags or [], importance, _vec_literal(vec),
            )
            await self._record_meta(conn)
        return {"id": row["id"], "created_at": row["created_at"].isoformat()}

    async def search(
        self, user_id: int, character_id: int, query: str, top_k: int = 5
    ) -> list[dict]:
        stored = await self.stored_dim()
        current = await self._emb.active.dim()
        if stored is not None and stored != current:
            raise DimMismatch(stored, current)
        qvec = (await self._emb.embed([query]))[0]
        async with self._db.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT id, memory_type, content, tags, importance_score,
                          1 - (embedding <=> $4::vector) AS similarity
                   FROM memory
                   WHERE user_id = $1 AND character_id = $2 AND embedding IS NOT NULL
                   ORDER BY embedding <=> $4::vector
                   LIMIT $3""",
                user_id, character_id, top_k, _vec_literal(qvec),
            )
        return [
            {
                "id": r["id"],
                "type": r["memory_type"],
                "content": r["content"],
                "tags": list(r["tags"] or []),
                "importance": r["importance_score"],
                "similarity": round(r["similarity"], 4),
            }
            for r in rows
        ]

    async def list_all(self, user_id: int, character_id: int) -> list[dict]:
        async with self._db.pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT id, memory_type, content, tags, importance_score, created_at
                   FROM memory WHERE user_id = $1 AND character_id = $2
                   ORDER BY created_at DESC""",
                user_id, character_id,
            )
        return [
            {
                "id": r["id"], "type": r["memory_type"], "content": r["content"],
                "tags": list(r["tags"] or []), "importance": r["importance_score"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]

    async def delete(self, memory_id: int) -> bool:
        async with self._db.pool.acquire() as conn:
            result = await conn.execute("DELETE FROM memory WHERE id = $1", memory_id)
        return result.endswith("1")

    async def reindex(self, batch: int = 64) -> dict:
        """用当前 embedding 提供方重算全部记忆向量（维度变化后必跑）。"""
        new_dim = await self._emb.active.dim()
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("ALTER TABLE memory DROP COLUMN IF EXISTS embedding")
                await conn.execute(f"ALTER TABLE memory ADD COLUMN embedding vector({new_dim})")
            rows = await conn.fetch("SELECT id, content FROM memory ORDER BY id")
            total = len(rows)
            for i in range(0, total, batch):
                chunk = rows[i : i + batch]
                vecs = await self._emb.embed([r["content"] for r in chunk])
                await conn.executemany(
                    "UPDATE memory SET embedding = $2::vector WHERE id = $1",
                    [(r["id"], _vec_literal(v)) for r, v in zip(chunk, vecs)],
                )
            await self._record_meta(conn)
        info = self._emb.active.info()
        logger.info("reindex 完成：%s 条记忆 → %s (dim=%s)", total, info, new_dim)
        return {"reindexed": total, "provider": info, "dim": new_dim}


class DimMismatch(RuntimeError):
    def __init__(self, stored: int, current: int):
        self.stored, self.current = stored, current
        super().__init__(
            f"向量维度不一致：库内 {stored} 维，当前提供方 {current} 维。"
            f"请先 POST /api/v1/memories/reindex 重建索引。"
        )
