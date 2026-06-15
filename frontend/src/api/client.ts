/** 后端 API 客户端（开发态经 Vite 代理到后端，目标端口见 vite.config.ts） */

export interface CharacterConfig {
  basic?: {
    name?: string;
    type?: string;
    description?: string;
    language?: string;
    visibility?: string;
  };
  appearance?: {
    gender?: string;
    age_style?: string;
    hair_style?: string;
    clothing_style?: string;
    art_style?: string;
    prompt?: string;
  };
  voice?: { voice_id?: string; speed?: number; pitch?: number };
  persona?: {
    personality_tags?: string[];
    speaking_style?: string[];
    catchphrase?: string;
    background_story?: string;
    relationship?: string;
    forbidden_rules?: string;
    reply_length?: string;
  };
  abilities?: Record<string, boolean>;
  /** V1.2 形象配置：VRM 3D 主线 + Live2D 模板线（三层定制见架构文档 §8.3） */
  avatar?: AvatarConfig;
  /** 旧字段，保留兼容（resolveAvatar 会兜底读取） */
  live2d?: { model_source?: string; template_id?: string };
}

export interface AvatarConfig {
  type?: "vrm_template" | "vrm_traits" | "ai_generated" | "live2d_template";
  template_id?: string;
  /** 模型地址（模板内置 / AI 生成后回填 / 用户上传） */
  vrm_url?: string;
  /** AI 生成的绑骨 GLB（Meshy/Tripo 产物，GLBStage 渲染） */
  glb_url?: string;
  /** Meshy 官方烘焙动画（同骨架带皮 GLB）：idle/dance/react → 地址 */
  anim_urls?: Record<string, string>;
  /** 创建策略（meshy_text3d / meshy_image3d / tripo_image3d / 模板） */
  strategy?: string;
  /** L2 捏脸参数（部件 + 调色），后续迭代生效 */
  traits?: Record<string, unknown>;
  /** 情绪 → 动作名映射（覆盖默认映射） */
  motions?: Record<string, string>;
  portrait_url?: string;
}

export interface Character {
  id: number;
  name: string;
  status: "draft" | "published" | "banned";
  config: CharacterConfig;
  latest_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface Memory {
  id: number;
  type: string;
  content: string;
  tags: string[];
  importance: number;
  similarity?: number;
  created_at?: string;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export const api = {
  health: () => http<any>("/healthz"),

  // 角色
  listCharacters: () => http<{ characters: Character[] }>("/api/v1/characters"),
  getCharacter: (id: number) => http<Character>(`/api/v1/characters/${id}`),
  createCharacter: (name: string, config: CharacterConfig) =>
    http<Character>("/api/v1/characters", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    }),
  updateCharacter: (id: number, data: { name?: string; config?: CharacterConfig }) =>
    http<Character>(`/api/v1/characters/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteCharacter: (id: number) =>
    http<{ deleted: number }>(`/api/v1/characters/${id}`, { method: "DELETE" }),
  publishCharacter: (id: number) =>
    http<{ version: number }>(`/api/v1/characters/${id}/publish`, { method: "POST" }),
  agentDraft: (description: string) =>
    http<{ name: string; config: CharacterConfig }>("/api/v1/characters/agent-draft", {
      method: "POST",
      body: JSON.stringify({ description }),
    }),

  // 记忆
  listMemories: (userId = 1, characterId = 1) =>
    http<{ memories: Memory[] }>(`/api/v1/memories?user_id=${userId}&character_id=${characterId}`),
  searchMemories: (q: string, userId = 1, characterId = 1, topK = 5) =>
    http<{ results: Memory[] }>(
      `/api/v1/memories/search?q=${encodeURIComponent(q)}&user_id=${userId}&character_id=${characterId}&top_k=${topK}`
    ),
  addMemory: (data: { content: string; memory_type: string; user_id: number; character_id: number }) =>
    http<{ id: number }>("/api/v1/memories", { method: "POST", body: JSON.stringify(data) }),
  deleteMemory: (id: number) => http<{ deleted: number }>(`/api/v1/memories/${id}`, { method: "DELETE" }),
  reindexMemories: () => http<any>("/api/v1/memories/reindex", { method: "POST" }),

  // Embedding 提供方
  embeddingProvider: () => http<any>("/api/v1/embeddings/provider"),
  switchEmbedding: (kind: string, model?: string) =>
    http<any>("/api/v1/embeddings/provider", {
      method: "PUT",
      body: JSON.stringify({ kind, model }),
    }),

  // 生成式资产（AI 背景 / 立绘 / 图生3D 形象）
  assetProviders: () =>
    http<{ image_models: string[]; mesh3d: { meshy: boolean; tripo: boolean; available: boolean } }>(
      "/api/v1/assets/providers"
    ),
  genBackground: (prompt: string, characterId?: number) =>
    http<{ url: string; model: string }>("/api/v1/assets/background", {
      method: "POST",
      body: JSON.stringify({ prompt, character_id: characterId }),
    }),
  genPortrait: (prompt: string, characterId?: number) =>
    http<{ url: string; model: string }>("/api/v1/assets/portrait", {
      method: "POST",
      body: JSON.stringify({ prompt, character_id: characterId }),
    }),
  startAvatar3D: (data: {
    prompt?: string;
    image_b64?: string;
    character_id?: number;
    /** 创建策略：auto | meshy_text3d | meshy_image3d | tripo_image3d */
    strategy?: string;
    /** 三视图精准建模（仅 Meshy）：官方多视图出图 → 多视图联合建模 */
    multiview?: boolean;
    /** 性格标签：从白名单动作池差异化分配舞蹈/反应（每个角色舞不同） */
    style_tags?: string[];
  }) =>
    http<{ task_id: string }>("/api/v1/assets/avatar3d", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  avatar3DStatus: (taskId: string) =>
    http<{
      status: string;
      stage: string;
      strategy?: string;
      multiview?: boolean;
      urls: {
        portrait?: string;
        glb?: string;
        anims?: Record<string, string>;
        views?: string[];
      };
      error?: string;
    }>(`/api/v1/assets/avatar3d/${taskId}`),
  /** 查某角色进行中/最近的生成任务（中途退出后续接进度）；无返回 {} */
  avatar3DActive: (characterId: number) =>
    http<{ task_id?: string; status?: string; stage?: string; strategy?: string; urls?: Record<string, any> }>(
      `/api/v1/assets/avatar3d/active?character_id=${characterId}`
    ),
  listAssets: (kind: "background" | "portrait" | "model3d") =>
    http<{ items: { url: string; name: string }[] }>(`/api/v1/assets/list/${kind}`),
};
