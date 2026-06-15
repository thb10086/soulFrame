"""文生图预检：生成一张角色立绘样图（角色外观生成能力验证）。"""
import base64
import json

import httpx

from common import OUTPUT, load_env, ms, now

PROMPT = (
    "anime style virtual character portrait, a gentle girl with teal hair and "
    "bright eyes, upper body, clean pastel background, high quality illustration"
)
MODELS = ["gpt-image-2", "linkyun-image-default"]


def try_model(client: httpx.Client, base: str, key: str, model: str) -> dict:
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    body = {"model": model, "prompt": PROMPT, "size": "1024x1024", "n": 1}
    t0 = now()
    try:
        resp = client.post(f"{base}/v1/images/generations", json=body, headers=headers)
        if resp.status_code != 200:
            return {"model": model, "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
        data = (resp.json().get("data") or [{}])[0]
        img = None
        if data.get("b64_json"):
            img = base64.b64decode(data["b64_json"])
        elif data.get("url"):
            img = client.get(data["url"]).content
        if not img:
            return {"model": model, "ok": False, "error": "无图像数据"}
        out = OUTPUT / f"character_{model.replace('/', '_')}.png"
        out.write_bytes(img)
        return {"model": model, "ok": True, "total_ms": ms(t0), "bytes": len(img), "file": str(out)}
    except Exception as e:  # noqa: BLE001
        return {"model": model, "ok": False, "error": f"{type(e).__name__}: {e}"}


def run(base: str, key: str) -> dict:
    results = []
    with httpx.Client(timeout=240) as client:
        for m in MODELS:
            r = try_model(client, base, key, m)
            flag = "OK " if r.get("ok") else "FAIL"
            print(f"  [{flag}] {m:24s} total={r.get('total_ms')}ms {r.get('error', '')}")
            results.append(r)
            if r.get("ok"):
                break  # 一个成功即可，省成本
    return {"check": "image_generation", "ok": any(r.get("ok") for r in results), "models": results}


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
