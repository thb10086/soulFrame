"""Embedding 管理器：持有当前激活的提供方，支持运行时热切换。

切换流程（PUT /api/v1/embeddings/provider）：
  1. 构造目标提供方 → 2. 探活（真实向量化一条文本）→ 3. 比对维度
  → 4. 维度一致直接切换；不一致则提示需要重建向量索引（reindex）
"""
from __future__ import annotations

import asyncio
import logging

from ..gateway import AgentLLMClient
from .base import EmbeddingProvider
from .gateway_provider import GatewayEmbeddingProvider
from .local import LocalEmbeddingProvider

logger = logging.getLogger(__name__)


class EmbeddingManager:
    def __init__(
        self,
        gateway_client: AgentLLMClient,
        local_model: str,
        local_device: str,
        gateway_model: str,
        default_kind: str = "local",
    ):
        self._gateway_client = gateway_client
        self._local_model = local_model
        self._local_device = local_device
        self._gateway_model = gateway_model
        self._lock = asyncio.Lock()
        self._active: EmbeddingProvider = self._build(default_kind)

    def _build(self, kind: str, model: str | None = None) -> EmbeddingProvider:
        if kind == "local":
            return LocalEmbeddingProvider(model or self._local_model, self._local_device)
        if kind == "gateway":
            return GatewayEmbeddingProvider(self._gateway_client, model or self._gateway_model)
        raise ValueError(f"未知 embedding 提供方: {kind}（可选 local / gateway）")

    @property
    def active(self) -> EmbeddingProvider:
        return self._active

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return await self._active.embed(texts)

    async def status(self) -> dict:
        info = self._active.info()
        try:
            info["dim"] = await self._active.dim()
            info["ready"] = True
        except Exception as e:  # noqa: BLE001
            info["dim"] = None
            info["ready"] = False
            info["error"] = str(e)[:200]
        return info

    async def switch(self, kind: str, model: str | None = None) -> dict:
        """热切换提供方。返回 {switched, dim_changed, old, new, message}。"""
        async with self._lock:
            old = self._active
            target = self._build(kind, model)
            if not await target.ready():
                hint = (
                    "网关 embedding 探活失败（当前网关未开通 /v1/embeddings 路由，"
                    "请联系管理员开通并确认模型名）" if kind == "gateway"
                    else "本地模型加载失败（检查模型名 / 磁盘 / 网络下载）"
                )
                return {"switched": False, "message": hint, "old": old.info(), "new": target.info()}
            new_dim = await target.dim()
            old_dim: int | None
            try:
                old_dim = await old.dim()
            except Exception:  # noqa: BLE001
                old_dim = None
            self._active = target
            dim_changed = old_dim is not None and old_dim != new_dim
            msg = "切换成功"
            if dim_changed:
                msg += (
                    f"；注意维度变化 {old_dim}→{new_dim}，"
                    "已入库向量需重建（POST /api/v1/memories/reindex）"
                )
            logger.info("embedding 切换: %s → %s (dim=%s)", old.info(), target.info(), new_dim)
            return {
                "switched": True,
                "dim_changed": dim_changed,
                "old": {**old.info(), "dim": old_dim},
                "new": {**target.info(), "dim": new_dim},
                "message": msg,
            }
