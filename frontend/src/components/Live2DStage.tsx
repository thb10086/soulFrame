/**
 * Live2D 舞台：渲染模板模型；speaking=true 时用正弦驱动口型（TTS 接入后改为音频 RMS 驱动）
 * 鼠标交互：视线跟随光标（focus），点击触发 Tap 动作组并播放反馈粒子
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

declare global {
  interface Window {
    PIXI: any;
  }
}

/** 模型资产已本地化到项目内（frontend/public/models/），不再依赖外部 CDN */
const MODEL_URL = "/models/live2d/haru/haru_greeter_t03.model3.json";
const MOUTH_PARAM = "ParamMouthOpenY";

export interface Live2DHandle {
  /** 文本模式：正弦模拟口型 */
  setSpeaking: (on: boolean) => void;
  /** 语音模式：音频 RMS 直驱口型（0~1） */
  setMouth: (v: number) => void;
  /** 触发动作组（Idle / TapBody…），不传则随机 */
  motion: (group?: string) => void;
}

const Live2DStage = forwardRef<Live2DHandle, { height?: number | string; interactive?: boolean }>(({ height = 480, interactive = true }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const speakingRef = useRef(false);
  const mouthRef = useRef(0); // RMS 直驱目标值（带衰减）
  const [status, setStatus] = useState("模型加载中…");

  const burst = (x: number, y: number) => {
    const layer = fxRef.current;
    if (!layer) return;
    const glyphs = ["💗", "✨", "⭐"];
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("span");
      s.className = "vrm-fx-burst";
      s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const dist = 40 + Math.random() * 56;
      s.style.left = `${x}px`;
      s.style.top = `${y}px`;
      s.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
      s.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
      s.style.fontSize = `${12 + Math.random() * 10}px`;
      s.addEventListener("animationend", () => s.remove());
      layer.appendChild(s);
    }
  };

  useImperativeHandle(ref, () => ({
    setSpeaking: (on: boolean) => {
      speakingRef.current = on;
    },
    setMouth: (v: number) => {
      mouthRef.current = Math.max(mouthRef.current, Math.min(1, v));
    },
    motion: (group?: string) => {
      const model = modelRef.current;
      if (!model) return;
      try {
        const groups = Object.keys(model.internalModel?.motionManager?.definitions ?? {});
        const pick = group && groups.includes(group)
          ? group
          : groups.filter((g) => g.toLowerCase() !== "idle")[0] ?? groups[0];
        if (pick) model.motion(pick);
      } catch {}
    },
  }));

  useEffect(() => {
    let destroyed = false;
    let cleanupInteract: (() => void) | null = null;
    const PIXI = window.PIXI;
    if (!PIXI?.live2d) {
      setStatus("Live2D 运行时未加载（检查网络/CDN）");
      return;
    }
    const wrap = wrapRef.current!;
    const sizeOf = () => ({ w: wrap.clientWidth || 1, h: wrap.clientHeight || 1 });
    const app = new PIXI.Application({
      view: canvasRef.current!,
      backgroundAlpha: 0,
      autoStart: true,
      width: sizeOf().w,
      height: sizeOf().h,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    appRef.current = app;

    // 布局：尺寸变化时重排模型（全屏通话切换不重载模型）
    const layout = () => {
      const model = modelRef.current;
      const { w, h } = sizeOf();
      app.renderer.resize(w, h);
      if (!model) return;
      const naturalH = model.height / model.scale.y;
      const scale = (h / naturalH) * 1.55;
      model.scale.set(scale);
      model.position.set(w / 2, h * 0.06);
    };
    const ro = new ResizeObserver(layout);
    ro.observe(wrap);

    PIXI.live2d.Live2DModel.from(MODEL_URL, { autoInteract: false })
      .then((model: any) => {
        if (destroyed) return;
        modelRef.current = model;
        model.anchor.set(0.5, 0.12);
        app.stage.addChild(model);
        layout();
        setStatus("");

        // —— 鼠标交互：视线跟随 + 点击反应 ——
        if (interactive) {
          const cv = canvasRef.current!;
          const onMove = (e: PointerEvent) => {
            const r = cv.getBoundingClientRect();
            try {
              model.focus(e.clientX - r.left, e.clientY - r.top);
            } catch {}
          };
          const onLeave = () => {
            try {
              model.focus(cv.clientWidth / 2, cv.clientHeight * 0.3);
            } catch {}
          };
          const onClick = (e: PointerEvent) => {
            const r = cv.getBoundingClientRect();
            burst(e.clientX - r.left, e.clientY - r.top);
            try {
              const groups = Object.keys(model.internalModel?.motionManager?.definitions ?? {});
              const taps = groups.filter((g) => g.toLowerCase().includes("tap"));
              const pick = taps[Math.floor(Math.random() * taps.length)]
                ?? groups.filter((g) => g.toLowerCase() !== "idle")[0];
              if (pick) model.motion(pick);
            } catch {}
          };
          cv.addEventListener("pointermove", onMove);
          cv.addEventListener("pointerleave", onLeave);
          cv.addEventListener("pointerup", onClick);
          cleanupInteract = () => {
            cv.removeEventListener("pointermove", onMove);
            cv.removeEventListener("pointerleave", onLeave);
            cv.removeEventListener("pointerup", onClick);
          };
        }

        let t = 0;
        app.ticker.add((dt: number) => {
          t += dt / 60;
          const sine = speakingRef.current
            ? 0.18 + 0.5 * Math.abs(Math.sin(t * 11)) + 0.15 * Math.abs(Math.sin(t * 23))
            : 0;
          const v = Math.max(sine, mouthRef.current);
          mouthRef.current *= 0.82; // 音频驱动值自然衰减，避免迟滞张嘴
          try {
            model.internalModel.coreModel.setParameterValueById(MOUTH_PARAM, Math.min(1, v));
          } catch {}
        });
      })
      .catch((e: any) => setStatus(`模型加载失败：${e?.message ?? e}`));

    return () => {
      destroyed = true;
      cleanupInteract?.();
      ro.disconnect();
      try {
        appRef.current?.destroy(false, { children: true });
      } catch {}
    };
  }, [interactive]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height, transition: "height .3s" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div ref={fxRef} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }} />
      {status && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#8a93c4",
            fontSize: 13,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
});

export default Live2DStage;
