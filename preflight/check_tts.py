"""TTS 预检：豆包(OpenAI兼容流式) 与 MiniMax(SSE流式) 首块音频延迟。"""
import json

import httpx

from common import OUTPUT, iter_sse, load_env, ms, now

SAMPLE_TEXT = "你好呀，我是灵犀，很高兴认识你！"


def check_doubao(base: str, key: str) -> dict:
    """POST /v1/audio/speech（OpenAI 兼容，底层豆包，流式 WAV）。"""
    body = {
        "model": "doubao-tts",
        "input": SAMPLE_TEXT,
        "voice": "zh_female_vv_uranus_bigtts",
        "response_format": "wav",
        "speed": 1.0,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    t0 = now()
    first = None
    buf = b""
    try:
        with httpx.Client(timeout=60) as client:
            with client.stream("POST", f"{base}/v1/audio/speech", json=body, headers=headers) as resp:
                if resp.status_code != 200:
                    resp.read()
                    return {"engine": "doubao-tts", "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
                for chunk in resp.iter_bytes():
                    if chunk and first is None:
                        first = ms(t0)
                    buf += chunk
        total = ms(t0)
        out = OUTPUT / "tts_doubao.wav"
        out.write_bytes(buf)
        return {
            "engine": "doubao-tts",
            "voice": body["voice"],
            "ok": len(buf) > 1000,
            "first_chunk_ms": first,
            "total_ms": total,
            "bytes": len(buf),
            "file": str(out),
        }
    except Exception as e:  # noqa: BLE001
        return {"engine": "doubao-tts", "ok": False, "error": f"{type(e).__name__}: {e}"}


def check_minimax(base: str, key: str) -> dict:
    """POST /v1beta/minimax/t2a_v2 stream:true（SSE 增量 hex 音频）。"""
    body = {
        "model": "speech-02-turbo",
        "text": SAMPLE_TEXT,
        "stream": True,
        "voice_setting": {"voice_id": "male-qn-qingse", "speed": 1, "vol": 1, "pitch": 0},
        "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3"},
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    t0 = now()
    first = None
    audio_hex = ""
    try:
        with httpx.Client(timeout=60) as client:
            with client.stream("POST", f"{base}/v1beta/minimax/t2a_v2", json=body, headers=headers) as resp:
                if resp.status_code != 200:
                    resp.read()
                    return {"engine": "minimax-t2a", "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
                for data in iter_sse(resp):
                    try:
                        evt = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    piece = (evt.get("data") or {}).get("audio") or ""
                    if piece:
                        if first is None:
                            first = ms(t0)
                        audio_hex += piece
        total = ms(t0)
        audio = bytes.fromhex(audio_hex) if audio_hex else b""
        out = OUTPUT / "tts_minimax.mp3"
        if audio:
            out.write_bytes(audio)
        return {
            "engine": "minimax-t2a(speech-02-turbo)",
            "ok": len(audio) > 1000,
            "first_chunk_ms": first,
            "total_ms": total,
            "bytes": len(audio),
            "file": str(out) if audio else None,
        }
    except Exception as e:  # noqa: BLE001
        return {"engine": "minimax-t2a", "ok": False, "error": f"{type(e).__name__}: {e}"}


def run(base: str, key: str) -> dict:
    results = []
    for fn in (check_doubao, check_minimax):
        r = fn(base, key)
        flag = "OK " if r.get("ok") else "FAIL"
        print(f"  [{flag}] {r.get('engine'):28s} first={r.get('first_chunk_ms')}ms total={r.get('total_ms')}ms {r.get('error', '')}")
        results.append(r)
    return {"check": "tts_streaming", "ok": any(r.get("ok") for r in results), "engines": results}


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
