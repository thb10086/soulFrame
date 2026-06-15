"""线上 Embedding：AgentLLM Gateway /v1/embeddings（OpenAI 兼容）。

默认模型 text-embedding-3-large（3072 维）；可通过 .env 的 GATEWAY_EMBEDDING_MODEL
或 PUT /api/v1/embeddings/provider 热切换（切换前自动探活，维度变化需 reindex）。
"""
from __future__ import annotations

from ..gateway import AgentLLMClient
from .base import EmbeddingProvider


class GatewayEmbeddingProvider(EmbeddingProvider):
    kind = "gateway"

    def __init__(self, client: AgentLLMClient, model: str):
        self.model = model
        self._client = client
        self._dim: int | None = None

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vecs = await self._client.embeddings(texts, model=self.model)
        if vecs and self._dim is None:
            self._dim = len(vecs[0])
        return vecs

    async def dim(self) -> int:
        if self._dim is None:
            await self.embed(["dim probe"])
        return self._dim or 0
