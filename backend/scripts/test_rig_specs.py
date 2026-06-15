"""实测 Tripo 绑骨产物的骨骼命名（决定前端动作重定向方案）。

同一 image_to_model 任务上并行测试：
  A) animate_rig  v1.0-20240301  out_format=glb  spec=mixamo
  B) animate_rig  v2.5-20260210  out_format=fbx  spec=mixamo
检查产物骨骼名是否为标准 mixamo（mixamorig:*）命名。
"""
import asyncio
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.ai.mesh3d import TripoProvider  # noqa: E402


def env(key: str) -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return ""


def glb_joints(path: Path) -> list[str]:
    d = path.read_bytes()
    ln = struct.unpack("<I", d[12:16])[0]
    g = json.loads(d[20 : 20 + ln])
    nodes = [n.get("name", "") for n in g.get("nodes", [])]
    skins = g.get("skins", [])
    return [nodes[j] for j in skins[0]["joints"]] if skins else []


async def main():
    key = env("TRIPO_API_KEY")
    proxy = env("OUTBOUND_PROXY")
    p = TripoProvider(key, proxy=proxy)
    out = ROOT / "storage" / "models3d"
    try:
        print("balance:", await p.balance(), flush=True)
        img = (ROOT / "storage/portraits/portrait_1781229718_819f2c.png").read_bytes()
        model = await p.image_to_model(img)
        print("MODEL_TASK", model["task_id"], flush=True)

        async def rig(tag: str, body: dict):
            tid = await p._create_task({"type": "animate_rig", "original_model_task_id": model["task_id"], **body})
            data = await p._poll(tid)
            url = p._model_url(data)
            print(tag, "url:", (url or "")[:90], flush=True)
            if not url:
                print(tag, "RAW:", json.dumps(data)[:400], flush=True)
                return
            import httpx

            async with httpx.AsyncClient(timeout=300, proxy=proxy or None, follow_redirects=True, trust_env=False) as c:
                r = await c.get(url)
                ext = "fbx" if body.get("out_format") == "fbx" else "glb"
                f = out / f"test_{tag}.{ext}"
                f.write_bytes(r.content)
                print(tag, "saved", f.name, len(r.content) // 1024, "KB", flush=True)
                if ext == "glb":
                    print(tag, "JOINTS:", glb_joints(f)[:14], flush=True)
                else:
                    raw = r.content
                    hit = b"mixamorig" in raw
                    tripo_hit = b"tripo::" in raw
                    print(tag, f"fbx contains mixamorig={hit} tripo::={tripo_hit}", flush=True)

        await asyncio.gather(
            rig("v1glb_mixamo", {"out_format": "glb", "model_version": "v1.0-20240301", "spec": "mixamo"}),
            rig("v25fbx_mixamo", {"out_format": "fbx", "model_version": "v2.5-20260210", "spec": "mixamo"}),
        )
        print("balance after:", await p.balance(), flush=True)
    finally:
        await p.aclose()
    print("TEST_DONE", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
