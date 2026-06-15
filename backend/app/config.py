"""全局配置：读取项目根目录 .env（密钥只存在于环境，不入库不进前端）。"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT / ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    # AgentLLM Gateway（统一AI聚合平台）
    agentllm_base_url: str = "https://agentllm.linkyun.co"
    agentllm_api_key: str = ""

    # LLM（依据前置预检实测：语音/对话首选 M2-her，降级链见架构文档 §3.1）
    chat_model: str = "M2-her"
    chat_fallback_models: list[str] = ["MiniMax-M2.7-highspeed", "deepseek-v4-flash"]
    chat_timeout_s: float = 30.0

    # 端到端实时语音（电话式通话：内置 server VAD，自带打断）
    realtime_model: str = "qwen3-omni-flash-realtime"
    realtime_voice_default: str = "Cherry"
    # server VAD 平衡旋钮：阈值越高越不易被环境音/回声触发；静音时长越长断句越稳（但响应略慢）
    realtime_vad_threshold: float = 0.6
    realtime_vad_silence_ms: int = 700

    # Agent 建角色用的结构化输出模型（优先非思考型，速度快且 JSON 守约好）
    # 注：qwen3.6-flash 网关已下线(404)，移除以免每次建角白跑一次降级
    agent_draft_models: list[str] = ["deepseek-v4-flash", "MiniMax-M2.7-highspeed", "M2-her"]

    # 图像生成（背景/立绘）：gpt-image-2 渠道开通后自动优先，当前实测降级 linkyun-image-default
    image_models: list[str] = ["gpt-image-2", "linkyun-image-default"]
    image_timeout_s: float = 120.0

    # AI 生成 3D（形象工厂）：Meshy 主链（文生/图生+绑骨+官方动画，06-12 实测）；Tripo 备
    meshy_api_key: str = ""
    meshy_api_key_backup: str = ""  # 备用 Key，主 Key 402 时手动换上
    tripo_api_key: str = ""
    tripo_model_version: str = "v3.0-20250812"
    # 本机直连 api.tripo3d.ai 超时，Tripo 及其产物下载走此代理（Meshy/网关直连不走）
    outbound_proxy: str = ""

    # AgentMem 统一记忆（Memory-as-a-Service）：填 base_url 即启用。
    # 模型：每个角色 = 一个 AgentMem Agent 租户（按 (角色, user_id) 二维隔离），
    # 平台后端用控制面 API 自动开通并把 agent_id/api_key 落库（仅服务端持有）。
    agentmem_base_url: str = ""
    agentmem_console_token: str = ""   # 控制面令牌；本地开发留空，生产按部署填
    agentmem_project_id: str = ""      # 留空则首个角色接入时自动建项目（日志打印，建议回填 .env 固定）
    agentmem_api_key: str = ""         # 兼容旧单 Agent 直配（可选；优先走按角色自动开通）
    # 检索在对话关键路径上：短超时即降级（空上下文继续），不拖慢首字
    agentmem_top_k: int = 6
    agentmem_min_similarity: float = 0.16
    # 检索在首字关键路径上：安静时 ~0.07s，紧跟一次 add 的后台抽取会争用到 ~1.5s。
    # 卡 2s 上限，超时即本轮空上下文继续（记忆仍照写），避免拖慢气泡首字。
    agentmem_query_timeout_s: float = 2.0
    agentmem_add_timeout_s: float = 3.0

    # 生成资产存储目录（背景/立绘/3D 模型），通过 /files 静态服务暴露
    storage_dir: str = str(ROOT / "storage")

    # Embedding：gateway（AgentLLM /v1/embeddings）| local（本地 sentence-transformers 兜底）
    # 运行中可通过 PUT /api/v1/embeddings/provider 热切换
    embedding_provider: str = "gateway"
    local_embedding_model: str = "BAAI/bge-small-zh-v1.5"  # 仅 kind=local 时使用
    local_embedding_device: str = "cpu"  # cpu | mps | cuda
    gateway_embedding_model: str = "text-embedding-3-large"  # AgentLLM 线上向量模型

    # 数据层（docker compose up -d 启动；未启动时应用进入降级模式）
    database_url: str = "postgresql://soulframe:soulframe@localhost:5433/soulframe"
    redis_url: str = "redis://localhost:6379/0"

    # 服务（本机 8000/8080 已被其他程序占用，后端默认 8787；可用 .env 的 API_PORT 覆盖）
    api_host: str = "0.0.0.0"
    api_port: int = 8787
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:8787",
    ]


settings = Settings()
