/**
 * 动作评审页（开发工具，审美策展用）：/dev/anim-review?model=...&anim=...&kind=dance
 *
 * 把候选动作 GLB 套在指定绑骨模型上循环播放，供逐支目检"自然度/穿模/气质"。
 * kind=dance 自动开跳舞；kind=react 每 3.5s 触发一次 one-shot；idle 默认循环。
 * 配合 backend/scripts/bake_action_pool.py（产物在 /files/models3d/_review/）使用。
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { AvatarHandle } from "../components/AvatarStage";
import GLBStage from "../components/GLBStage";

export default function AnimReviewPage() {
  const [params] = useSearchParams();
  const model = params.get("model") ?? "";
  const anim = params.get("anim") ?? "";
  const kind = (params.get("kind") ?? "dance") as "idle" | "dance" | "react";
  const ref = useRef<AvatarHandle>(null);

  useEffect(() => {
    if (!anim) return;
    const timers: number[] = [];
    if (kind === "dance") {
      timers.push(window.setTimeout(() => ref.current?.dance?.(true), 1200));
    } else if (kind === "react") {
      timers.push(window.setInterval(() => ref.current?.motion?.(), 3500));
      timers.push(window.setTimeout(() => ref.current?.motion?.(), 1200));
    }
    return () => timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)));
  }, [anim, kind]);

  if (!model) return <div style={{ padding: 24 }}>缺 model 参数</div>;
  return (
    <div style={{ height: "100vh", background: "#0c0e1d", position: "relative" }}>
      <div
        style={{
          position: "absolute", top: 10, left: 12, zIndex: 5, color: "#9ab",
          fontSize: 13, fontFamily: "monospace",
        }}
      >
        [{kind}] {anim.split("/").pop() || "(模型内嵌动作)"}
      </div>
      <GLBStage
        ref={ref}
        url={model}
        height="100vh"
        animUrls={anim ? { [kind]: anim } : undefined}
      />
    </div>
  );
}
