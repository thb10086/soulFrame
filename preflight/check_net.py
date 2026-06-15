"""网络基线：本机到网关的 HTTP 往返延迟（用于解读各项模型延迟）。"""
import json
import statistics

import httpx

from common import load_env, ms, now


def run(base: str, key: str) -> dict:
    headers = {"Authorization": f"Bearer {key}"}
    rtts = []
    try:
        with httpx.Client(timeout=20) as client:
            for _ in range(4):
                t0 = now()
                resp = client.get(f"{base}/v1/models", headers=headers)
                resp.raise_for_status()
                rtts.append(ms(t0))
        # 第一次包含 TCP+TLS 握手，单独记
        cold, warm = rtts[0], rtts[1:]
        result = {
            "check": "network_baseline",
            "ok": True,
            "cold_rtt_ms": cold,
            "warm_rtt_ms": round(statistics.mean(warm)),
            "warm_rtts": warm,
        }
        print(f"  [OK ] 冷启动RTT={cold}ms 热RTT均值={result['warm_rtt_ms']}ms {warm}")
        return result
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] {e}")
        return {"check": "network_baseline", "ok": False, "error": f"{type(e).__name__}: {e}"}


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
