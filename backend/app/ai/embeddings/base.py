"""Embedding 抽象层：本地与网关实现同一接口，支持运行时热切换。"""
from __future__ import annotations

from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    """所有向量化实现的统一接口。"""

    #: 提供方标识：local | gateway
    kind: str
    #: 具体模型名
    model: str

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """批量向量化。返回与输入等长的向量列表。"""

    @abstractmethod
    async def dim(self) -> int:
        """向量维度（首次调用可能触发模型加载/远程探测）。"""

    async def ready(self) -> bool:
        """探活：能成功向量化一条文本即视为就绪。"""
        try:
            vecs = await self.embed(["ping"])
            return bool(vecs and vecs[0])
        except Exception:  # noqa: BLE001
            return False

    def info(self) -> dict:
        return {"kind": self.kind, "model": self.model}
