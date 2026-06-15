-- SoulFrame 数据模型（架构文档 V1.1 §7）
-- {EMBEDDING_DIM} 由应用按当前 embedding 提供方维度替换后执行

CREATE EXTENSION IF NOT EXISTS vector;

-- 角色（草稿可编辑）
CREATE TABLE IF NOT EXISTS character (
    id            BIGSERIAL PRIMARY KEY,
    owner_id      BIGINT NOT NULL,
    tenant_id     BIGINT NOT NULL DEFAULT 0,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',   -- draft/published/banned
    draft_config  JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 发布快照（不可变，会话绑定 release 而非草稿）
CREATE TABLE IF NOT EXISTS character_release (
    id              BIGSERIAL PRIMARY KEY,
    character_id    BIGINT NOT NULL REFERENCES character(id),
    version         INT NOT NULL,
    config          JSONB NOT NULL,
    live2d_asset_id BIGINT,
    status          TEXT NOT NULL DEFAULT 'active',
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (character_id, version)
);

-- 会话
CREATE TABLE IF NOT EXISTS session (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    character_id    BIGINT NOT NULL,
    release_id      BIGINT,
    mode            TEXT NOT NULL DEFAULT 'text',  -- text/voice
    context_summary TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ
);

-- 消息（V1.1 新增：分段延迟埋点随消息落库）
CREATE TABLE IF NOT EXISTS message (
    id            BIGSERIAL PRIMARY KEY,
    session_id    BIGINT NOT NULL REFERENCES session(id),
    role          TEXT NOT NULL,                   -- user/assistant/system
    content       TEXT NOT NULL,
    emotion_label TEXT,
    input_mode    TEXT,                            -- text/voice
    asr_final     TEXT,
    tool_calls    JSONB,
    latency_ms    JSONB,                           -- {vad,asr,llm_ttft,first_sentence,tts_first,e2e}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 记忆（带向量；用户可见可删）
CREATE TABLE IF NOT EXISTS memory (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL,
    character_id      BIGINT NOT NULL,
    memory_type       TEXT NOT NULL DEFAULT 'fact',  -- preference/fact/relation/event
    content           TEXT NOT NULL,
    tags              TEXT[] DEFAULT '{}',
    importance_score  REAL DEFAULT 0.5,
    embedding         vector({EMBEDDING_DIM}),
    source_session_id BIGINT,
    user_visible      BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_user_char ON memory(user_id, character_id);

-- embedding 元信息（记录入库向量由哪个提供方/模型/维度产生）
CREATE TABLE IF NOT EXISTS embedding_meta (
    id         INT PRIMARY KEY DEFAULT 1,
    kind       TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- 生成式资产任务（V1.2 §7：AI 背景/立绘/图生3D 的产物与状态）
CREATE TABLE IF NOT EXISTS avatar_asset (
    id           BIGSERIAL PRIMARY KEY,
    character_id BIGINT,
    kind         TEXT NOT NULL,                  -- background/portrait/model3d
    prompt       TEXT,
    provider     TEXT,                           -- gateway:<model> / meshy / tripo
    status       TEXT NOT NULL DEFAULT 'done',   -- queued/modeling/rigging/done/failed
    urls         JSONB NOT NULL DEFAULT '{}',    -- {image,portrait,glb}
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avatar_asset_char ON avatar_asset(character_id, created_at);

-- AgentMem 租户绑定（每个角色 = 一个 AgentMem Agent；Key 仅服务端持有，绝不下发前端）
CREATE TABLE IF NOT EXISTS agentmem_binding (
    character_id BIGINT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    api_key      TEXT NOT NULL,
    project_id   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用量记账（额度熔断依据）
CREATE TABLE IF NOT EXISTS usage_log (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL DEFAULT 0,
    user_id       BIGINT,
    character_id  BIGINT,
    model         TEXT NOT NULL,
    kind          TEXT NOT NULL,                   -- llm/tts/asr/image/realtime/embedding
    tokens_in     INT DEFAULT 0,
    tokens_out    INT DEFAULT 0,
    audio_seconds REAL DEFAULT 0,
    chars         INT DEFAULT 0,
    cost_est      NUMERIC(12, 6) DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_log(tenant_id, created_at);
