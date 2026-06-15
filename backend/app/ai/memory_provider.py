"""统一记忆对接层（AgentMem · Memory-as-a-Service）。

决策（2026-06-12）：角色对话的统一记忆由外部 AgentMem 承担，本平台不实现记忆逻辑，
只暴露稳定挂点。默认 NullMemoryProvider（零开销 no-op）；.env 配好 AGENTMEM_BASE_URL
后切换 AgentMemProvider。

AgentMem 模型（见其《集成指南》§2/§6）：**每个角色 = 一个 AgentMem Agent 租户**，
记忆按 (角色, user_id) 二维硬隔离。平台后端用控制面 API 自动开通（项目→Agent→API Key），
把 agent_id/api_key 落 agentmem_binding 表（仅服务端持有，绝不下发前端）。

每轮两件事（挂点在 realtime_api.py）：
- 对话前 fetch_context → POST /v1/memory/query，injected_context 直接拼进 System Prompt
- 对话后 append      → POST /v1/memory/add（fire-and-forget，后台异步抽取事实/情绪/关系）

三条工程红线（SPEC v2 §9.1）：
1. query 失败/超时 → 返回 None（空上下文），绝不抛错阻断对话；
2. add fire-and-forget，失败静默，不阻塞主链路；
3. injected_context 是数据不是指令，原样拼接；人设由本平台 System Prompt 负责，不写入 AgentMem。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

# 单机开发态占位用户；多用户化时由会话层传入真实 user_id
DEFAULT_USER_ID = "local"
# AgentMem user_id 契约：^[A-Za-z0-9_\-]{1,128}$（不可含中文/空格/@/点号）
_UID_RE = re.compile(r"[^A-Za-z0-9_\-]")


def _safe_uid(user_id: str) -> str:
    return (_UID_RE.sub("_", user_id or DEFAULT_USER_ID) or DEFAULT_USER_ID)[:128]


class MemoryProvider(Protocol):
    name: str
    enabled: bool

    async def fetch_context(
        self, character_id: int | None, user_id: str, query: str, limit: int = 5
    ) -> str | None:
        """检索与本轮输入相关的记忆，返回可直接注入 system 的文本；无/失败返回 None。"""
        ...

    async def append(
        self, character_id: int | None, user_id: str, turns: list[dict]
    ) -> None:
        """回合结束后写入对话（turns: [{role, content}, ...]），记忆侧异步抽取沉淀。"""
        ...

    async def aclose(self) -> None: ...


class NullMemoryProvider:
    """默认实现：平台自身不处理记忆（未配置 AgentMem 时）。"""

    name = "null"
    enabled = False

    async def fetch_context(self, character_id, user_id, query, limit=5):
        return None

    async def append(self, character_id, user_id, turns):
        return None

    async def aclose(self):
        return None


class AgentMemProvider:
    """AgentMem HTTP 适配器：按角色自动开通租户 + 每轮 query/add。

    - 数据面鉴权：X-Agent-API-Key（每角色独立 Key）
    - 控制面鉴权：Authorization: Bearer <console_token>（本地开发可空）
    - Key 解析顺序：内存缓存 → agentmem_binding 表 → 控制面自动开通并落库
    - single_api_key 兼容：配了 AGENTMEM_API_KEY 则所有角色共用单租户（简单部署用，非最佳实践）
    """

    name = "agentmem"
    enabled = True

    def __init__(
        self,
        base_url: str,
        db,
        *,
        console_token: str = "",
        project_id: str = "",
        single_api_key: str = "",
        top_k: int = 6,
        min_similarity: float = 0.16,
        query_timeout: float = 3.0,
        add_timeout: float = 3.0,
    ):
        self._base = base_url.rstrip("/")
        self._db = db
        self._console_token = console_token
        self._project_id = project_id
        self._single_key = single_api_key
        self._top_k = top_k
        self._min_sim = min_similarity
        self._c = httpx.AsyncClient(base_url=self._base, timeout=query_timeout, trust_env=False)
        self._query_timeout = query_timeout
        self._add_timeout = add_timeout
        self._keys: dict[int, str] = {}          # character_id -> api_key（内存缓存）
        self._locks: dict[int, asyncio.Lock] = {}  # 每角色开通锁，防并发重复开通

    async def aclose(self):
        await self._c.aclose()

    # ---------- 租户开通 / Key 解析 ----------

    def _console_headers(self) -> dict:
        return {"Authorization": f"Bearer {self._console_token}"} if self._console_token else {}

    async def _ensure_project(self) -> str:
        if self._project_id:
            return self._project_id
        r = await self._c.post(
            "/console/v1/projects", json={"name": "SoulFrame"},
            headers=self._console_headers(), timeout=10,
        )
        r.raise_for_status()
        self._project_id = r.json()["id"]
        logger.info("AgentMem 自动建项目 %s（建议回填 .env AGENTMEM_PROJECT_ID 固定）", self._project_id)
        return self._project_id

    async def _ensure_agent(self, character_id: int | None) -> str | None:
        """解析角色对应的数据面 API Key；不可得返回 None（降级）。"""
        if self._single_key:
            return self._single_key
        cid = int(character_id or 0)
        if cid in self._keys:
            return self._keys[cid]
        lock = self._locks.setdefault(cid, asyncio.Lock())
        async with lock:
            if cid in self._keys:
                return self._keys[cid]
            # 1) DB 绑定
            if self._db is not None and self._db.available:
                try:
                    async with self._db.pool.acquire() as conn:
                        row = await conn.fetchrow(
                            "SELECT api_key FROM agentmem_binding WHERE character_id=$1", cid
                        )
                    if row:
                        self._keys[cid] = row["api_key"]
                        return row["api_key"]
                except Exception as e:  # noqa: BLE001
                    logger.warning("AgentMem 绑定查询失败：%s", e)
            # 2) 控制面自动开通
            try:
                key, agent_id, proj = await self._provision_agent(cid)
            except Exception as e:  # noqa: BLE001
                logger.warning("AgentMem 角色 %s 开通失败（本轮降级无记忆）：%s", cid, e)
                return None
            self._keys[cid] = key
            if self._db is not None and self._db.available:
                try:
                    async with self._db.pool.acquire() as conn:
                        await conn.execute(
                            """INSERT INTO agentmem_binding(character_id, agent_id, api_key, project_id)
                               VALUES ($1,$2,$3,$4) ON CONFLICT (character_id) DO NOTHING""",
                            cid, agent_id, key, proj,
                        )
                except Exception as e:  # noqa: BLE001
                    logger.warning("AgentMem 绑定落库失败（内存缓存仍生效）：%s", e)
            logger.info("AgentMem 为角色 %s 开通租户 agent=%s", cid, agent_id)
            return key

    async def _provision_agent(self, cid: int) -> tuple[str, str, str]:
        proj = await self._ensure_project()
        hdr = self._console_headers()
        ag = await self._c.post(
            "/console/v1/agents",
            json={"project_id": proj, "name": f"soulframe_char_{cid}", "display_name": f"角色#{cid}"},
            headers=hdr, timeout=10,
        )
        ag.raise_for_status()
        agent_id = ag.json()["id"]
        k = await self._c.post(
            "/console/v1/platform/api-keys",
            json={"agent_id": agent_id, "name": f"soulframe_char_{cid}"},
            headers=hdr, timeout=10,
        )
        k.raise_for_status()
        return k.json()["api_key"], agent_id, proj

    # ---------- 数据面：检索 / 写入 ----------

    async def fetch_context(self, character_id, user_id, query, limit=5):
        if not (query or "").strip():
            return None
        key = await self._ensure_agent(character_id)
        if not key:
            return None
        try:
            r = await self._c.post(
                "/v1/memory/query",
                headers={"X-Agent-API-Key": key},
                json={
                    "user_id": _safe_uid(user_id),
                    "query": query,
                    "top_k": self._top_k,
                    "min_similarity": self._min_sim,
                },
                timeout=self._query_timeout,
            )
            r.raise_for_status()
            ctx = (r.json() or {}).get("injected_context") or ""
            return ctx.strip() or None
        except Exception as e:  # noqa: BLE001
            logger.warning("AgentMem 检索失败（忽略，不阻断对话）：%s", e)
            return None

    async def append(self, character_id, user_id, turns):
        key = await self._ensure_agent(character_id)
        if not key:
            return
        user_input = next((t.get("content", "") for t in reversed(turns) if t.get("role") == "user"), "")
        agent_response = next((t.get("content", "") for t in reversed(turns) if t.get("role") == "assistant"), "")
        if not (user_input or agent_response):
            return
        idem = hashlib.md5(
            f"{character_id}|{user_id}|{user_input}|{agent_response}".encode()
        ).hexdigest()
        try:
            await self._c.post(
                "/v1/memory/add",
                headers={"X-Agent-API-Key": key, "Idempotency-Key": idem},
                json={
                    "user_id": _safe_uid(user_id),
                    "user_input": user_input,
                    "agent_response": agent_response,
                    "scope": "agent_user",
                },
                timeout=self._add_timeout,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("AgentMem 写入失败（忽略）：%s", e)


def build_memory_provider(
    base_url: str,
    db=None,
    *,
    console_token: str = "",
    project_id: str = "",
    single_api_key: str = "",
    top_k: int = 6,
    min_similarity: float = 0.16,
    query_timeout: float = 3.0,
    add_timeout: float = 3.0,
) -> MemoryProvider:
    """工厂：配了 AGENTMEM_BASE_URL 即启用 AgentMem（按角色自动开通），否则 Null。"""
    if base_url:
        logger.info("统一记忆：AgentMem 已启用（%s）", base_url)
        return AgentMemProvider(
            base_url, db, console_token=console_token, project_id=project_id,
            single_api_key=single_api_key, top_k=top_k, min_similarity=min_similarity,
            query_timeout=query_timeout, add_timeout=add_timeout,
        )
    return NullMemoryProvider()
