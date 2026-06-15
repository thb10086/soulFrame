"""SoulFrame 后端入口（模块化单体，架构文档 V1.1）。

启动: backend/.venv/bin/uvicorn app.main:app --port 8000 --app-dir backend
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .ai.embeddings import EmbeddingManager
from .ai.gateway import AgentLLMClient
from .ai.memory_provider import build_memory_provider
from .api import assets_api, characters_api, embeddings_api, health_api, memories_api, realtime_api
from .config import settings
from .db.database import Database
from .services.assets import AssetService
from .services.memory import MemoryService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = settings
    app.state.gateway = AgentLLMClient(settings.agentllm_base_url, settings.agentllm_api_key)
    app.state.embeddings = EmbeddingManager(
        gateway_client=app.state.gateway,
        local_model=settings.local_embedding_model,
        local_device=settings.local_embedding_device,
        gateway_model=settings.gateway_embedding_model,
        default_kind=settings.embedding_provider,
    )
    app.state.db = Database(settings.database_url)

    # 预热当前 embedding 提供方并拿到维度（gateway 走线上探活，local 才下载本地模型）
    try:
        dim = await app.state.embeddings.active.dim()
        logger.info("embedding 就绪: %s dim=%s", app.state.embeddings.active.info(), dim)
    except Exception as e:  # noqa: BLE001
        dim = 1024
        logger.warning("embedding 预热失败（接口仍可用，首次调用重试）: %s", e)

    await app.state.db.connect(embedding_dim=dim)
    app.state.memory_service = MemoryService(app.state.db, app.state.embeddings)
    # 统一记忆对接位（AgentMem）：未配置时为 Null no-op，平台不处理记忆。
    # 启用时按角色自动开通租户（控制面），key 落 agentmem_binding 表（仅服务端持有）。
    app.state.memory_provider = build_memory_provider(
        settings.agentmem_base_url,
        app.state.db,
        console_token=settings.agentmem_console_token,
        project_id=settings.agentmem_project_id,
        single_api_key=settings.agentmem_api_key,
        top_k=settings.agentmem_top_k,
        min_similarity=settings.agentmem_min_similarity,
        query_timeout=settings.agentmem_query_timeout_s,
        add_timeout=settings.agentmem_add_timeout_s,
    )
    app.state.assets = AssetService(
        gateway=app.state.gateway,
        db=app.state.db,
        storage_dir=settings.storage_dir,
        image_models=settings.image_models,
        image_timeout=settings.image_timeout_s,
        meshy_key=settings.meshy_api_key,
        meshy_key_backup=settings.meshy_api_key_backup,
        tripo_key=settings.tripo_api_key,
        proxy=settings.outbound_proxy,
        tripo_model_version=settings.tripo_model_version,
    )

    yield

    await app.state.memory_provider.aclose()
    await app.state.db.close()
    await app.state.gateway.aclose()


app = FastAPI(title="SoulFrame Backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_api.router)
app.include_router(embeddings_api.router)
app.include_router(memories_api.router)
app.include_router(characters_api.router)
app.include_router(realtime_api.router)
app.include_router(assets_api.router)

# 生成资产静态服务（背景/立绘/3D 模型）
_storage = Path(settings.storage_dir)
_storage.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(_storage)), name="files")
