/**
 * Avatar 统一舞台（V1.2）：按角色配置切换 VRM 3D / Live2D 渲染，向上暴露一致的驱动句柄。
 * 聊天页/语音链路只面向 AvatarHandle，渲染实现可替换。
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import type { CharacterConfig } from "../api/client";
import { resolveAvatar } from "../avatars";
import GLBStage from "./GLBStage";
import Live2DStage, { Live2DHandle } from "./Live2DStage";
import VRMStage from "./VRMStage";

export interface AvatarHandle {
  /** 文本模式：正弦模拟口型 */
  setSpeaking: (on: boolean) => void;
  /** 语音模式：音频 RMS 直驱口型（0~1） */
  setMouth: (v: number) => void;
  /** 触发动作：传情绪名（happy/sad/think/surprise/talk）或动作组名，不传则随机 */
  motion: (hint?: string) => void;
  /** 舞蹈开关（VRM 支持；Live2D 退化为循环动作） */
  dance?: (on: boolean) => void;
}

const AvatarStage = forwardRef<AvatarHandle, { config?: CharacterConfig | null; height?: number | string; interactive?: boolean }>(
  ({ config, height = 480, interactive = true }, ref) => {
    const resolved = resolveAvatar(config);
    const vrmRef = useRef<AvatarHandle>(null);
    const glbRef = useRef<AvatarHandle>(null);
    const l2dRef = useRef<Live2DHandle>(null);
    const danceTimer = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      setSpeaking: (on) => (vrmRef.current ?? glbRef.current ?? l2dRef.current)?.setSpeaking(on),
      setMouth: (v) => (vrmRef.current ?? glbRef.current ?? l2dRef.current)?.setMouth(v),
      motion: (hint) => (vrmRef.current ?? glbRef.current ?? l2dRef.current)?.motion(hint),
      dance: (on) => {
        const h = vrmRef.current ?? glbRef.current;
        if (h?.dance) {
          h.dance(on);
          return;
        }
        // Live2D 兜底：循环触发动作组模拟"舞蹈"
        if (danceTimer.current) {
          window.clearInterval(danceTimer.current);
          danceTimer.current = null;
        }
        if (on) {
          l2dRef.current?.motion();
          danceTimer.current = window.setInterval(() => l2dRef.current?.motion(), 2600);
        }
      },
    }), [resolved.kind]);

    return resolved.kind === "vrm" ? (
      <VRMStage ref={vrmRef} url={resolved.url!} height={height} interactive={interactive} />
    ) : resolved.kind === "glb" ? (
      <GLBStage
        ref={glbRef}
        url={resolved.url!}
        animUrls={resolved.animUrls}
        height={height}
        interactive={interactive}
      />
    ) : (
      <Live2DStage ref={l2dRef} height={height} interactive={interactive} />
    );
  }
);

export default AvatarStage;
