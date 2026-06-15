"""运行全部前置预检并汇总报告。

用法：
  .venv/bin/python preflight/run_all.py            # 全量
  .venv/bin/python preflight/run_all.py --skip image  # 跳过指定项
"""
import json
import sys
import time

import check_asr
import check_image
import check_llm
import check_net
import check_pipeline
import check_rag
import check_realtime
import check_tts
from common import OUTPUT, load_env, save_report


def main():
    skips = set()
    args = sys.argv[1:]
    if "--skip" in args:
        skips = set(args[args.index("--skip") + 1 :])
    base, key = load_env()
    print(f"网关: {base}")
    # 被跳过的项沿用上次报告结果
    prev = {}
    prev_path = OUTPUT / "report.json"
    if prev_path.exists():
        try:
            prev = json.loads(prev_path.read_text(encoding="utf-8")).get("results", {})
        except Exception:  # noqa: BLE001
            prev = {}
    report = {"base_url": base, "ran_at": time.strftime("%Y-%m-%d %H:%M:%S"), "results": dict(prev)}

    steps = [
        ("net", "网络基线（本机→网关 RTT）", lambda: check_net.run(base, key)),
        ("llm", "LLM 流式对话（多模型 TTFT）", lambda: check_llm.run(base, key)),
        ("tts", "TTS 流式合成（豆包 / MiniMax）", lambda: check_tts.run(base, key)),
        ("asr", "实时 ASR 回环（TTS音频→文字）", lambda: check_asr.run(base, key)),
        ("pipeline", "三段式语音管线延迟模拟", None),  # 依赖 asr 结果，特殊处理
        ("realtime", "端到端实时语音对话（Qwen-Omni）", lambda: check_realtime.run(base, key)),
        ("rag", "RAG 前置（Embedding / Rerank）", lambda: check_rag.run(base, key)),
        ("image", "文生图（角色立绘）", lambda: check_image.run(base, key)),
    ]

    for name, title, fn in steps:
        if name in skips:
            print(f"\n== 跳过: {title}")
            continue
        print(f"\n== {title}")
        try:
            if name == "pipeline":
                asr_tail = (report["results"].get("asr") or {}).get("tail_latency_ms")
                result = check_pipeline.run(base, key, asr_tail_ms=asr_tail)
            else:
                result = fn()
        except Exception as e:  # noqa: BLE001
            result = {"check": name, "ok": False, "error": f"{type(e).__name__}: {e}"}
            print(f"  [FAIL] {e}")
        report["results"][name] = result

    path = save_report("report", report)
    print(f"\n报告已写入: {path}")
    ok = sum(1 for r in report["results"].values() if r.get("ok"))
    total = len(report["results"])
    print(f"通过 {ok}/{total} 项")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
