"""本地 Embedding：sentence-transformers（bge 系列，CPU 可跑）。

- 懒加载：首次调用才加载模型，应用启动不被权重下载阻塞
- encode 为 CPU 密集同步操作，统一丢线程池避免阻塞事件循环
- 生产建议 BAAI/bge-m3（1024维）；默认 bge-small-zh-v1.5（512维）便于快速起步
"""
from __future__ import annotations

import asyncio
import logging
import threading

from .base import EmbeddingProvider

logger = logging.getLogger(__name__)


class LocalEmbeddingProvider(EmbeddingProvider):
    kind = "local"

    def __init__(self, model: str, device: str = "cpu"):
        self.model = model
        self._device = device
        self._st_model = None
        self._load_lock = threading.Lock()

    def _ensure_loaded(self):
        if self._st_model is None:
            with self._load_lock:
                if self._st_model is None:
                    from sentence_transformers import SentenceTransformer

                    logger.info("加载本地 embedding 模型 %s (%s)…", self.model, self._device)
                    self._st_model = SentenceTransformer(self.model, device=self._device)
                    logger.info("本地 embedding 模型加载完成，dim=%s",
                                self._st_model.get_sentence_embedding_dimension())

    def _encode(self, texts: list[str]) -> list[list[float]]:
        self._ensure_loaded()
        vecs = self._st_model.encode(
            texts, normalize_embeddings=True, batch_size=32, show_progress_bar=False
        )
        return [v.tolist() for v in vecs]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return await asyncio.to_thread(self._encode, texts)

    async def dim(self) -> int:
        await asyncio.to_thread(self._ensure_loaded)
        return self._st_model.get_sentence_embedding_dimension()
