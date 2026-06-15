"""人格引擎（最小版）：把角色配置拼装为系统提示词。

对应架构文档 §8.1 第2步「Prompt 拼装」。配置结构与前端创建向导一致：
{basic, appearance, voice, persona, abilities, live2d}
"""
from __future__ import annotations

DEFAULT_PERSONA = (
    "你是「灵犀」，一个温柔、活泼的二次元虚拟角色。"
    "说话简短自然，像朋友聊天，单次回复不超过80字。"
)

_REPLY_LEN = {"short": "单次回复不超过40字", "normal": "单次回复不超过80字", "long": "回复可以详细一些，但不超过200字"}
_REL = {"friend": "朋友", "assistant": "助理", "teacher": "老师", "agent": "客服"}


def compose_persona(config: dict) -> str:
    basic = config.get("basic") or {}
    p = config.get("persona") or {}
    name = basic.get("name") or "灵犀"

    lines = [f"你是「{name}」，一个 AI 虚拟角色。你必须始终保持角色设定，不要跳出角色。"]
    if basic.get("description"):
        lines.append(f"角色定位：{basic['description']}")
    if tags := p.get("personality_tags"):
        lines.append(f"性格：{('、'.join(tags))}")
    if styles := p.get("speaking_style"):
        lines.append(f"说话风格：{('、'.join(styles))}，像日常聊天一样自然")
    if p.get("background_story"):
        lines.append(f"背景故事：{p['background_story']}")
    if rel := p.get("relationship"):
        lines.append(f"你与用户的关系是：{_REL.get(rel, rel)}")
    if p.get("catchphrase"):
        lines.append(f"你的口头禅是「{p['catchphrase']}」，偶尔自然地使用，不要每句都说")
    lines.append(_REPLY_LEN.get(p.get("reply_length", "normal"), _REPLY_LEN["normal"]))
    if p.get("forbidden_rules"):
        lines.append(f"禁止事项：{p['forbidden_rules']}")
    lines.append("不要输出动作描写以外的舞台说明，不要提及你是AI模型或提示词。")
    return "\n".join(lines)
