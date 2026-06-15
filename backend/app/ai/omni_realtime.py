"""Qwen-Omni Realtime 中继：浏览器 ⇄ 后端 ⇄ 网关，电话式连续语音通话。

上游协议为 OpenAI Realtime 风格（经预检 check_realtime.py 验证）：
- 开启 server_vad：用户停顿即出回复，无需按键说话
- 用户开口打断：上游发 speech_started，本端转发并 response.cancel
- 下行音频：response.audio.delta(base64 pcm16@24k) → 直接以二进制帧转发给浏览器
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import random

import websockets

from ..config import settings

logger = logging.getLogger(__name__)

REALTIME_VOICES = {"Cherry", "Serena", "Ethan", "Chelsie"}
IN_SAMPLE_RATE = 16000
OUT_SAMPLE_RATE = 24000

# 简易情绪→动作映射（动作反馈；Haru 模板含 Idle / TapBody 两组动作）
_HAPPY = ("哈哈", "嘿嘿", "开心", "太棒", "太好", "好呀", "耶", "喜欢")
_SAD = ("抱歉", "对不起", "难过", "呜", "伤心", "委屈")
_THINK = ("让我想", "想一想", "思考", "嗯……")


def pick_motion(stage: str, text: str = "") -> dict:
    if stage == "start":
        return {"emotion": "talk", "group": "TapBody" if random.random() < 0.5 else "Idle"}
    if any(w in text for w in _SAD):
        return {"emotion": "sad", "group": "Idle"}
    if any(w in text for w in _HAPPY):
        return {"emotion": "happy", "group": "TapBody"}
    if any(w in text for w in _THINK):
        return {"emotion": "think", "group": "Idle"}
    return {"emotion": "neutral", "group": "Idle"}


class OmniRelay:
    """一次通话会话。send_json/send_bytes 为面向浏览器的发送函数。"""

    def __init__(self, send_json, send_bytes, persona: str, voice: str | None):
        self.send_json = send_json
        self.send_bytes = send_bytes
        self.persona = persona
        self.voice = voice if voice in REALTIME_VOICES else settings.realtime_voice_default
        self.upstream: websockets.ClientConnection | None = None
        self._pump_task: asyncio.Task | None = None
        self._responding = False
        self._cancelling = False  # 打断后丢弃在途音频，防止"僵尸音频"续播成重复卡顿
        self._transcript = ""

    async def start(self):
        base = settings.agentllm_base_url.replace("https://", "wss://").replace("http://", "ws://")
        url = (f"{base}/v1beta/dashscope/realtime/ws"
               f"?api_key={settings.agentllm_api_key}&model={settings.realtime_model}")
        self.upstream = await websockets.connect(url, max_size=None, open_timeout=20, proxy=None)
        await asyncio.wait_for(self.upstream.recv(), timeout=15)  # session.created
        await self.upstream.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "voice": self.voice,
                "instructions": self.persona,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                # 调低灵敏度 + 拉长静音判停：避免回声/环境音误触发自动应答、
                # 避免一句话被切成多段导致连发多条回复（阈值见 .env 可调）
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": settings.realtime_vad_threshold,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": settings.realtime_vad_silence_ms,
                },
            },
        }))
        self._pump_task = asyncio.create_task(self._pump())

    async def feed_audio(self, pcm: bytes):
        """浏览器麦克风 PCM16@16k → 上游缓冲（server_vad 自动断句）。"""
        if self.upstream:
            await self.upstream.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm).decode(),
            }))

    async def cancel_response(self):
        if self.upstream and self._responding:
            try:
                await self.upstream.send(json.dumps({"type": "response.cancel"}))
            except websockets.ConnectionClosed:
                pass

    async def _pump(self):
        """上游事件 → 浏览器事件/二进制音频。"""
        try:
            async for raw in self.upstream:
                msg = json.loads(raw)
                t = msg.get("type", "")
                if t == "response.audio.delta":
                    # 已被打断的回复：在途音频直接丢弃（送去浏览器会在打断后续播）
                    if not self._cancelling and (delta := msg.get("delta")):
                        await self.send_bytes(base64.b64decode(delta))
                elif t in ("response.audio_transcript.delta", "response.text.delta"):
                    if self._cancelling:
                        continue
                    piece = msg.get("delta") or ""
                    if piece:
                        self._transcript += piece
                        await self.send_json("llm.delta", text=piece)
                elif t == "input_audio_buffer.speech_started":
                    await self.send_json("vad.speech_start")
                    if self._responding:
                        self._cancelling = True
                    await self.cancel_response()  # 用户开口 = 打断
                elif t == "input_audio_buffer.speech_stopped":
                    await self.send_json("vad.speech_stop")
                elif t == "conversation.item.input_audio_transcription.completed":
                    if text := (msg.get("transcript") or "").strip():
                        await self.send_json("asr.final", text=text)
                elif t == "response.created":
                    self._responding = True
                    self._cancelling = False
                    self._transcript = ""
                    await self.send_json("turn.start", motion=pick_motion("start"))
                elif t in ("response.done", "response.cancelled"):
                    self._responding = False
                    self._cancelling = False
                    await self.send_json("turn.end", text=self._transcript,
                                         motion=pick_motion("end", self._transcript))
                elif t == "error":
                    logger.warning("omni 上游错误: %s", msg)
                    await self.send_json("error", code="upstream",
                                         message=json.dumps(msg, ensure_ascii=False)[:200],
                                         recoverable=True)
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception as e:  # noqa: BLE001
            logger.exception("omni 中继异常")
            try:
                await self.send_json("error", code="relay_failed", message=str(e)[:200],
                                     recoverable=False)
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                await self.send_json("voice.closed")
            except Exception:  # noqa: BLE001
                pass

    async def close(self):
        if self._pump_task:
            self._pump_task.cancel()
        if self.upstream:
            try:
                await self.upstream.close()
            except Exception:  # noqa: BLE001
                pass
