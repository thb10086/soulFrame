/** 创建角色：入口选择（Agent / 手动）→ 手动 4 步精简向导（形象前置）。
 *
 * 4 步：形象（AvatarStudio 工作流）→ 角色设定 → 声音与能力 → 预览发布。
 * 形象生成/预览全部下沉到 AvatarStudio，本组件只做"步骤编排 + 配置存取"，职责单一。
 */
import { EyeOutlined, FormOutlined, RobotOutlined } from "@ant-design/icons";
import { Button, Card, Checkbox, Col, Descriptions, Form, Input, Progress, Radio, Row, Select, Slider, Space, Steps, Switch, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api, CharacterConfig } from "../api/client";
import { AVATAR_TEMPLATES } from "../avatars";
import AvatarStudio from "../components/create/AvatarStudio";
import { taskPercent, useAvatar3DTask } from "../hooks/useAvatar3DTask";
import AgentCreate from "./AgentCreate";

const STEPS = ["形象", "角色设定", "声音与能力", "预览发布"];

const PERSONALITY_TAGS = ["温柔", "傲娇", "活泼", "理性", "治愈", "冷静", "元气", "腹黑"];
const SPEAKING_STYLES = ["可爱", "专业", "幽默", "简洁", "文艺"];
const VOICES = [
  { value: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0（女声 · 豆包，推荐）" },
  { value: "zh_female_cancan_mars_bigtts", label: "灿灿（女声 · 豆包）" },
  { value: "zh_male_shuanglangshaonian_moon_bigtts", label: "双廊少年（男声 · 豆包）" },
  { value: "Cherry", label: "Cherry（女声 · Qwen 实时，端到端语音用）" },
  { value: "Ethan", label: "Ethan（男声 · Qwen 实时，端到端语音用）" },
];

const DEFAULT_CONFIG: CharacterConfig = {
  basic: { type: "companion", language: "zh", visibility: "private" },
  appearance: { gender: "female", age_style: "青年", art_style: "二次元" },
  voice: { voice_id: VOICES[0].value, speed: 1, pitch: 0 },
  persona: { personality_tags: ["温柔"], speaking_style: ["可爱"], relationship: "friend", reply_length: "normal" },
  abilities: { web_search: false, knowledge_qa: true, weather: false, schedule: false },
  avatar: { type: "vrm_template", template_id: "vrm_avatar_a" },
};

const EMPTY_PROVIDERS = { meshy: false, tripo: false, available: false };

export default function CreateWizardPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const { state } = useLocation() as { state?: { template?: { name: string; tags: string[]; desc: string } } };
  const [mode, setMode] = useState<"choose" | "manual" | "agent">(
    id || state?.template ? "manual" : "choose"
  );
  const [step, setStep] = useState(0);
  const [charId, setCharId] = useState<number | null>(id ? Number(id) : null);
  const [name, setName] = useState(state?.template?.name?.split("·").pop()?.trim() ?? "");
  const [cfg, setCfg] = useState<CharacterConfig>(() => {
    const base = structuredClone(DEFAULT_CONFIG);
    if (state?.template) {
      base.persona!.personality_tags = state.template.tags;
      base.basic!.description = state.template.desc;
    }
    return base;
  });
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState(EMPTY_PROVIDERS);
  // AI 形象生成任务：提到向导级持有 → 切步骤/刷新/重进角色都能续看进度（不随表单步骤卸载而丢）
  const avatar3d = useAvatar3DTask();
  const appliedRef = useRef<string | null>(null);
  const resumedRef = useRef<number | null>(null);

  useEffect(() => {
    api.assetProviders().then((r) => setProviders(r.mesh3d)).catch(() => {});
  }, []);

  // 生成完成 → 自动把模型写入角色形象（无论当前在哪一步，避免用户离开形象步就丢结果）
  useEffect(() => {
    const t = avatar3d.task;
    if (t.status === "done" && t.urls?.glb && appliedRef.current !== t.task_id) {
      appliedRef.current = t.task_id ?? "done";
      setCfg((prev) => ({
        ...prev,
        avatar: {
          type: "ai_generated", glb_url: t.urls!.glb, anim_urls: t.urls!.anims,
          strategy: t.strategy, portrait_url: t.urls!.portrait, template_id: undefined,
        },
      }));
    }
  }, [avatar3d.task]);

  useEffect(() => {
    if (!id) return;
    api.getCharacter(Number(id)).then((c) => {
      setName(c.name);
      const merged = { ...structuredClone(DEFAULT_CONFIG), ...c.config };
      if (!c.config?.avatar && c.config?.live2d?.template_id) {
        merged.avatar = { type: "live2d_template", template_id: c.config.live2d.template_id };
      }
      setCfg(merged);
    }).catch((e) => message.error(e.message));
  }, [id]);

  const patch = (section: keyof CharacterConfig, kv: Record<string, unknown>) =>
    setCfg((prev) => ({ ...prev, [section]: { ...(prev[section] as object), ...kv } }));

  // 生成前确保已存草稿拿到 character_id：形象先于命名，无名时用占位名先存，后续步骤可改
  const ensureCharId = useCallback(async (): Promise<number | null> => {
    if (charId) return charId;
    const placeholder = name.trim() || "未命名角色";
    try {
      const c = await api.createCharacter(placeholder, { ...cfg, basic: { ...cfg.basic, name: placeholder } });
      setCharId(c.id);
      if (!name.trim()) setName(placeholder);
      return c.id;
    } catch (e: any) {
      message.error(e.message || "保存草稿失败");
      return null;
    }
  }, [charId, name, cfg]);

  // 重进角色 / 刷新：若后端有进行中的生成任务，自动续接轮询（中途退出可接着看进度）
  useEffect(() => {
    if (!charId || resumedRef.current === charId) return;
    resumedRef.current = charId;
    api.avatar3DActive(charId).then((t) => {
      if (t?.task_id && t.status && !["done", "failed"].includes(t.status)) {
        avatar3d.resume(t.task_id, { status: t.status as any, stage: t.stage, strategy: t.strategy, urls: t.urls });
      }
    }).catch(() => {});
  }, [charId, avatar3d]);

  const avatarPrompt = useMemo(() => {
    const a = cfg.appearance ?? {};
    return [
      a.gender === "male" ? "美少年" : "美少女",
      a.age_style, a.art_style || "二次元", cfg.basic?.description, a.prompt,
    ].filter(Boolean).join("，");
  }, [cfg.appearance, cfg.basic?.description]);

  const saveDraft = async (silent = false): Promise<number | null> => {
    if (!name.trim()) {
      message.warning("请先填写角色名称");
      setStep(1);
      return null;
    }
    setSaving(true);
    try {
      const full = { ...cfg, basic: { ...cfg.basic, name } };
      const c = charId
        ? await api.updateCharacter(charId, { name, config: full })
        : await api.createCharacter(name, full);
      setCharId(c.id);
      if (!silent) message.success("草稿已保存");
      return c.id;
    } catch (e: any) {
      message.error(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    const cid = await saveDraft(true);
    if (!cid) return;
    try {
      const r = await api.publishCharacter(cid);
      message.success(`发布成功 v${r.version}，即将进入互动页`);
      setTimeout(() => nav(`/chat/${cid}`), 600);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const avatarLabel = () => {
    if (cfg.avatar?.type === "ai_generated") return "AI 生成专属形象（3D · 绑骨 + 官方动画）";
    const t = AVATAR_TEMPLATES.find((x) => x.id === cfg.avatar?.template_id);
    return t ? `${t.name}` : cfg.live2d?.template_id ?? "-";
  };

  const stepContent = useMemo(() => {
    switch (step) {
      case 0:
        return (
          <AvatarStudio
            value={cfg.avatar}
            onChange={(avatar) => setCfg((prev) => ({ ...prev, avatar }))}
            defaultPrompt={avatarPrompt}
            styleTags={cfg.persona?.personality_tags}
            providers={providers}
            task={avatar3d.task}
            busy={avatar3d.busy}
            onStart={avatar3d.start}
            onReset={avatar3d.reset}
            ensureCharId={ensureCharId}
          />
        );
      case 1:
        return (
          <Form layout="vertical" style={{ maxWidth: 640 }}>
            <Space size={16} style={{ display: "flex" }} align="start">
              <Form.Item label="角色名称" required style={{ flex: 1 }}>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} showCount placeholder="例如：灵犀" />
              </Form.Item>
              <Form.Item label="角色类型" style={{ flex: 1 }}>
                <Select
                  value={cfg.basic?.type}
                  onChange={(v) => patch("basic", { type: v })}
                  options={[
                    { value: "companion", label: "陪伴" }, { value: "service", label: "客服" },
                    { value: "education", label: "教育" }, { value: "guide", label: "导购" },
                    { value: "staff", label: "数字员工" },
                  ]}
                />
              </Form.Item>
            </Space>
            <Form.Item label="角色简介">
              <Input.TextArea value={cfg.basic?.description} onChange={(e) => patch("basic", { description: e.target.value })}
                maxLength={200} showCount rows={2} placeholder="一句话描述这个角色" />
            </Form.Item>
            <Form.Item label="性格标签（多选）">
              <Checkbox.Group value={cfg.persona?.personality_tags} onChange={(v) => patch("persona", { personality_tags: v })} options={PERSONALITY_TAGS} />
            </Form.Item>
            <Form.Item label="说话风格（多选）">
              <Checkbox.Group value={cfg.persona?.speaking_style} onChange={(v) => patch("persona", { speaking_style: v })} options={SPEAKING_STYLES} />
            </Form.Item>
            <Form.Item label="背景故事">
              <Input.TextArea value={cfg.persona?.background_story} onChange={(e) => patch("persona", { background_story: e.target.value })}
                rows={3} maxLength={500} showCount />
            </Form.Item>
            <Space size={16} style={{ display: "flex" }}>
              <Form.Item label="口头禅" style={{ flex: 1 }}>
                <Input value={cfg.persona?.catchphrase} onChange={(e) => patch("persona", { catchphrase: e.target.value })} maxLength={30} />
              </Form.Item>
              <Form.Item label="与用户关系" style={{ flex: 1 }}>
                <Select value={cfg.persona?.relationship} onChange={(v) => patch("persona", { relationship: v })}
                  options={[{ value: "friend", label: "朋友" }, { value: "assistant", label: "助理" }, { value: "teacher", label: "老师" }, { value: "agent", label: "客服" }]} />
              </Form.Item>
              <Form.Item label="回复长度" style={{ flex: 1 }}>
                <Select value={cfg.persona?.reply_length} onChange={(v) => patch("persona", { reply_length: v })}
                  options={[{ value: "short", label: "简短" }, { value: "normal", label: "正常" }, { value: "long", label: "详细" }]} />
              </Form.Item>
            </Space>
            <Form.Item label="禁止事项">
              <Input.TextArea value={cfg.persona?.forbidden_rules} onChange={(e) => patch("persona", { forbidden_rules: e.target.value })}
                rows={2} placeholder="例如：不讨论政治话题；不透露自己是 AI 模型" />
            </Form.Item>
          </Form>
        );
      case 2:
        return (
          <Form layout="vertical" style={{ maxWidth: 520 }}>
            <Form.Item label="音色">
              <Select value={cfg.voice?.voice_id} onChange={(v) => patch("voice", { voice_id: v })} options={VOICES} />
            </Form.Item>
            <Space size={24} style={{ display: "flex" }}>
              <Form.Item label={`语速 ${cfg.voice?.speed ?? 1}`} style={{ flex: 1 }}>
                <Slider min={0.5} max={2} step={0.1} value={cfg.voice?.speed} onChange={(v) => patch("voice", { speed: v })} />
              </Form.Item>
              <Form.Item label={`音调 ${cfg.voice?.pitch ?? 0}`} style={{ flex: 1 }}>
                <Slider min={-5} max={5} step={1} value={cfg.voice?.pitch} onChange={(v) => patch("voice", { pitch: v })} />
              </Form.Item>
            </Space>
            <Typography.Title level={5} style={{ marginTop: 8 }}>能力</Typography.Title>
            {[
              { key: "knowledge_qa", label: "知识问答（基于角色记忆/知识库）" },
              { key: "web_search", label: "联网搜索" },
              { key: "weather", label: "天气查询" },
              { key: "schedule", label: "日程提醒" },
            ].map((a) => (
              <Form.Item key={a.key} label={a.label} style={{ marginBottom: 10 }}>
                <Switch checked={cfg.abilities?.[a.key]} onChange={(v) => patch("abilities", { [a.key]: v })} />
              </Form.Item>
            ))}
            <Typography.Text type="secondary">语音对话上线后音色生效；工具调用执行器后续迭代接入。</Typography.Text>
          </Form>
        );
      default:
        return (
          <Space direction="vertical" style={{ width: "100%" }} size={16}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="名称">{name || "-"}</Descriptions.Item>
              <Descriptions.Item label="类型">{cfg.basic?.type}</Descriptions.Item>
              <Descriptions.Item label="形象" span={2}>{avatarLabel()}</Descriptions.Item>
              <Descriptions.Item label="性格">{cfg.persona?.personality_tags?.join("、")}</Descriptions.Item>
              <Descriptions.Item label="说话风格">{cfg.persona?.speaking_style?.join("、")}</Descriptions.Item>
              <Descriptions.Item label="音色">{VOICES.find((v) => v.value === cfg.voice?.voice_id)?.label}</Descriptions.Item>
              <Descriptions.Item label="关系 / 回复">{cfg.persona?.relationship} / {cfg.persona?.reply_length}</Descriptions.Item>
              <Descriptions.Item label="简介" span={2}>{cfg.basic?.description || "-"}</Descriptions.Item>
            </Descriptions>
            <Typography.Text type="secondary">
              发布后生成不可变版本快照（v1, v2, …），线上互动始终使用最新发布版本。
            </Typography.Text>
          </Space>
        );
    }
  }, [step, name, cfg, providers, avatarPrompt, avatar3d.task, avatar3d.busy, ensureCharId]);

  if (mode === "choose") {
    return (
      <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
        <Typography.Title level={4}>创建角色</Typography.Title>
        <Typography.Paragraph type="secondary">选择创建方式：</Typography.Paragraph>
        <Row gutter={20}>
          <Col span={12}>
            <Card hoverable onClick={() => setMode("agent")} style={{ textAlign: "center", padding: "16px 0" }}>
              <RobotOutlined style={{ fontSize: 44, color: "#5b7cfa" }} />
              <Typography.Title level={5} style={{ marginTop: 14 }}>Agent 智能创建</Typography.Title>
              <Typography.Text type="secondary">一句话描述，AI 出完整设定，<br />可一键继续生成专属形象</Typography.Text>
              <div style={{ marginTop: 12 }}><Tag color="blue">推荐 · 30 秒建角</Tag></div>
            </Card>
          </Col>
          <Col span={12}>
            <Card hoverable onClick={() => { setMode("manual"); setStep(0); }} style={{ textAlign: "center", padding: "16px 0" }}>
              <FormOutlined style={{ fontSize: 44, color: "#22b07d" }} />
              <Typography.Title level={5} style={{ marginTop: 14 }}>手动精细创建</Typography.Title>
              <Typography.Text type="secondary">4 步向导：形象 → 角色设定 → <br />声音与能力 → 预览发布</Typography.Text>
              <div style={{ marginTop: 12 }}><Tag color="green">完全可控</Tag></div>
            </Card>
          </Col>
        </Row>
      </div>
    );
  }

  if (mode === "agent") {
    return (
      <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Title level={4}>Agent 智能创建</Typography.Title>
          <Button onClick={() => setMode("choose")}>返回选择</Button>
        </Space>
        <AgentCreate />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1080, margin: "0 auto" }}>
      <Typography.Title level={4}>{charId ? `编辑角色 #${charId}` : "创建角色"}</Typography.Title>

      {/* 向导级常驻进度条：AI 形象生成是异步任务，切到其它步骤/刷新/重进角色都能看到进度 */}
      {avatar3d.task.status !== "idle" && (
        <Card size="small" styles={{ body: { padding: "10px 14px" } }} style={{ marginBottom: 12 }}>
          <Space style={{ width: "100%", justifyContent: "space-between" }} align="center" wrap>
            <Typography.Text style={{ color: "#cdd3f5" }}>
              {avatar3d.task.status === "done" ? "专属形象已生成 ✓ 已应用"
                : avatar3d.task.status === "failed" ? `形象生成失败：${avatar3d.task.error ?? ""}`
                : `形象生成中 · ${avatar3d.task.stage}`}
            </Typography.Text>
            <Space>
              <Progress
                percent={taskPercent(avatar3d.task)}
                size="small" style={{ width: 180 }} showInfo={avatar3d.task.status !== "done"}
                status={avatar3d.task.status === "failed" ? "exception" : avatar3d.task.status === "done" ? "success" : "active"}
              />
              {step !== 0 && <Button size="small" icon={<EyeOutlined />} onClick={() => setStep(0)}>查看</Button>}
              {(avatar3d.task.status === "done" || avatar3d.task.status === "failed") && (
                <Button size="small" type="text" onClick={avatar3d.reset}>关闭</Button>
              )}
            </Space>
          </Space>
        </Card>
      )}

      <Card>
        <Steps size="small" current={step} onChange={setStep} items={STEPS.map((t) => ({ title: t }))} style={{ marginBottom: 28 }} />
        <div style={{ minHeight: 420 }}>{stepContent}</div>
        <Space style={{ marginTop: 24 }}>
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>上一步</Button>
          {step < STEPS.length - 1 && <Button type="primary" onClick={() => setStep(step + 1)}>下一步</Button>}
          <Button loading={saving} onClick={() => saveDraft()}>保存草稿</Button>
          {step === STEPS.length - 1 && <Button type="primary" loading={saving} onClick={publish}>发布并开始互动</Button>}
        </Space>
      </Card>
    </div>
  );
}
