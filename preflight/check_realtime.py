"""端到端实时语音对话预检（Qwen-Omni Realtime，OpenAI Realtime 协议）。

发送一段 16k PCM 用户语音 → 测量 首个音频增量(response.audio.delta) 延迟。
这是「三段式管线」之外的第二条实时语音路线（自带打断）。
"""
import asyncio
import base64
import json

import websockets

from common import OUTPUT, load_env, ms, now, pcm_resample, wav_header_strip

MODEL = "qwen3-omni-flash-realtime"


async def realtime_check(base: str, key: str) -> dict:
    wav_path = OUTPUT / "tts_doubao.wav"
    if not wav_path.exists():
        return {"check": "realtime_s2s", "ok": False, "error": "缺少 tts_doubao.wav，请先跑 check_tts"}
    src_rate, pcm = wav_header_strip(wav_path.read_bytes())
    pcm16k = pcm_resample(pcm, src_rate or 24000, 16000)

    url = base.replace("https://", "wss://").replace("http://", "ws://")
    url = f"{url}/v1beta/dashscope/realtime/ws?api_key={key}&model={MODEL}"

    t_first_audio = None
    t_first_text = None
    transcript = ""
    audio_bytes = 0
    try:
        async with websockets.connect(url, max_size=None, open_timeout=20) as ws:
            # session.created
            await asyncio.wait_for(ws.recv(), timeout=15)
            await ws.send(
                json.dumps(
                    {
                        "type": "session.update",
                        "session": {
                            "modalities": ["text", "audio"],
                            "voice": "Cherry",
                            "instructions": "你是温柔的虚拟角色灵犀，回复要简短，不超过30字。",
                            "input_audio_format": "pcm16",
                            "output_audio_format": "pcm16",
                            "turn_detection": None,
                        },
                    }
                )
            )
            # 推送用户语音（base64 PCM16 @16k）
            step = 32000  # 1s
            for i in range(0, len(pcm16k), step):
                await ws.send(
                    json.dumps(
                        {
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(pcm16k[i : i + step]).decode(),
                        }
                    )
                )
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            t0 = now()
            await ws.send(json.dumps({"type": "response.create"}))

            while True:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                except asyncio.TimeoutError:
                    return {"check": "realtime_s2s", "ok": False, "error": "等待响应超时", "transcript": transcript}
                mtype = msg.get("type", "")
                if mtype == "response.audio.delta":
                    if t_first_audio is None:
                        t_first_audio = ms(t0)
                    audio_bytes += len(base64.b64decode(msg.get("delta", "") or ""))
                elif mtype in ("response.audio_transcript.delta", "response.text.delta"):
                    if t_first_text is None:
                        t_first_text = ms(t0)
                    transcript += msg.get("delta", "") or ""
                elif mtype == "response.done":
                    total = ms(t0)
                    return {
                        "check": "realtime_s2s",
                        "model": MODEL,
                        "ok": audio_bytes > 0,
                        "first_audio_ms": t_first_audio,
                        "first_text_ms": t_first_text,
                        "total_ms": total,
                        "audio_bytes": audio_bytes,
                        "transcript": transcript[:80],
                    }
                elif mtype == "error":
                    return {"check": "realtime_s2s", "ok": False, "error": json.dumps(msg, ensure_ascii=False)[:300]}
    except Exception as e:  # noqa: BLE001
        return {"check": "realtime_s2s", "ok": False, "error": f"{type(e).__name__}: {e}"}


def run(base: str, key: str) -> dict:
    r = asyncio.run(realtime_check(base, key))
    flag = "OK " if r.get("ok") else "FAIL"
    print(
        f"  [{flag}] {MODEL} 首音频={r.get('first_audio_ms')}ms 回复='{r.get('transcript', '')[:30]}' {r.get('error', '')}"
    )
    return r


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
