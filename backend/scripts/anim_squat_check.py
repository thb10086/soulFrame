"""动画穿模风险预检：量化 GLB 动画的髋骨下沉 + 大腿最大摆角。

背景：AI 绑骨没有裙摆专用骨/布料解算，裙装角色一旦深蹲/高抬腿，大腿必然
顶穿裙摆（2026-06-12 实测 Meshy 动作 78 Rhythmic Dance 蹲姿帧穿模）。
本脚本零依赖解析 GLB（JSON chunk + BIN chunk），输出两个指标：

1. Hips 下沉比例 = (restY - minY) / restY     —— 深蹲/跪地动作
2. UpLeg 最大摆角（大腿骨旋转相对静止位姿的最大角度）—— 抬腿/盘腿/蹲姿
   实测大腿摆角才是裙摆穿模的主导因素（蹲姿髋骨可能只降 14%，但大腿转 70°+）

分级（2026-06-12 实测 Meshy 舞蹈类动作大腿摆角普遍 59°~102°，穿模无法
靠选舞完全消除，只能选低风险段 + 接受瞬时轻微穿模）：
    大腿摆角 <60° 且下沉 <25% → 低风险；60~90° → 中风险；>90° 或深蹲 → 高风险

用法：
    python3 backend/scripts/anim_squat_check.py storage/models3d/**/anim_*.glb
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

COMP_FMT = {5126: ("f", 4)}  # FLOAT
SQUAT_THRESHOLD = 0.25
THIGH_ANGLE_THRESHOLD = 55.0  # 度


def parse_glb(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    magic, _ver, _length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF":
        raise ValueError(f"{path} 不是 GLB 文件")
    off, gltf, bin_chunk = 12, None, b""
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        data = raw[off + 8 : off + 8 + clen]
        if ctype == b"JSON":
            gltf = json.loads(data)
        elif ctype == b"BIN\x00":
            bin_chunk = data
        off += 8 + clen
    if gltf is None:
        raise ValueError(f"{path} 缺 JSON chunk")
    return gltf, bin_chunk


def accessor_y_range(gltf: dict, bin_chunk: bytes, idx: int) -> tuple[float, float]:
    acc = gltf["accessors"][idx]
    # accessor 自带 min/max 时直接用（glTF 导出器普遍会写）
    if acc.get("min") and acc.get("max") and len(acc["min"]) == 3:
        return acc["min"][1], acc["max"][1]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    fmt, size = COMP_FMT[acc["componentType"]]
    stride = bv.get("byteStride") or size * 3
    ys = [
        struct.unpack_from(f"<{fmt}", bin_chunk, base + i * stride + size)[0]
        for i in range(acc["count"])
    ]
    return min(ys), max(ys)


def read_vec4(gltf: dict, bin_chunk: bytes, idx: int) -> list[tuple[float, ...]]:
    acc = gltf["accessors"][idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    fmt, size = COMP_FMT[acc["componentType"]]
    stride = bv.get("byteStride") or size * 4
    return [
        struct.unpack_from(f"<4{fmt}", bin_chunk, base + i * stride)
        for i in range(acc["count"])
    ]


def quat_angle_deg(a: tuple, b: tuple) -> float:
    dot = abs(sum(x * y for x, y in zip(a, b)))
    return math.degrees(2 * math.acos(min(1.0, dot)))


def check(path: Path) -> dict | None:
    gltf, bin_chunk = parse_glb(path)
    nodes = gltf.get("nodes", [])
    if not gltf.get("animations"):
        return None
    hips = [i for i, n in enumerate(nodes) if "hips" in (n.get("name") or "").lower()]
    thighs = {
        i: (n.get("name") or "")
        for i, n in enumerate(nodes)
        if any(k in (n.get("name") or "").lower() for k in ("upleg", "upperleg", "thigh"))
    }
    out: dict | None = None
    drop = 0.0
    max_thigh = 0.0
    for anim in gltf["animations"]:
        for ch in anim.get("channels", []):
            tgt = ch.get("target", {})
            node_i, tpath = tgt.get("node"), tgt.get("path")
            sampler = anim["samplers"][ch["sampler"]]
            if hips and node_i == hips[0] and tpath == "translation":
                rest_y = (nodes[hips[0]].get("translation") or [0, 1, 0])[1] or 1.0
                y_min, _y_max = accessor_y_range(gltf, bin_chunk, sampler["output"])
                drop = max(drop, (rest_y - y_min) / abs(rest_y) if rest_y else 0.0)
            elif node_i in thighs and tpath == "rotation":
                rest_q = tuple(nodes[node_i].get("rotation") or (0, 0, 0, 1))
                quats = read_vec4(gltf, bin_chunk, sampler["output"])
                ang = max(quat_angle_deg(q, rest_q) for q in quats)
                max_thigh = max(max_thigh, ang)
    if max_thigh > 90 or drop > SQUAT_THRESHOLD:
        risk = "high"
    elif max_thigh > THIGH_ANGLE_THRESHOLD:
        risk = "medium"
    else:
        risk = "low"
    out = {
        "file": path.name,
        "drop_ratio": round(drop, 3),
        "thigh_deg": round(max_thigh, 1),
        "risk": risk,
        "skirt_risk": risk != "low",
    }
    return out


def main(patterns: list[str]):
    root = Path(__file__).resolve().parents[2]
    files: list[Path] = []
    for p in patterns:
        pp = Path(p)
        files += [pp] if pp.is_file() else sorted(root.glob(p))
    if not files:
        print("未匹配到 GLB 文件", file=sys.stderr)
        sys.exit(1)
    for f in files:
        try:
            r = check(f)
        except Exception as e:  # noqa: BLE001
            print(f"{f}: 解析失败 {e}", file=sys.stderr)
            continue
        if r is None:
            print(f"{f.name}: 无动画轨道（跳过）")
            continue
        flag = {"low": "✅ 低风险", "medium": "🟡 中风险", "high": "⚠️ 高风险（裙装明显穿模）"}[r["risk"]]
        print(
            f"{r['file']}: 髋骨下沉 {r['drop_ratio']:.0%}，"
            f"大腿最大摆角 {r['thigh_deg']:.0f}° → {flag}"
        )


if __name__ == "__main__":
    main(sys.argv[1:] or ["storage/models3d/**/anim_*.glb"])
