/**
 * 工作台首页（原型 §3.2，React Bits 高级感版）：
 * Aurora 极光 Hero + 渐变标题 + CountUp 统计 + SpotlightCard 角色/模板卡
 */
import { PhoneOutlined, PlusOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Col, Empty, Row, Space, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Character } from "../api/client";
import Aurora from "../components/bits/Aurora";
import CountUp from "../components/bits/CountUp";
import GradientText from "../components/bits/GradientText";
import ShinyText from "../components/bits/ShinyText";
import SpotlightCard from "../components/bits/SpotlightCard";

const TEMPLATES = [
  { name: "温柔陪伴 · 灵犀", type: "陪伴", desc: "温柔治愈系，适合日常聊天陪伴", tags: ["温柔", "治愈"], emoji: "🌸" },
  { name: "专业客服 · 小晓", type: "客服", desc: "礼貌专业，适合业务咨询场景", tags: ["专业", "简洁"], emoji: "💼" },
  { name: "活泼学姐 · Zoe", type: "教育", desc: "幽默风趣，适合学习答疑", tags: ["活泼", "幽默"], emoji: "🎓" },
];

const AVATAR_EMOJI = ["🌙", "🌸", "⭐", "🎀", "🦋", "🍓", "🫧", "🌷"];

export default function DashboardPage() {
  const nav = useNavigate();
  const [chars, setChars] = useState<Character[]>([]);
  const [dbDown, setDbDown] = useState(false);

  useEffect(() => {
    api
      .listCharacters()
      .then((d) => setChars(d.characters))
      .catch(() => setDbDown(true));
  }, []);

  const published = chars.filter((c) => c.status === "published").length;

  return (
    <div style={{ minHeight: "100%", position: "relative" }}>
      {/* Hero：Aurora 极光背景 */}
      <div style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid #1d2244" }}>
        <div style={{ position: "absolute", inset: 0, opacity: 0.85 }}>
          <Aurora colorStops={["#5b7cfa", "#a86bff", "#ff7ab8"]} amplitude={1.1} blend={0.55} speed={0.7} />
        </div>
        <div
          style={{
            position: "relative",
            zIndex: 1,
            maxWidth: 1100,
            margin: "0 auto",
            padding: "72px 24px 56px",
            textAlign: "center",
          }}
        >
          <div className="fade-in-up">
            <GradientText
              colors={["#9db4ff", "#d2a8ff", "#ffb3d2", "#9db4ff"]}
              animationSpeed={7}
              showBorder={false}
            >
              <span style={{ fontSize: 44, fontWeight: 800, letterSpacing: 1, lineHeight: 1.25 }}>
                打造你的专属虚拟偶像
              </span>
            </GradientText>
          </div>
          <div className="fade-in-up" style={{ marginTop: 14, animationDelay: ".08s" }}>
            <ShinyText
              text="AI 生成形象 · 电话级实时语音 · 可触摸互动 · 真舞蹈动作"
              speed={3.5}
              color="#8a93c4"
              shineColor="#ffffff"
              className="hero-sub"
            />
          </div>
          <Space size={14} style={{ marginTop: 32 }} className="fade-in-up">
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => nav("/create")}
              style={{
                height: 46,
                paddingInline: 28,
                background: "linear-gradient(135deg,#5b7cfa,#a86bff)",
                border: "none",
                boxShadow: "0 8px 28px rgba(122,107,255,.4)",
              }}
            >
              创建角色
            </Button>
            {chars.length > 0 && (
              <Button
                size="large"
                icon={<PhoneOutlined />}
                onClick={() => nav(`/chat/${chars[0].id}`)}
                style={{ height: 46, paddingInline: 24, background: "rgba(255,255,255,.06)", borderColor: "#33396b" }}
              >
                和 {chars[0].name} 通话
              </Button>
            )}
          </Space>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px 40px" }}>
        {/* 统计行 */}
        <Row gutter={16}>
          {[
            { label: "我的角色", value: chars.length, suffix: "个" },
            { label: "已发布", value: published, suffix: "个" },
            { label: "今日对话", value: 0, suffix: "次" },
          ].map((s) => (
            <Col span={6} key={s.label}>
              <SpotlightCard className="sf-stat-card" spotlightColor="rgba(122, 162, 255, 0.18)">
                <div style={{ fontSize: 13, color: "#8a93c4" }}>{s.label}</div>
                <div style={{ fontSize: 30, fontWeight: 700, color: "#eef1ff", marginTop: 6 }}>
                  <CountUp to={s.value} duration={1.2} />
                  <span style={{ fontSize: 14, color: "#5d6594", marginLeft: 6 }}>{s.suffix}</span>
                </div>
              </SpotlightCard>
            </Col>
          ))}
          <Col span={6}>
            <SpotlightCard className="sf-stat-card" spotlightColor="rgba(255, 154, 196, 0.16)">
              <div style={{ fontSize: 13, color: "#8a93c4" }}>AI 形象工厂</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#eef1ff", marginTop: 10 }}>
                <ThunderboltOutlined style={{ color: "#ffd666", marginRight: 8 }} />
                Tripo 已接入
              </div>
            </SpotlightCard>
          </Col>
        </Row>

        {/* 最近角色 */}
        <div style={{ marginTop: 32, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography.Title level={5} style={{ margin: 0, color: "#dde2ff" }}>最近角色</Typography.Title>
          <Button type="link" onClick={() => nav("/characters")}>全部角色 →</Button>
        </div>
        <div style={{ marginTop: 14 }}>
          {chars.length === 0 ? (
            <SpotlightCard className="sf-empty-card">
              <Empty description={<span style={{ color: "#8a93c4" }}>{dbDown ? "数据库未连接" : "还没有角色，创建第一个吧"}</span>}>
                <Button type="primary" onClick={() => nav("/create")}>立即创建</Button>
              </Empty>
            </SpotlightCard>
          ) : (
            <Row gutter={[14, 14]}>
              {chars.slice(0, 4).map((c, i) => (
                <Col span={6} key={c.id}>
                  <SpotlightCard className="sf-char-card" spotlightColor="rgba(122, 162, 255, 0.2)">
                    <div
                      onClick={() => nav(`/chat/${c.id}`)}
                      style={{ cursor: "pointer", textAlign: "center", padding: "6px 0" }}
                    >
                      <div
                        style={{
                          width: 64,
                          height: 64,
                          margin: "0 auto",
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 30,
                          background: "linear-gradient(135deg, rgba(91,124,250,.25), rgba(168,107,255,.25))",
                          border: "1px solid #33396b",
                        }}
                      >
                        {AVATAR_EMOJI[c.id % AVATAR_EMOJI.length]}
                      </div>
                      <div style={{ marginTop: 10, fontWeight: 600, color: "#eef1ff", fontSize: 15 }}>{c.name}</div>
                      <div style={{ marginTop: 8 }}>
                        <Tag color={c.status === "published" ? "green" : "default"}>
                          {c.status === "published" ? `已发布 v${c.latest_version ?? 1}` : "草稿"}
                        </Tag>
                      </div>
                      <Space size={6} style={{ marginTop: 12 }}>
                        <Button size="small" type="primary" ghost icon={<PhoneOutlined />} onClick={(e) => { e.stopPropagation(); nav(`/chat/${c.id}`); }}>
                          通话
                        </Button>
                        <Button size="small" onClick={(e) => { e.stopPropagation(); nav(`/create/${c.id}`); }}>编辑</Button>
                      </Space>
                    </div>
                  </SpotlightCard>
                </Col>
              ))}
            </Row>
          )}
        </div>

        {/* 推荐模板 */}
        <div style={{ marginTop: 32 }}>
          <Typography.Title level={5} style={{ margin: 0, color: "#dde2ff" }}>推荐角色模板</Typography.Title>
          <Row gutter={14} style={{ marginTop: 14 }}>
            {TEMPLATES.map((t) => (
              <Col span={8} key={t.name}>
                <SpotlightCard className="sf-tpl-card" spotlightColor="rgba(208, 168, 255, 0.16)">
                  <div
                    style={{ cursor: "pointer", display: "flex", gap: 14, alignItems: "flex-start" }}
                    onClick={() => {
                      message.info("将基于模板进入创建向导");
                      nav("/create", { state: { template: t } });
                    }}
                  >
                    <div style={{ fontSize: 30, lineHeight: 1.2 }}>{t.emoji}</div>
                    <div>
                      <div style={{ fontWeight: 600, color: "#eef1ff" }}>{t.name}</div>
                      <div style={{ fontSize: 12, color: "#8a93c4", marginTop: 4 }}>{t.desc}</div>
                      <Space size={4} style={{ marginTop: 8 }}>
                        {t.tags.map((tag) => (
                          <Tag key={tag} color="blue">{tag}</Tag>
                        ))}
                      </Space>
                    </div>
                  </div>
                </SpotlightCard>
              </Col>
            ))}
          </Row>
        </div>

        <div style={{ marginTop: 36, textAlign: "center", color: "#3d4470", fontSize: 12 }}>
          <RobotOutlined /> SoulFrame · VRM 3D / Live2D 双引擎 · AgentLLM 网关 · Tripo 图生 3D
        </div>
      </div>

      <style>{`
        .hero-sub .shiny-text { font-size: 15px; letter-spacing: 2px; }
      `}</style>
    </div>
  );
}
