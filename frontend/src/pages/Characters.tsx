/** 我的角色列表（原型 §3.3，React Bits 高级感版）：SpotlightCard 网格 + 互动/编辑/发布/删除 */
import {
  DeleteOutlined,
  EditOutlined,
  PhoneOutlined,
  PlusOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { Button, Col, Empty, Popconfirm, Row, Space, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Character } from "../api/client";
import SpotlightCard from "../components/bits/SpotlightCard";

const TYPE_LABEL: Record<string, string> = {
  companion: "陪伴", service: "客服", education: "教育", guide: "导购", staff: "数字员工",
};

const AVATAR_EMOJI = ["🌙", "🌸", "⭐", "🎀", "🦋", "🍓", "🫧", "🌷"];

export default function CharactersPage() {
  const nav = useNavigate();
  const [chars, setChars] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = () =>
    api
      .listCharacters()
      .then((d) => setChars(d.characters))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const publish = async (c: Character) => {
    try {
      const r = await api.publishCharacter(c.id);
      message.success(`「${c.name}」已发布 v${r.version}`);
      load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const remove = async (c: Character) => {
    try {
      await api.deleteCharacter(c.id);
      message.success("已删除");
      load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const avatarKind = (c: Character) => {
    const av = c.config?.avatar;
    if (av?.type === "ai_generated") return { label: "3D · AI 生成", color: "purple" };
    if (av?.type === "live2d_template" || (!av && c.config?.live2d?.template_id)) return { label: "2D · Live2D", color: "green" };
    return { label: "3D · VRM", color: "blue" };
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 18 }}>
        <Typography.Title level={4} style={{ margin: 0, color: "#eef1ff" }}>
          我的角色
        </Typography.Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => nav("/create")}
          style={{ background: "linear-gradient(135deg,#5b7cfa,#a86bff)", border: "none" }}
        >
          创建角色
        </Button>
      </Space>

      {!loading && chars.length === 0 && (
        <SpotlightCard>
          <Empty description={<span style={{ color: "#8a93c4" }}>{err ? `加载失败：${err}` : "还没有角色"}</span>}>
            <Button type="primary" onClick={() => nav("/create")}>立即创建</Button>
          </Empty>
        </SpotlightCard>
      )}

      <Row gutter={[16, 16]}>
        {chars.map((c) => {
          const kind = avatarKind(c);
          return (
            <Col span={8} key={c.id}>
              <SpotlightCard spotlightColor="rgba(122, 162, 255, 0.18)">
                <div style={{ display: "flex", gap: 14 }}>
                  <div
                    style={{
                      width: 56,
                      height: 56,
                      flex: "0 0 56px",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 26,
                      background: "linear-gradient(135deg, rgba(91,124,250,.25), rgba(168,107,255,.25))",
                      border: "1px solid #33396b",
                    }}
                  >
                    {AVATAR_EMOJI[c.id % AVATAR_EMOJI.length]}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Space size={8}>
                      <span style={{ fontWeight: 600, fontSize: 15, color: "#eef1ff" }}>{c.name}</span>
                      <Tag color={c.status === "published" ? "green" : "default"}>
                        {c.status === "published" ? `已发布 v${c.latest_version ?? 1}` : "草稿"}
                      </Tag>
                    </Space>
                    <div style={{ marginTop: 6 }}>
                      <Tag color={kind.color}>{kind.label}</Tag>
                      <Tag color="blue">{TYPE_LABEL[c.config?.basic?.type ?? ""] ?? "陪伴"}</Tag>
                      {(c.config?.persona?.personality_tags ?? []).slice(0, 2).map((t) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }} ellipsis>
                      {c.config?.basic?.description || "暂无简介"}
                    </Typography.Text>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 14,
                    paddingTop: 12,
                    borderTop: "1px solid #1f2447",
                  }}
                >
                  <Button type="primary" ghost size="small" icon={<PhoneOutlined />} onClick={() => nav(`/chat/${c.id}`)}>
                    互动 / 通话
                  </Button>
                  <Space size={4}>
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={() => nav(`/create/${c.id}`)} />
                    <Button
                      type="text"
                      size="small"
                      icon={<RocketOutlined />}
                      disabled={c.status === "published"}
                      onClick={() => publish(c)}
                    />
                    <Popconfirm title="确定删除该角色？" onConfirm={() => remove(c)}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
              </SpotlightCard>
            </Col>
          );
        })}
      </Row>

    </div>
  );
}
