"""数据库连接与 schema 引导。

设计：数据库不可用时应用仍可启动（降级模式），embedding/对话等
无状态能力照常工作；依赖 DB 的接口返回 503。
"""
from __future__ import annotations

import logging
from pathlib import Path

import asyncpg

logger = logging.getLogger(__name__)
SCHEMA_PATH = Path(__file__).parent / "schema.sql"


class Database:
    def __init__(self, dsn: str):
        self._dsn = dsn
        self.pool: asyncpg.Pool | None = None

    @property
    def available(self) -> bool:
        return self.pool is not None

    async def connect(self, embedding_dim: int) -> bool:
        try:
            self.pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=8, timeout=5)
            await self._bootstrap(embedding_dim)
            logger.info("数据库已连接，schema 就绪（embedding dim=%s）", embedding_dim)
            return True
        except Exception as e:  # noqa: BLE001
            self.pool = None
            logger.warning("数据库不可用，进入降级模式：%s", e)
            return False

    async def _bootstrap(self, embedding_dim: int):
        sql = SCHEMA_PATH.read_text(encoding="utf-8").replace(
            "{EMBEDDING_DIM}", str(embedding_dim)
        )
        async with self.pool.acquire() as conn:
            await conn.execute(sql)

    async def close(self):
        if self.pool:
            await self.pool.close()
            self.pool = None
