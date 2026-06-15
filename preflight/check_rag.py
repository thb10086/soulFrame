"""RAG 前置预检：探测网关 Embedding 与 Rerank 是否已开通。

模型清单里没有明显的 embedding 模型，这里多尝试几个常见 id，
任何一个成功即说明 RAG 链路的向量化前置条件具备；全部失败则是缺口，
需要找网关管理员开通，或本地部署 bge-m3 等开源 embedding。
"""
import json

import httpx

from common import load_env, ms, now

EMBED_CANDIDATES = [
    "text-embedding-3-small",
    "text-embedding-v4",
    "text-embedding-v3",
    "bge-m3",
    "embedding-default",
]
RERANK_CANDIDATES = ["gte-rerank", "bge-reranker-v2-m3", "rerank-default"]


def run(base: str, key: str) -> dict:
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    embed_results = []
    rerank_results = []
    with httpx.Client(timeout=30) as client:
        for m in EMBED_CANDIDATES:
            t0 = now()
            try:
                resp = client.post(
                    f"{base}/v1/embeddings",
                    json={"model": m, "input": ["虚拟角色记忆测试"]},
                    headers=headers,
                )
                if resp.status_code == 200:
                    dim = len(resp.json()["data"][0]["embedding"])
                    embed_results.append({"model": m, "ok": True, "dim": dim, "ms": ms(t0)})
                    print(f"  [OK ] embeddings {m} dim={dim}")
                    break
                embed_results.append({"model": m, "ok": False, "error": f"HTTP {resp.status_code}"})
                print(f"  [FAIL] embeddings {m} HTTP {resp.status_code}")
            except Exception as e:  # noqa: BLE001
                embed_results.append({"model": m, "ok": False, "error": str(e)})
        for m in RERANK_CANDIDATES:
            t0 = now()
            try:
                resp = client.post(
                    f"{base}/v1/rerank",
                    json={
                        "model": m,
                        "query": "角色的生日是哪天",
                        "documents": ["角色喜欢蓝色", "角色生日是6月1日", "今天天气不错"],
                    },
                    headers=headers,
                )
                if resp.status_code == 200:
                    rerank_results.append({"model": m, "ok": True, "ms": ms(t0)})
                    print(f"  [OK ] rerank {m}")
                    break
                rerank_results.append({"model": m, "ok": False, "error": f"HTTP {resp.status_code}"})
                print(f"  [FAIL] rerank {m} HTTP {resp.status_code}")
            except Exception as e:  # noqa: BLE001
                rerank_results.append({"model": m, "ok": False, "error": str(e)})
    return {
        "check": "rag_prereq",
        "embedding_ok": any(r.get("ok") for r in embed_results),
        "rerank_ok": any(r.get("ok") for r in rerank_results),
        "ok": any(r.get("ok") for r in embed_results),
        "embeddings": embed_results,
        "rerank": rerank_results,
    }


if __name__ == "__main__":
    base, key = load_env()
    print(json.dumps(run(base, key), ensure_ascii=False, indent=2))
