/**
 * Avatar 模板清单与解析（架构文档 V1.2 §8.3 三层定制体系的 L1 层）
 * - vrm  : three.js + @pixiv/three-vrm 渲染，支持表情/口型/程序化动作/舞蹈
 * - live2d : PixiJS + pixi-live2d-display 渲染（2D 模板线）
 */
import type { AvatarConfig, CharacterConfig } from "./api/client";

export interface AvatarTemplate {
  id: string;
  kind: "vrm" | "live2d";
  name: string;
  desc: string;
  /** vrm 模板的模型地址（public/models 下或远程 URL） */
  url?: string;
  tags: string[];
}

/** 模型文件一律放在本项目 frontend/public/models/ 下，不依赖外部 CDN */
export const AVATAR_TEMPLATES: AvatarTemplate[] = [
  {
    id: "vrm_avatar_a",
    kind: "vrm",
    name: "Sakura（3D · VRoid 官方）",
    desc: "VRoid Studio 官方示例模型 A · 精致美型 · 表情/口型/舞蹈全支持",
    url: "/models/AvatarSample_A.vrm",
    tags: ["3D", "推荐", "高质量", "舞蹈"],
  },
  {
    id: "vrm_avatar_b",
    kind: "vrm",
    name: "Aoi（3D · VRoid 官方）",
    desc: "VRoid Studio 官方示例模型 B · 高质量造型与服装",
    url: "/models/AvatarSample_B.vrm",
    tags: ["3D", "高质量", "动作"],
  },
  {
    id: "vrm_sample",
    kind: "vrm",
    name: "Alicia（3D · VRM）",
    desc: "经典美型二次元模型 · 表情/口型齐全 · 动作舞蹈可设定",
    url: "/models/AliciaSolid_vrm-0.51.vrm",
    tags: ["3D", "动作", "舞蹈"],
  },
  {
    id: "vrm_seed",
    kind: "vrm",
    name: "Seed-san（3D · VRM）",
    desc: "VRM 官方吉祥物 · 18 种表情预设",
    url: "/models/Seed-san.vrm",
    tags: ["3D", "表情", "动作"],
  },
  {
    id: "haru",
    kind: "live2d",
    name: "Haru（2D · Live2D）",
    desc: "经典 2D 模板 · 含口型参数与动作组",
    tags: ["2D", "口型"],
  },
];

export interface ResolvedAvatar {
  kind: "vrm" | "live2d" | "glb";
  url?: string;
  /** Meshy 官方烘焙动画（同骨架 GLB），GLBStage 零重定向直接播放 */
  animUrls?: Record<string, string>;
  template?: AvatarTemplate;
}

/** 从角色配置解析渲染目标；兼容旧 live2d 字段；默认 VRM 主线模板 */
export function resolveAvatar(config?: CharacterConfig | null): ResolvedAvatar {
  const av: AvatarConfig | undefined = config?.avatar;
  if (av) {
    // AI 生成形象：绑骨 GLB（Meshy/Tripo 产物）走 GLB 舞台
    if (av.type === "ai_generated" && av.glb_url) {
      return { kind: "glb", url: av.glb_url, animUrls: av.anim_urls };
    }
    const tpl = AVATAR_TEMPLATES.find((t) => t.id === av.template_id);
    if (av.type === "live2d_template" || tpl?.kind === "live2d") {
      return { kind: "live2d", template: tpl };
    }
    // vrm_template / vrm_traits：落到 VRM 渲染
    const url = av.vrm_url || tpl?.url || AVATAR_TEMPLATES[0].url;
    return { kind: "vrm", url, template: tpl ?? AVATAR_TEMPLATES[0] };
  }
  if (config?.live2d?.template_id) {
    return { kind: "live2d", template: AVATAR_TEMPLATES.find((t) => t.id === config.live2d!.template_id) };
  }
  return { kind: "vrm", url: AVATAR_TEMPLATES[0].url, template: AVATAR_TEMPLATES[0] };
}
