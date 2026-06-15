"""LLM 流式对话预检：测多模型首 token 延迟（TTFT）与生成速度。"""
import json

import httpx

from common import PERSONA_PROMPT, iter_sse, load_env, ms, now

MODELS = [
    "linkyun-default",
    "deepseek-v4-flash",
    "qwen3.6-flash-2026-04-16",
    "MiniMax-M2.7-highspeed",
    "M2-her",
    "claude-sonnet",
]


def check_one(client: httpx.Client, base: str, key: str, model: str) -> dict:
    body = {
        "model": model,
        "stream": True,
        "max_tokens": 96,
        "messages": [
            {"role": "system", "content": PERSONA_PROMPT},
            {"role": "user", "content": "用一句话跟我打个招呼，介绍你自己~"},
        ],
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "x-cache": "off",
    }
    t0 = now()
    ttft = None
    text = ""
    try:
        with client.stream(
            "POST", f"{base}/v1/chat/completions", json=body, headers=headers
        ) as resp:
            if resp.status_code != 200:
                resp.read()
                return {"model": model, "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
            for data in iter_sse(resp):
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta", {})
                piece = delta.get("content") or ""
                if piece:
                    if ttft is None:
                        ttft = ms(t0)
                    text += piece
        total = ms(t0)
        return {
            "model": model,
            "ok": bool(text),
            "ttft_ms": ttft,
            "total_ms": total,
            "chars": len(text),
            "sample": text[:80],
        }
    except Exception as e:  # noqa: BLE001
        return {"model": model, "ok": False, "error": f"{type(e).__name__}: {e}"}


def run(base: str, key: str) -> dict:
    results = []
    with httpx.Client(timeout=60) as client:
        for m in MODELS:
            r = check_one(client, base, key, m)
            flag = "OK " if r.get("ok") else "FAIL"
            print(f"  [{flag}] {m:30s} ttft={r.get('ttft_ms')}ms total={r.get('total_ms')}ms {r.get('error', '')}")
            results.append(r)
    ok_models = [r for r in results if r.get("ok")]
    return {
        "check": "llm_streaming",
        "ok": len(ok_models) > 0,
        "models": results,
        "fastest_ttft": min((r["ttft_ms"] for r in ok_models if r.get("ttft_ms")), default=None),
    }


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
