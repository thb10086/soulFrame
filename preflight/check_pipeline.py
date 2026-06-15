"""核心预检：三段式语音管线延迟模拟（验证「语音 <3s」目标）。

模拟用户语音输入已完成 ASR 的时刻起：
  LLM 流式生成 → 首句切分 → 豆包 TTS 流式合成 → 首块音频
得到「LLM首token / 首句成句 / TTS首字节」实测值，
再叠加 VAD 预算与 ASR 尾延迟（来自 check_asr 实测），估算端到端延迟。

注意：推理型模型（deepseek-v4 / MiniMax-M2 系列）会先输出 <think>，
语音管线应选非思考型快模型；本脚本对 think 段做了过滤。
"""
import json
import re

import httpx

from common import OUTPUT, PERSONA_PROMPT, iter_sse, load_env, ms, now

CHAT_MODELS = ["M2-her", "qwen3.6-flash-2026-04-16"]
SENT_END = "。！？!?；;\n"
VAD_BUDGET_MS = 400  # 客户端判停预算（工程经验值）
THINK_RE = re.compile(r"<think>.*?</think>", re.S)


def first_sentence_stream(client: httpx.Client, base: str, key: str, model: str) -> dict:
    body = {
        "model": model,
        "stream": True,
        "max_tokens": 256,
        "messages": [
            {"role": "system", "content": PERSONA_PROMPT},
            {"role": "user", "content": "今天有点累，跟我说点开心的事吧"},
        ],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "x-cache": "off"}
    t0 = now()
    ttft = None
    t_sentence = None
    sentence = ""
    full = ""
    in_think = False
    with client.stream("POST", f"{base}/v1/chat/completions", json=body, headers=headers) as resp:
        if resp.status_code != 200:
            resp.read()
            raise RuntimeError(f"LLM HTTP {resp.status_code}: {resp.text[:200]}")
        for data in iter_sse(resp):
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            piece = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
            if not piece:
                continue
            full += piece
            # 过滤思考段：进入<think>后不计入语音文本
            if "<think>" in full and "</think>" not in full:
                in_think = True
                continue
            if in_think and "</think>" in full:
                in_think = False
                continue
            if in_think:
                continue
            if ttft is None:
                ttft = ms(t0)
            if t_sentence is None:
                sentence += piece
                if any(c in SENT_END for c in piece) or len(sentence) >= 24:
                    t_sentence = ms(t0)
    clean = THINK_RE.sub("", full).strip()
    sentence = THINK_RE.sub("", sentence).strip()
    # 去掉角色名前缀（如「灵犀：」）
    sentence = re.sub(r"^[\w\u4e00-\u9fff]{1,6}[:：]\s*", "", sentence)
    return {
        "model": model,
        "ttft_ms": ttft,
        "first_sentence_ms": t_sentence or ms(t0),
        "first_sentence": sentence,
        "full_reply": clean[:120],
    }


def tts_first_byte(client: httpx.Client, base: str, key: str, text: str) -> dict:
    body = {
        "model": "doubao-tts",
        "input": text,
        "voice": "zh_female_vv_uranus_bigtts",
        "response_format": "wav",
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    t0 = now()
    first = None
    buf = b""
    with client.stream("POST", f"{base}/v1/audio/speech", json=body, headers=headers) as resp:
        if resp.status_code != 200:
            resp.read()
            raise RuntimeError(f"TTS HTTP {resp.status_code}: {resp.text[:200]}")
        for chunk in resp.iter_bytes():
            if chunk and first is None:
                first = ms(t0)
            buf += chunk
    out = OUTPUT / "pipeline_first_sentence.wav"
    out.write_bytes(buf)
    return {"tts_first_byte_ms": first, "tts_total_ms": ms(t0), "bytes": len(buf), "file": str(out)}


def run(base: str, key: str, asr_tail_ms=None) -> dict:
    attempts = []
    asr_tail = asr_tail_ms if asr_tail_ms is not None else 400
    with httpx.Client(timeout=90) as client:
        for model in CHAT_MODELS:
            try:
                llm = first_sentence_stream(client, base, key, model)
                if not llm["first_sentence"]:
                    attempts.append({"model": model, "ok": False, "error": "无正文输出（可能为纯思考输出）"})
                    print(f"  [FAIL] {model} 无正文输出")
                    continue
                tts = tts_first_byte(client, base, key, llm["first_sentence"])
                reply_path = llm["first_sentence_ms"] + (tts["tts_first_byte_ms"] or 0)
                e2e = VAD_BUDGET_MS + asr_tail + reply_path
                attempt = {
                    "model": model,
                    "ok": True,
                    "llm_ttft_ms": llm["ttft_ms"],
                    "llm_first_sentence_ms": llm["first_sentence_ms"],
                    "first_sentence": llm["first_sentence"],
                    "tts_first_byte_ms": tts["tts_first_byte_ms"],
                    "reply_path_ms": reply_path,
                    "estimated_e2e_ms": e2e,
                    "full_reply": llm["full_reply"],
                }
                attempts.append(attempt)
                print(
                    f"  [OK ] {model}: LLM首token={llm['ttft_ms']}ms 首句={llm['llm_first_sentence_ms'] if 'llm_first_sentence_ms' in llm else llm['first_sentence_ms']}ms "
                    f"TTS首字节={tts['tts_first_byte_ms']}ms → 估算端到端={e2e}ms"
                )
            except Exception as e:  # noqa: BLE001
                attempts.append({"model": model, "ok": False, "error": f"{type(e).__name__}: {e}"})
                print(f"  [FAIL] {model}: {e}")
    ok_attempts = [a for a in attempts if a.get("ok")]
    best = min(ok_attempts, key=lambda a: a["estimated_e2e_ms"]) if ok_attempts else None
    return {
        "check": "voice_pipeline",
        "ok": bool(best),
        "vad_budget_ms": VAD_BUDGET_MS,
        "asr_tail_ms": asr_tail,
        "attempts": attempts,
        "best_model": best["model"] if best else None,
        "best_e2e_ms": best["estimated_e2e_ms"] if best else None,
        "target_3000ms": (best["estimated_e2e_ms"] < 3000) if best else False,
    }


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
