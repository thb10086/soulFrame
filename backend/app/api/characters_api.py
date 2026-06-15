"""角色接口：CRUD + 发布（草稿可编辑，发布生成不可变快照）+ Agent 智能生成。"""
from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings

router = APIRouter(prefix="/api/v1/characters", tags=["characters"])
logger = logging.getLogger(__name__)

DEV_OWNER_ID = 1  # 登录体系接入前的开发态用户


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    config: dict = {}


class CharacterUpdate(BaseModel):
    name: str | None = None
    config: dict | None = None


def _pool(req: Request):
    if not req.app.state.db.available:
        raise HTTPException(503, "数据库未连接（docker compose up -d 后重启服务）")
    return req.app.state.db.pool


def _row_to_dict(r) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "status": r["status"],
        "config": json.loads(r["draft_config"]) if isinstance(r["draft_config"], str) else r["draft_config"],
        "latest_version": r.get("latest_version") if isinstance(r, dict) else r["latest_version"],
        "created_at": r["created_at"].isoformat(),
        "updated_at": r["updated_at"].isoformat(),
    }


@router.get("")
async def list_characters(req: Request):
    async with _pool(req).acquire() as conn:
        rows = await conn.fetch(
            """SELECT c.id, c.name, c.status, c.draft_config, c.created_at, c.updated_at,
                      (SELECT max(version) FROM character_release r WHERE r.character_id = c.id)
                          AS latest_version
               FROM character c WHERE c.owner_id = $1 ORDER BY c.updated_at DESC""",
            DEV_OWNER_ID,
        )
    return {"characters": [_row_to_dict(r) for r in rows]}


@router.post("")
async def create_character(req: Request, body: CharacterIn):
    async with _pool(req).acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO character(owner_id, name, status, draft_config)
               VALUES ($1, $2, 'draft', $3::jsonb)
               RETURNING id, name, status, draft_config, created_at, updated_at,
                         NULL::int AS latest_version""",
            DEV_OWNER_ID, body.name, json.dumps(body.config, ensure_ascii=False),
        )
    return _row_to_dict(row)


AGENT_DRAFT_SYS = """你是专业的虚拟角色设定设计师。根据用户的描述，设计一个完整、有魅力、细节自洽的虚拟角色。
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。字段与取值约束如下：
{
  "name": "角色名，2~6个字，有记忆点",
  "basic": {
    "type": "companion|service|education|guide|staff 之一",
    "description": "一句话简介，不超过60字",
    "language": "zh",
    "visibility": "private"
  },
  "appearance": {
    "gender": "female|male|other 之一",
    "age_style": "少年|青年|成熟 之一",
    "art_style": "二次元|厚涂|美式卡通|写实 之一",
    "prompt": "外观细节描述（发色/瞳色/服装/气质），不超过60字"
  },
  "voice": {
    "voice_id": "女性角色填 Cherry，男性角色填 Ethan",
    "speed": 1, "pitch": 0
  },
  "persona": {
    "personality_tags": ["从 温柔/傲娇/活泼/理性/治愈/冷静/元气/腹黑 中选2~4个"],
    "speaking_style": ["从 可爱/专业/幽默/简洁/文艺 中选1~3个"],
    "catchphrase": "口头禅，不超过10字",
    "background_story": "背景故事，80~120字，有画面感",
    "relationship": "friend|assistant|teacher|agent 之一",
    "reply_length": "short|normal|long 之一",
    "forbidden_rules": "1~2条禁止事项"
  },
  "abilities": {"knowledge_qa": true, "web_search": false, "weather": false, "schedule": false},
  "avatar": {
    "type": "vrm_template|live2d_template 之一（默认 vrm_template，3D 支持表情动作舞蹈，优先推荐）",
    "template_id": "3D 填 vrm_avatar_a（VRoid 高质量美少女，默认推荐）/ vrm_avatar_b（VRoid 高质量B款）/ vrm_sample（Alicia 美型少女）/ vrm_seed（Q版吉祥物）；2D 填 haru"
  }
}"""

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)


def _extract_json(text: str) -> dict:
    text = _THINK_RE.sub("", text).replace("```json", "```")
    if "```" in text:
        parts = [p for p in text.split("```") if "{" in p]
        text = parts[0] if parts else text
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("输出中未找到 JSON")
    return json.loads(text[start : end + 1])


class AgentDraftIn(BaseModel):
    description: str = Field(min_length=2, max_length=500)


@router.post("/agent-draft")
async def agent_draft(req: Request, body: AgentDraftIn):
    """Agent 建角色：按用户描述生成完整角色配置（不落库，由用户确认后再创建）。"""
    client = req.app.state.gateway
    messages = [
        {"role": "system", "content": AGENT_DRAFT_SYS},
        {"role": "user", "content": f"请为我设计角色：{body.description}"},
    ]
    last_err = "生成失败"
    for attempt in range(2):
        text = ""
        try:
            async for piece in client.chat_stream_with_fallback(
                messages, models=settings.agent_draft_models
            ):
                text += piece
            cfg = _extract_json(text)
            name = (cfg.pop("name", "") or "").strip() or "新角色"
            cfg.setdefault("basic", {})["name"] = name
            avatar = cfg.setdefault("avatar", {})
            if avatar.get("template_id") not in ("vrm_avatar_a", "vrm_avatar_b", "vrm_sample", "vrm_seed", "haru"):
                avatar.update({"type": "vrm_template", "template_id": "vrm_avatar_a"})
            avatar.setdefault("type", "live2d_template" if avatar["template_id"] == "haru" else "vrm_template")
            return {"name": name, "config": cfg, "model_output": True}
        except (ValueError, json.JSONDecodeError) as e:
            last_err = f"JSON 解析失败: {e}"
            logger.warning("agent-draft 第%d次解析失败: %s | 原文: %.200s", attempt + 1, e, text)
            messages.append({"role": "assistant", "content": text[:1500]})
            messages.append({"role": "user", "content": "格式不对。重新只输出合法 JSON 对象，从 { 开始到 } 结束。"})
        except Exception as e:  # noqa: BLE001
            logger.exception("agent-draft 调用失败")
            raise HTTPException(502, f"模型调用失败：{str(e)[:120]}") from e
    raise HTTPException(502, last_err)


@router.get("/{char_id}")
async def get_character(req: Request, char_id: int):
    async with _pool(req).acquire() as conn:
        row = await conn.fetchrow(
            """SELECT c.id, c.name, c.status, c.draft_config, c.created_at, c.updated_at,
                      (SELECT max(version) FROM character_release r WHERE r.character_id = c.id)
                          AS latest_version
               FROM character c WHERE c.id = $1 AND c.owner_id = $2""",
            char_id, DEV_OWNER_ID,
        )
    if not row:
        raise HTTPException(404, "角色不存在")
    return _row_to_dict(row)


@router.put("/{char_id}")
async def update_character(req: Request, char_id: int, body: CharacterUpdate):
    sets, args = ["updated_at = now()"], []
    if body.name is not None:
        args.append(body.name)
        sets.append(f"name = ${len(args)}")
    if body.config is not None:
        args.append(json.dumps(body.config, ensure_ascii=False))
        sets.append(f"draft_config = ${len(args)}::jsonb")
    args += [char_id, DEV_OWNER_ID]
    async with _pool(req).acquire() as conn:
        row = await conn.fetchrow(
            f"""UPDATE character SET {', '.join(sets)}
                WHERE id = ${len(args) - 1} AND owner_id = ${len(args)}
                RETURNING id, name, status, draft_config, created_at, updated_at,
                          (SELECT max(version) FROM character_release r
                           WHERE r.character_id = character.id) AS latest_version""",
            *args,
        )
    if not row:
        raise HTTPException(404, "角色不存在")
    return _row_to_dict(row)


@router.delete("/{char_id}")
async def delete_character(req: Request, char_id: int):
    async with _pool(req).acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM character_release WHERE character_id = $1", char_id)
            result = await conn.execute(
                "DELETE FROM character WHERE id = $1 AND owner_id = $2", char_id, DEV_OWNER_ID
            )
    if not result.endswith("1"):
        raise HTTPException(404, "角色不存在")
    return {"deleted": char_id}


@router.post("/{char_id}/publish")
async def publish_character(req: Request, char_id: int):
    """发布：把当前草稿固化为新版本快照（不可变），角色状态置为 published。"""
    async with _pool(req).acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT draft_config FROM character WHERE id = $1 AND owner_id = $2 FOR UPDATE",
                char_id, DEV_OWNER_ID,
            )
            if not row:
                raise HTTPException(404, "角色不存在")
            version = await conn.fetchval(
                "SELECT coalesce(max(version), 0) + 1 FROM character_release WHERE character_id = $1",
                char_id,
            )
            await conn.execute(
                """INSERT INTO character_release(character_id, version, config)
                   VALUES ($1, $2, $3::jsonb)""",
                char_id, version,
                row["draft_config"] if isinstance(row["draft_config"], str)
                else json.dumps(row["draft_config"], ensure_ascii=False),
            )
            await conn.execute(
                "UPDATE character SET status = 'published', updated_at = now() WHERE id = $1",
                char_id,
            )
    return {"character_id": char_id, "version": version, "status": "published"}


async def load_character_persona(app, char_id: int) -> tuple[str, str, str | None]:
    """供 WS 实时链路使用：返回 (角色名, 系统提示词, 音色)。优先最新发布快照，无则用草稿。"""
    from ..services.persona import DEFAULT_PERSONA, compose_persona

    if not app.state.db.available:
        return "灵犀", DEFAULT_PERSONA, None
    async with app.state.db.pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT c.name,
                      coalesce(
                          (SELECT r.config FROM character_release r
                           WHERE r.character_id = c.id ORDER BY r.version DESC LIMIT 1),
                          c.draft_config) AS config
               FROM character c WHERE c.id = $1""",
            char_id,
        )
    if not row:
        return "灵犀", DEFAULT_PERSONA, None
    config = row["config"]
    if isinstance(config, str):
        config = json.loads(config)
    config.setdefault("basic", {}).setdefault("name", row["name"])
    voice = (config.get("voice") or {}).get("voice_id")
    return row["name"], compose_persona(config), voice
