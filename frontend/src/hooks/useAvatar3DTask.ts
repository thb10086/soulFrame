/**
 * AI 形象生成任务 hook（解耦）：启动 Meshy/Tripo 生成 + 轮询状态 + 暴露产物。
 * 把"任务编排/轮询"从 UI 组件剥离，AvatarStudio 只消费状态，逻辑单一职责。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

export type Avatar3DStatus =
  | "idle"
  | "queued"
  | "portrait"
  | "multiview"
  | "modeling"
  | "texturing"
  | "rigging"
  | "animating"
  | "downloading"
  | "done"
  | "failed";

export interface Avatar3DTask {
  task_id?: string;
  status: Avatar3DStatus;
  stage: string;
  strategy?: string;
  multiview?: boolean;
  urls?: {
    portrait?: string;
    glb?: string;
    anims?: Record<string, string>;
    views?: string[];
  };
  error?: string;
}

export interface StartAvatar3DParams {
  prompt?: string;
  image_b64?: string;
  character_id?: number;
  strategy: "meshy_text3d" | "meshy_image3d" | "tripo_image3d";
  multiview?: boolean;
  style_tags?: string[];
}

const POLL_MS = 3000;
const ACTIVE = (s: Avatar3DStatus) => s !== "idle" && s !== "done" && s !== "failed";

export function useAvatar3DTask() {
  const [task, setTask] = useState<Avatar3DTask>({ status: "idle", stage: "" });
  const timer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setTask({ status: "idle", stage: "" });
  }, [stopPolling]);

  // 续接：用已有 task_id 恢复（中途退出/刷新/切步后重进），轮询自动拉真实状态
  const resume = useCallback((task_id: string, seed?: Partial<Avatar3DTask>) => {
    setTask({ task_id, status: "queued", stage: "恢复进度…", ...seed });
  }, []);

  const start = useCallback(
    async (params: StartAvatar3DParams) => {
      stopPolling();
      setTask({ status: "queued", stage: "排队中", strategy: params.strategy });
      try {
        const { task_id } = await api.startAvatar3D(params);
        setTask({ task_id, status: "queued", stage: "排队中", strategy: params.strategy });
      } catch (e: any) {
        const raw = e.message || "3D 任务启动失败";
        const error =
          raw === "Load failed" || raw === "Failed to fetch"
            ? "无法连接后端，请确认服务已启动（端口 8787）"
            : raw;
        setTask({ status: "failed", stage: "启动失败", error });
      }
    },
    [stopPolling]
  );

  // 轮询：仅在有进行中的 task_id 时拉状态，done/failed 自动停
  useEffect(() => {
    const tid = task.task_id;
    if (!tid || !ACTIVE(task.status)) {
      stopPolling();
      return;
    }
    let misses = 0;
    timer.current = window.setInterval(async () => {
      try {
        const s = await api.avatar3DStatus(tid);
        misses = 0;
        setTask({ task_id: tid, ...(s as Omit<Avatar3DTask, "task_id">) });
      } catch (e: any) {
        const msg: string = e?.message || "";
        // 后端重启会清空内存任务 → 轮询拿 404，进度会永远停在最后阶段（假死）。
        // 明确失败让用户重试，而不是干瞪着不动的进度条。
        if (msg.includes("任务不存在") || msg.includes("404")) {
          setTask({ task_id: tid, status: "failed", stage: "任务已失效", error: "生成服务已重启，进度丢失，请重新生成" });
          return;
        }
        // 连续多次连不上才判失败，容忍偶发抖动
        if (++misses >= 5) {
          setTask({ task_id: tid, status: "failed", stage: "连接中断", error: "无法连接后端，请确认服务运行后重试" });
        }
      }
    }, POLL_MS);
    return stopPolling;
  }, [task.task_id, task.status, stopPolling]);

  return { task, start, reset, resume, busy: ACTIVE(task.status) };
}

/** 阶段 → 进度百分比；并解析 stage 文案里的 "NN%" / "i/N" 让长阶段平滑前进（避免假死观感）。 */
const STAGE_BASE: Record<Avatar3DStatus, number> = {
  idle: 0, queued: 5, portrait: 12, multiview: 25, modeling: 45,
  texturing: 60, rigging: 72, animating: 85, downloading: 95, done: 100, failed: 100,
};

export function taskPercent(task: Avatar3DTask): number {
  let pct = STAGE_BASE[task.status] ?? 0;
  const stage = task.stage ?? "";
  // 建模/贴图阶段后端会回传 "… NN%"，在区间内插值（modeling 45→60、texturing 60→72）
  const pm = stage.match(/(\d+)\s*%/);
  if (pm && (task.status === "modeling" || task.status === "texturing")) {
    const span = task.status === "modeling" ? 15 : 12;
    pct = STAGE_BASE[task.status] + (span * Math.min(100, Number(pm[1]))) / 100;
  }
  // 动画阶段文案形如"（dance，2/3）"，按 i/N 在 85→95 推进，dance 不再定死在 85%
  const fm = stage.match(/(\d+)\s*\/\s*(\d+)/);
  if (fm && task.status === "animating") {
    pct = 85 + (10 * Number(fm[1])) / Math.max(1, Number(fm[2]));
  }
  return Math.round(pct);
}
