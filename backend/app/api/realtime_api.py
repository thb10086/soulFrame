"""实时交互 WS（架构文档 V1.1 §5 协议）。

- 文本回合：session.start / text.input / interrupt / session.end
- 语音通话（电话式）：voice.start 后浏览器持续推送二进制 PCM16@16k 帧，
  经 OmniRelay 中继到 Qwen-Omni Realtime（server VAD 自动断句，可随时开口打断），
  下行音频以二进制帧回传（PCM16@24k），文本/VAD/动作以 JSON 事件回传。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from ..ai.memory_provider import DEFAULT_USER_ID
from ..ai.omni_realtime import IN_SAMPLE_RATE, OUT_SAMPLE_RATE, OmniRelay, pick_motion
from ..config import settings

router = APIRouter(tags=["realtime"])
logger = logging.getLogger(__name__)

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"
NAME_PREFIX_RE = re.compile(r"^[\w\u4e00-\u9fff]{1,6}[:：]\s*")

DEFAULT_PERSONA = (
    "你是「灵犀」，一个温柔、活泼的二次元虚拟角色。"
    "说话简短自然，像朋友聊天，单次回复不超过80字。"
)


class ThinkFilter:
    """流式剥离 <think>…</think> 与说话人前缀。"""

    def __init__(self):
        self._buf = ""
        self._in_think = False
        self._prefix_checked = False

    def feed(self, piece: str) -> str:
        self._buf += piece
        out = []
        while self._buf:
            if self._in_think:
                idx = self._buf.find(THINK_CLOSE)
                if idx < 0:
                    self._buf = self._buf[-len(THINK_CLOSE):]
                    break
                self._buf = self._buf[idx + len(THINK_CLOSE):]
                self._in_think = False
                continue
            idx = self._buf.find(THINK_OPEN)
            if idx < 0:
                # 留尾防止标签被截断
                emit, self._buf = self._buf[: -len(THINK_OPEN)] or "", self._buf[-len(THINK_OPEN):]
                if len(self._buf) < len(THINK_OPEN):
                    emit, self._buf = emit + self._buf, ""
                out.append(emit)
                break
            out.append(self._buf[:idx])
            self._buf = self._buf[idx + len(THINK_OPEN):]
            self._in_think = True
        text = "".join(out)
        if text and not self._prefix_checked:
            stripped = NAME_PREFIX_RE.sub("", text)
            if stripped != text or len(text) > 12:
                self._prefix_checked = True
                text = stripped
        return text

    def flush(self) -> str:
        if self._in_think:
            return ""
        rest, self._buf = self._buf, ""
        return rest


@router.websocket("/api/v1/realtime")
async def realtime_ws(ws: WebSocket):
    await ws.accept()
    client = ws.app.state.gateway
    # 统一记忆对接位（AgentMem，默认 Null no-op）：检索注入与回合写入均不阻断对话
    memory = ws.app.state.memory_provider
    history: list[dict] = []
    persona = DEFAULT_PERSONA
    char_voice: str | None = None
    char_id_ref: int | None = None
    last_asr_text = ""
    gen_task: asyncio.Task | None = None
    relay: OmniRelay | None = None

    async def send(event: str, **payload):
        nonlocal last_asr_text
        # 连接已关闭（客户端挂断/关页）则静默跳过，避免 "send after close" 错误刷屏
        if ws.application_state == WebSocketState.CONNECTED:
            try:
                await ws.send_text(json.dumps({"event": event, **payload}, ensure_ascii=False))
            except (RuntimeError, WebSocketDisconnect):
                pass
        # 通话回合记忆挂点（与连接状态解耦：挂断也要把这轮记忆写下去）
        if not memory.enabled or relay is None:
            return
        if event == "asr.final":
            last_asr_text = payload.get("text") or ""
        elif event == "turn.end" and (reply := payload.get("text")):
            turns = ([{"role": "user", "content": last_asr_text}] if last_asr_text else [])
            turns.append({"role": "assistant", "content": reply})
            last_asr_text = ""
            asyncio.create_task(memory.append(char_id_ref, DEFAULT_USER_ID, turns))

    async def send_bytes(data: bytes):
        if ws.application_state != WebSocketState.CONNECTED:
            return
        try:
            await ws.send_bytes(data)
        except (RuntimeError, WebSocketDisconnect):
            pass

    async def generate(user_text: str):
        history.append({"role": "user", "content": user_text})
        messages = [{"role": "system", "content": persona}]
        # 文本回合记忆挂点：检索相关记忆注入第二条 system
        if memory.enabled:
            if mem_ctx := await memory.fetch_context(char_id_ref, DEFAULT_USER_ID, user_text):
                messages.append({"role": "system", "content": mem_ctx})
        messages += history[-20:]
        filt = ThinkFilter()
        reply = ""
        try:
            async for piece in client.chat_stream_with_fallback(
                messages, models=[settings.chat_model] + settings.chat_fallback_models
            ):
                clean = filt.feed(piece)
                if clean:
                    reply += clean
                    await send("llm.delta", text=clean)
            tail = filt.flush()
            if tail:
                reply += tail
                await send("llm.delta", text=tail)
            history.append({"role": "assistant", "content": reply})
            await send("turn.end", usage={"chars": len(reply)}, motion=pick_motion("end", reply))
            if memory.enabled and reply:
                asyncio.create_task(memory.append(
                    char_id_ref, DEFAULT_USER_ID,
                    [{"role": "user", "content": user_text},
                     {"role": "assistant", "content": reply}],
                ))
        except asyncio.CancelledError:
            history.append({"role": "assistant", "content": reply})
            await send("interrupted", at_chars=len(reply))
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("生成失败")
            await send("error", code="llm_failed", message=str(e)[:200], recoverable=True)

    try:
        while True:
            data = await ws.receive()
            if data.get("type") == "websocket.disconnect":
                break

            # 二进制帧 = 通话中的麦克风 PCM16@16k
            if (chunk := data.get("bytes")) is not None:
                if relay:
                    await relay.feed_audio(chunk)
                continue

            try:
                msg = json.loads(data.get("text") or "")
            except json.JSONDecodeError:
                await send("error", code="bad_json", message="非法JSON", recoverable=True)
                continue
            event = msg.get("event")

            if event == "session.start":
                char_name = "灵犀"
                if char_id := msg.get("character_id"):
                    from .characters_api import load_character_persona

                    char_id_ref = int(char_id)
                    char_name, persona, char_voice = await load_character_persona(
                        ws.app, int(char_id))
                if cfg := msg.get("persona"):
                    persona = cfg
                await send("session.ready", session_id="dev", route="pipeline",
                           mode=msg.get("mode", "text"), character_name=char_name)

            elif event == "voice.start":
                # 电话式通话：开启 Omni Realtime 中继（server VAD，免按键）
                if relay:
                    await relay.close()
                    relay = None
                if char_id := msg.get("character_id"):
                    from .characters_api import load_character_persona

                    char_id_ref = int(char_id)
                    _, persona, char_voice = await load_character_persona(ws.app, int(char_id))
                call_persona = persona
                # 通话记忆挂点：开场检索核心记忆拼入人设（通话内逐句检索延迟不可接受）
                if memory.enabled:
                    if mem_ctx := await memory.fetch_context(
                        char_id_ref, DEFAULT_USER_ID, "用户重要偏好、关系与近期话题"
                    ):
                        call_persona = f"{persona}\n\n{mem_ctx}"
                relay = OmniRelay(send, send_bytes, persona=call_persona, voice=char_voice)
                try:
                    await relay.start()
                    await send("voice.ready", route="realtime_s2s", voice=relay.voice,
                               sample_rate_in=IN_SAMPLE_RATE, sample_rate_out=OUT_SAMPLE_RATE)
                except Exception as e:  # noqa: BLE001
                    logger.exception("通话建立失败")
                    relay = None
                    await send("error", code="voice_start_failed", message=str(e)[:200],
                               recoverable=True)

            elif event == "voice.stop":
                if relay:
                    await relay.close()
                    relay = None
                await send("voice.stopped")

            elif event == "text.input":
                if relay:
                    await send("error", code="in_call", message="通话中暂不支持文字输入",
                               recoverable=True)
                    continue
                if gen_task and not gen_task.done():
                    await send("error", code="busy", message="上一轮未结束，可先 interrupt",
                               recoverable=True)
                    continue
                gen_task = asyncio.create_task(generate(msg.get("text", "")))

            elif event == "interrupt":
                if relay:
                    await relay.cancel_response()
                elif gen_task and not gen_task.done():
                    gen_task.cancel()

            elif event == "session.end":
                await send("turn.end", usage={})
                break
    except WebSocketDisconnect:
        pass
    finally:
        if gen_task and not gen_task.done():
            gen_task.cancel()
        if relay:
            await relay.close()
