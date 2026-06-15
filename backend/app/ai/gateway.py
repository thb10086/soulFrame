"""AgentLLM Gateway 客户端（AI Adapter 模块）。

职责：流式 LLM、Embedding、（后续）TTS/ASR/Realtime 的统一出口，
内置超时与模型降级链。密钥只在这里使用。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator

import httpx

logger = logging.getLogger(__name__)

#: 单模型报错后的冷却期：期间该模型被降到候选链末尾，避免每回合都白等它的 502
MODEL_COOLDOWN_S = 45.0


class GatewayError(RuntimeError):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"Gateway HTTP {status}: {message}")


class AgentLLMClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0):
        # trust_env=False：网关直连，绝不走系统代理（用户开启 Clash 时 CONNECT 会被 403）
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            trust_env=False,
        )
        # 熔断表：model -> 冷却截止时刻（monotonic 秒）
        self._cooldown_until: dict[str, float] = {}

    async def aclose(self):
        await self._client.aclose()

    def _trip(self, model: str):
        """模型报错 → 进入冷却，后续回合优先跳过它。"""
        self._cooldown_until[model] = time.monotonic() + MODEL_COOLDOWN_S
        logger.warning("model %s 进入熔断冷却 %.0fs", model, MODEL_COOLDOWN_S)

    def _prioritize(self, models: list[str]) -> list[str]:
        """去重并按健康度排序：冷却中的模型沉到末尾（仍保底可用），其余保持原序。"""
        seen: set[str] = set()
        uniq = [m for m in models if m and not (m in seen or seen.add(m))]
        now = time.monotonic()
        healthy = [m for m in uniq if self._cooldown_until.get(m, 0) <= now]
        cooled = [m for m in uniq if self._cooldown_until.get(m, 0) > now]
        if cooled:
            logger.info("跳过冷却中的模型 %s，优先 %s", cooled, healthy or "(无)")
        return healthy + cooled

    async def chat_stream(
        self,
        messages: list[dict],
        model: str,
        max_tokens: int = 512,
        temperature: float = 0.8,
    ) -> AsyncIterator[str]:
        """流式聊天，逐段产出 content 增量。x-cache 关闭保证实时性。"""
        body = {
            "model": model,
            "messages": messages,
            "stream": True,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        async with self._client.stream(
            "POST", "/v1/chat/completions", json=body, headers={"x-cache": "off"}
        ) as resp:
            if resp.status_code != 200:
                text = (await resp.aread()).decode("utf-8", "ignore")
                raise GatewayError(resp.status_code, text[:300])
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                piece = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
                if piece:
                    yield piece

    async def chat_stream_with_fallback(
        self, messages: list[dict], models: list[str], hedge_delay_s: float = 3.0, **kw
    ) -> AsyncIterator[str]:
        """降级链 + 熔断 + 首包对冲，专治网关对单模型的间歇 502 / 慢首包。

        - 熔断：刚报错过的模型本回合直接降到末尾，不再每轮白等它的 502；
        - 对冲：选定模型若 hedge_delay_s 内没出首字（真卡住、非报错），并行起
          下一个候选，**谁先吐出首字用谁**，其余取消；报错则立即换下一个；
        - 已选定的流中途失败直接抛（不换模型重来，避免重复内容）。
        健康快速的主模型在对冲计时器触发前就出字 → 不产生第二次调用，常态 1×。
        """
        models = self._prioritize(models)
        if not models:
            raise RuntimeError("未配置聊天模型")
        if len(models) == 1:
            try:
                async for piece in self.chat_stream(messages, model=models[0], **kw):
                    yield piece
            except Exception:
                self._trip(models[0])
                raise
            return

        q: asyncio.Queue[tuple[int, str, object]] = asyncio.Queue()
        tasks: dict[int, asyncio.Task] = {}

        async def run(idx: int):
            try:
                async for piece in self.chat_stream(messages, model=models[idx], **kw):
                    await q.put((idx, "p", piece))
                await q.put((idx, "end", None))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                await q.put((idx, "err", e))

        def launch(idx: int):
            if 0 <= idx < len(models) and idx not in tasks:
                logger.info("chat 尝试模型 %s", models[idx])
                tasks[idx] = asyncio.create_task(run(idx))

        winner: int | None = None
        next_idx = 1
        closed = 0  # 无首字即结束/失败的尝试数
        last_err: Exception | None = None
        launch(0)
        try:
            while True:
                hedging = winner is None and next_idx < len(models)
                try:
                    idx, kind, val = await asyncio.wait_for(
                        q.get(), timeout=hedge_delay_s if hedging else None
                    )
                except asyncio.TimeoutError:
                    launch(next_idx)
                    next_idx += 1
                    continue
                if kind == "p":
                    if winner is None:
                        winner = idx
                        for i, t in tasks.items():
                            if i != idx:
                                t.cancel()
                    if idx == winner:
                        yield val  # type: ignore[misc]
                elif kind == "end":
                    if idx == winner:
                        return
                    if winner is None:
                        closed += 1
                        if next_idx < len(models):
                            launch(next_idx)
                            next_idx += 1
                        elif closed >= len(tasks):
                            return  # 所有候选均空结束
                elif kind == "err":
                    last_err = val  # type: ignore[assignment]
                    self._trip(models[idx])
                    if idx == winner:
                        raise val  # type: ignore[misc]
                    if winner is None:
                        closed += 1
                        if next_idx < len(models):
                            launch(next_idx)
                            next_idx += 1
                        elif closed >= len(tasks):
                            raise last_err or RuntimeError("所有模型均不可用")
        finally:
            for t in tasks.values():
                t.cancel()
            for t in tasks.values():
                with contextlib.suppress(BaseException):
                    await t

    async def image_generate(
        self, prompt: str, models: list[str], size: str = "1024x1024", timeout: float = 120.0
    ) -> tuple[bytes, str]:
        """文生图，按模型链降级（gpt-image-2 渠道开通前自动落到 linkyun-image-default）。

        返回 (图片字节, 实际使用的模型名)。兼容 b64_json 与 url 两种响应。
        """
        last_err: Exception | None = None
        for model in models:
            try:
                resp = await self._client.post(
                    "/v1/images/generations",
                    json={"model": model, "prompt": prompt, "size": size, "n": 1},
                    timeout=timeout,
                )
                if resp.status_code != 200:
                    raise GatewayError(resp.status_code, resp.text[:200])
                data = (resp.json().get("data") or [{}])[0]
                if data.get("b64_json"):
                    import base64

                    return base64.b64decode(data["b64_json"]), model
                if data.get("url"):
                    img = await self._client.get(data["url"], timeout=timeout)
                    img.raise_for_status()
                    return img.content, model
                raise GatewayError(200, "响应中没有图片数据")
            except Exception as e:  # noqa: BLE001
                logger.warning("image model %s failed: %s", model, e)
                last_err = e
        raise last_err or RuntimeError("所有图像模型均不可用")

    async def embeddings(self, texts: list[str], model: str) -> list[list[float]]:
        resp = await self._client.post(
            "/v1/embeddings", json={"model": model, "input": texts}
        )
        if resp.status_code != 200:
            raise GatewayError(resp.status_code, resp.text[:300])
        data = resp.json()["data"]
        data.sort(key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]
