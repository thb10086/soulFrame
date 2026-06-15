"""偶像动作池批量烘焙 + 量化指标全表（审美策展第一步）。

对同一绑骨任务批量烘焙候选动作（idle/dance/react 三类），下载到
storage/models3d/_review/ 供动作评审页（/dev/anim-review）逐支目检，
并输出穿模风险指标表（髋骨下沉 + 大腿摆角，见 anim_squat_check.py）。

用法（仓库根目录）：
    backend/.venv/bin/python backend/scripts/bake_action_pool.py [rig_task_id]
未传 rig_task_id 时自动反查最近一次成功绑骨任务。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import settings  # noqa: E402
from scripts.anim_squat_check import check  # noqa: E402

# 候选清单（2026-06-12 从 680 动作目录人工初筛，偶像气质优先）
CANDIDATES: dict[str, dict[int, str]] = {
    "idle": {
        11: "Idle 1 (style_03)",
        12: "Idle 2 (style_03)",
        243: "Idle 3",
        244: "Idle 4",
    },
    "react": {
        25: "Agree Gesture",
        41: "Formal Bow",
        290: "Wave One Hand",
        298: "Cheer with Both Hands Up",
    },
    "dance": {
        65: "Bass Beats",
        67: "Bubble Dance",
        69: "Crystal Beads",
        71: "Denim Pop Dance",
        75: "Indoor Swing",
        77: "Magic Genie",
        79: "OMG Groove",
        80: "Pop Dance LSA2",
        81: "Pod Baby Groove",
        82: "Shake It Off Dance",
        84: "You Groove",
        595: "Jazz Danc",
    },
}
OUT_DIR = ROOT / "storage" / "models3d" / "_review"
CONCURRENCY = 4  # Meshy 任务并发（避免触发限流）


async def main(rig_task_id: str | None):
    if not settings.meshy_api_key:
        sys.exit("MESHY_API_KEY 未配置")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient(
        base_url="https://api.meshy.ai",
        headers={"Authorization": f"Bearer {settings.meshy_api_key}"},
        timeout=120.0,
        trust_env=False,
    ) as c:
        if not rig_task_id:
            r = await c.get(
                "/openapi/v1/rigging", params={"page_size": 10, "sort_by": "-created_at"}
            )
            r.raise_for_status()
            ok = [it["id"] for it in r.json() if it.get("status") == "SUCCEEDED"]
            if not ok:
                sys.exit("绑骨任务列表为空，请显式传 rig_task_id")
            rig_task_id = ok[0]
        print(f"rig_task_id = {rig_task_id}")

        async def bake(kind: str, action_id: int, name: str):
            out = OUT_DIR / f"{kind}_{action_id}.glb"
            if out.exists():
                return kind, action_id, name, out  # 幂等：已烘过跳过
            async with sem:
                r = await c.post(
                    "/openapi/v1/animations",
                    json={"rig_task_id": rig_task_id, "action_id": action_id},
                )
                if r.status_code >= 400:
                    print(f"  ✗ [{action_id}] {name}: {r.status_code} {r.text[:100]}")
                    return kind, action_id, name, None
                tid = r.json()["result"]
                for _ in range(150):
                    await asyncio.sleep(4)
                    q = await c.get(f"/openapi/v1/animations/{tid}")
                    q.raise_for_status()
                    d = q.json()
                    if d.get("status") == "SUCCEEDED":
                        url = (d.get("result") or {}).get("animation_glb_url")
                        if not url:
                            print(f"  ✗ [{action_id}] {name}: 无 GLB")
                            return kind, action_id, name, None
                        glb = await c.get(url)
                        out.write_bytes(glb.content)
                        print(f"  ✓ [{action_id}] {name} → {out.name}")
                        return kind, action_id, name, out
                    if d.get("status") in ("FAILED", "CANCELED"):
                        print(f"  ✗ [{action_id}] {name}: 任务失败")
                        return kind, action_id, name, None
                print(f"  ✗ [{action_id}] {name}: 超时")
                return kind, action_id, name, None

        jobs = [
            bake(kind, a, n)
            for kind, items in CANDIDATES.items()
            for a, n in items.items()
        ]
        results = await asyncio.gather(*jobs)

    print("\n=== 量化指标（按类别 → 大腿摆角升序） ===")
    rows = []
    for kind, action_id, name, f in results:
        if not f:
            continue
        m = check(f)
        rows.append((kind, m["thigh_deg"], m["drop_ratio"], action_id, name, m["risk"]))
    for kind in ("idle", "react", "dance"):
        print(f"--- {kind} ---")
        for k, thigh, drop, action_id, name, risk in sorted(
            (r for r in rows if r[0] == kind), key=lambda x: x[1]
        ):
            flag = {"low": "✅", "medium": "🟡", "high": "⚠️"}[risk]
            print(f"{flag} {action_id:>4} {name:<26} 大腿 {thigh:>6.1f}° 髋沉 {drop:.0%}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
