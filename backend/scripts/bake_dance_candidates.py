"""候选舞蹈烘焙对比：对最近一次绑骨任务烘多支舞，量化裙装穿模风险后选优。

背景：GIF 预览抽帧会漏掉瞬时深蹲/踢腿帧（实测 83 Superlove Pop 预览看似
站立系，实际大腿摆角 84°）。本脚本数据驱动选舞：

1. 从 Meshy 动画任务列表反查最近的 rig_task_id（或命令行指定）
2. 对候选 action_id 各烘一支（3 credits/个）
3. 下载 GLB 跑 anim_squat_check 指标，按「髋骨下沉 + 大腿摆角」排序输出

用法（在仓库根目录）：
    backend/.venv/bin/python backend/scripts/bake_dance_candidates.py [rig_task_id]
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

# 候选舞（Dancing 类，GIF 预览初筛为站立系）
CANDIDATES = {
    64: "All Night Dance",
    68: "Cherish Pop Dance",
    76: "Love You Pop Dance",
}
OUT_DIR = Path("/tmp/sf_dance_bake")


async def main(rig_task_id: str | None):
    s = settings
    if not s.meshy_api_key:
        sys.exit("MESHY_API_KEY 未配置")
    async with httpx.AsyncClient(
        base_url="https://api.meshy.ai",
        headers={"Authorization": f"Bearer {s.meshy_api_key}"},
        timeout=60.0,
        trust_env=False,
    ) as c:
        if not rig_task_id:
            # 反查最近一次成功的绑骨任务
            r = await c.get(
                "/openapi/v1/rigging",
                params={"page_size": 10, "sort_by": "-created_at"},
            )
            r.raise_for_status()
            items = r.json() if isinstance(r.json(), list) else []
            ok = [it["id"] for it in items if it.get("status") == "SUCCEEDED"]
            if not ok:
                sys.exit("绑骨任务列表为空，请显式传 rig_task_id")
            rig_task_id = ok[0]
        print(f"rig_task_id = {rig_task_id}")
        OUT_DIR.mkdir(exist_ok=True)

        async def bake(action_id: int, name: str) -> Path | None:
            r = await c.post(
                "/openapi/v1/animations",
                json={"rig_task_id": rig_task_id, "action_id": action_id},
            )
            if r.status_code >= 400:
                print(f"  [{action_id}] {name}: 创建失败 {r.status_code} {r.text[:120]}")
                return None
            tid = r.json()["result"]
            for _ in range(120):
                await asyncio.sleep(4)
                q = await c.get(f"/openapi/v1/animations/{tid}")
                q.raise_for_status()
                d = q.json()
                if d.get("status") == "SUCCEEDED":
                    url = (d.get("result") or {}).get("animation_glb_url")
                    if not url:
                        print(f"  [{action_id}] {name}: 无 GLB")
                        return None
                    glb = await c.get(url)
                    out = OUT_DIR / f"dance_{action_id}.glb"
                    out.write_bytes(glb.content)
                    return out
                if d.get("status") in ("FAILED", "CANCELED"):
                    print(f"  [{action_id}] {name}: 任务失败")
                    return None
            print(f"  [{action_id}] {name}: 超时")
            return None

        files = await asyncio.gather(
            *(bake(a, n) for a, n in CANDIDATES.items())
        )
        print("\n=== 裙装穿模风险对比（越小越安全） ===")
        results = []
        for (action_id, name), f in zip(CANDIDATES.items(), files):
            if not f:
                continue
            r = check(f)
            results.append((r["thigh_deg"], r["drop_ratio"], action_id, name, r["skirt_risk"]))
        for thigh, drop, action_id, name, risk in sorted(results):
            flag = "⚠️" if risk else "✅"
            print(f"{flag} action {action_id:>3} {name:<22} 大腿摆角 {thigh:>5.1f}° 髋骨下沉 {drop:.0%}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
