"""ASR 预检（回环测试）：用豆包 TTS 生成的音频喂给实时 ASR，验证 音频→文字。

链路：已知文本 → TTS(wav) → 重采样16k PCM → WS 流式推送 → ASR 识别文本
同时测量尾部延迟（最后一块音频送完 → 收到最终识别结果）。
"""
import asyncio
import json
import uuid

import websockets

from common import OUTPUT, load_env, ms, now, pcm_resample, wav_header_strip

EXPECTED = "你好呀我是灵犀很高兴认识你"
CHUNK = 3200  # 100ms @ 16kHz 16-bit mono


async def asr_loopback(base: str, key: str) -> dict:
    wav_path = OUTPUT / "tts_doubao.wav"
    if not wav_path.exists():
        return {"check": "asr_realtime", "ok": False, "error": "缺少 tts_doubao.wav，请先跑 check_tts"}
    raw = wav_path.read_bytes()
    src_rate, pcm = wav_header_strip(raw)
    pcm16k = pcm_resample(pcm, src_rate or 24000, 16000)

    url = base.replace("https://", "wss://").replace("http://", "ws://")
    url = f"{url}/v1beta/dashscope/asr/ws?api_key={key}"

    texts = []
    t_first_partial = None
    t_final = None
    try:
        task_id = uuid.uuid4().hex
        async with websockets.connect(url, max_size=None, open_timeout=15) as ws:
            run_task = {
                "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": "fun-asr-realtime",
                    "input": {},
                    "parameters": {"sample_rate": 16000, "format": "pcm"},
                },
            }
            await ws.send(json.dumps(run_task))
            # 等 task-started
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                evt = msg.get("header", {}).get("event")
                if evt == "task-started":
                    break
                if evt == "task-failed":
                    return {"check": "asr_realtime", "ok": False, "error": json.dumps(msg, ensure_ascii=False)[:300]}

            async def sender():
                for i in range(0, len(pcm16k), CHUNK):
                    await ws.send(pcm16k[i : i + CHUNK])
                    await asyncio.sleep(0.05)  # 2x 实时推送
                await ws.send(
                    json.dumps(
                        {
                            "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
                            "payload": {"input": {}},
                        }
                    )
                )
                return now()

            send_task = asyncio.create_task(sender())
            t_sent = None
            while True:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                except asyncio.TimeoutError:
                    break
                evt = msg.get("header", {}).get("event")
                if evt == "result-generated":
                    sent = (msg.get("payload", {}).get("output", {}) or {}).get("sentence", {})
                    text = sent.get("text", "")
                    if text:
                        if t_first_partial is None:
                            t_first_partial = now()
                        texts.append(text)
                elif evt in ("task-finished", "task-failed"):
                    t_final = now()
                    break
            t_sent = await send_task
        final_text = texts[-1] if texts else ""
        clean = "".join(ch for ch in final_text if ch.isalnum())
        tail_ms = ms(t_sent, t_final) if (t_sent and t_final) else None
        hit = sum(1 for ch in EXPECTED if ch in clean) / len(EXPECTED)
        return {
            "check": "asr_realtime",
            "model": "fun-asr-realtime",
            "ok": hit > 0.6,
            "recognized": final_text,
            "expected": EXPECTED,
            "char_recall": round(hit, 2),
            "tail_latency_ms": tail_ms,
            "partials": len(texts),
        }
    except Exception as e:  # noqa: BLE001
        return {"check": "asr_realtime", "ok": False, "error": f"{type(e).__name__}: {e}"}


def run(base: str, key: str) -> dict:
    r = asyncio.run(asr_loopback(base, key))
    flag = "OK " if r.get("ok") else "FAIL"
    print(
        f"  [{flag}] fun-asr-realtime 识别='{r.get('recognized', '')[:30]}' "
        f"召回={r.get('char_recall')} 尾延迟={r.get('tail_latency_ms')}ms {r.get('error', '')}"
    )
    return r


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
