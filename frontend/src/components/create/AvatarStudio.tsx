/**
 * 形象工作流（受控）：前置选路线 → 选模板 / AI 文生 / AI 图生 → 右侧实时预览。
 *
 * 任务状态（task/start/reset/busy）由向导级持有并透传，使切步骤/刷新/重进角色都能
 * 续看进度（不再随本组件卸载而丢失）。三条路线职责单一、互不耦合：
 *  - vrm    : 3D 模板（VRM）   - live2d : 2D 模板（Live2D）   - ai : AI 定制（Meshy/Tripo）
 */
import { EditOutlined, ExperimentOutlined, InboxOutlined, PictureOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Input, Segmented, Space, Spin, Switch, Tabs, Tag, Typography, Upload, message } from "antd";
import { useMemo, useState } from "react";
import type { AvatarConfig, CharacterConfig } from "../../api/client";
import { api } from "../../api/client";
import { AVATAR_TEMPLATES } from "../../avatars";
import type { Avatar3DTask, StartAvatar3DParams } from "../../hooks/useAvatar3DTask";
import AvatarStage from "../AvatarStage";
import GLBStage from "../GLBStage";

type Route = "vrm" | "live2d" | "ai";

interface Props {
  value?: AvatarConfig;
  onChange: (avatar: AvatarConfig) => void;
  defaultPrompt: string;
  styleTags?: string[];
  providers: { meshy: boolean; tripo: boolean; available: boolean };
  /** 受控任务态（向导级持有，跨步骤/刷新可续接） */
  task: Avatar3DTask;
  busy: boolean;
  onStart: (p: StartAvatar3DParams) => void;
  onReset: () => void;
  /** 生成前确保角色已存草稿（拿到 character_id），任务挂到角色上以便恢复 */
  ensureCharId: () => Promise<number | null>;
}

const routeOf = (av?: AvatarConfig): Route => {
  if (av?.type === "ai_generated") return "ai";
  if (av?.type === "live2d_template") return "live2d";
  return "vrm";
};

const ROUTE_ICON: Record<Route, JSX.Element> = {
  vrm: <UserOutlined />, live2d: <PictureOutlined />, ai: <ExperimentOutlined />,
};

const fileToDataUri = (file: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });

export default function AvatarStudio({
  value, onChange, defaultPrompt, styleTags, providers, task, busy, onStart, onReset, ensureCharId,
}: Props) {
  const [route, setRoute] = useState<Route>(routeOf(value));
  const [aiTab, setAiTab] = useState<"text" | "image">("text");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [engine, setEngine] = useState<"meshy" | "tripo">(providers.meshy ? "meshy" : "tripo");
  const [multiview, setMultiview] = useState(true);
  const [imgSource, setImgSource] = useState<"portrait" | "upload">("portrait");
  const [portrait, setPortrait] = useState<string | null>(null);
  const [uploadUri, setUploadUri] = useState<string | null>(null);
  const [genningPortrait, setGenningPortrait] = useState(false);

  const selectTemplate = (kind: "vrm" | "live2d", id: string) =>
    onChange({ type: kind === "vrm" ? "vrm_template" : "live2d_template", template_id: id, glb_url: undefined });

  const switchRoute = (r: Route) => {
    setRoute(r);
    if (r === "ai") return;
    const sameKind = r === "vrm" ? value?.type === "vrm_template" : value?.type === "live2d_template";
    if (!sameKind) {
      const first = AVATAR_TEMPLATES.find((t) => t.kind === r);
      if (first) selectTemplate(r, first.id);
    }
  };

  const genPortrait = async () => {
    const p = prompt.trim();
    if (!p) return message.warning("先描述一下角色形象");
    setGenningPortrait(true);
    try {
      const cid = await ensureCharId();
      const r = await api.genPortrait(p, cid ?? undefined);
      setPortrait(r.url);
      message.success(`立绘已生成（${r.model}）`);
    } catch (e: any) {
      message.error(e.message || "立绘生成失败");
    } finally {
      setGenningPortrait(false);
    }
  };

  const resolveImageB64 = async (): Promise<string | undefined> => {
    if (imgSource === "upload") return uploadUri ?? undefined;
    if (portrait) return await fileToDataUri(await (await fetch(portrait)).blob());
    return undefined;
  };

  const generate = async () => {
    try {
      let image_b64: string | undefined;
      let strategy: StartAvatar3DParams["strategy"];
      if (aiTab === "text") {
        if (!prompt.trim()) return message.warning("先描述角色形象");
        strategy = "meshy_text3d";
      } else {
        image_b64 = await resolveImageB64();
        if (!image_b64) return message.warning(imgSource === "upload" ? "先上传一张角色图片" : "先生成角色立绘");
        strategy = engine === "tripo" ? "tripo_image3d" : "meshy_image3d";
      }
      const cid = await ensureCharId();  // 关键：生成前先存草稿关联角色，任务可恢复
      onStart({
        prompt: aiTab === "text" ? prompt.trim() : prompt.trim() || undefined,
        image_b64,
        strategy,
        multiview: strategy.startsWith("meshy") ? multiview : false,
        character_id: cid ?? undefined,
        style_tags: styleTags,
      });
    } catch (e: any) {
      const raw = e?.message || "启动失败";
      message.error(raw === "Load failed" || raw === "Failed to fetch" ? "无法连接后端，请确认服务已启动" : raw);
    }
  };

  const done = task.status === "done" && !!task.urls?.glb;
  const previewConfig = useMemo<CharacterConfig | null>(() => {
    if (route === "ai") {
      if (done) return null; // 用 GLBStage 渲染生成结果（带三视图）
      if (value?.type === "ai_generated" && value.glb_url) return { avatar: value };
      return null;
    }
    return value ? { avatar: value } : null;
  }, [route, done, value]);

  const previewImage = imgSource === "upload" ? uploadUri : portrait;

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "stretch", flexWrap: "wrap" }}>
      {/* 左：路线 + 控件 */}
      <div style={{ flex: "1 1 460px", minWidth: 380 }}>
        <Segmented
          block
          value={route}
          onChange={(v) => switchRoute(v as Route)}
          options={[
            { label: "3D · VRM 模板", value: "vrm", icon: ROUTE_ICON.vrm },
            { label: "2D · Live2D", value: "live2d", icon: ROUTE_ICON.live2d },
            { label: "3D · AI 定制", value: "ai", icon: ROUTE_ICON.ai },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10 }}>
          {route === "vrm" && "高质量 VRM 模型，表情/口型/动作/舞蹈全支持，开箱即用。"}
          {route === "live2d" && "经典 2D Live2D，轻量流畅，支持口型/动作组/视线跟随。"}
          {route === "ai" && "用文本或图片生成专属 3D 模型：建模 → 4K 贴图 → 自动绑骨 → 官方动画。"}
        </Typography.Paragraph>

        {route !== "ai" ? (
          <Space wrap size={12} style={{ marginTop: 4 }}>
            {AVATAR_TEMPLATES.filter((t) => t.kind === route).map((t) => {
              const selected = value?.template_id === t.id && value?.type !== "ai_generated";
              return (
                <Card
                  key={t.id}
                  hoverable
                  size="small"
                  style={{ width: 200, borderColor: selected ? "#5b7cfa" : undefined }}
                  onClick={() => selectTemplate(route, t.id)}
                >
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, color: "#7aa2ff" }}>{ROUTE_ICON[route]}</div>
                    <div style={{ fontWeight: 600, marginTop: 6, fontSize: 13 }}>{t.name}</div>
                    <div style={{ color: "#888", fontSize: 11, marginTop: 4, minHeight: 30 }}>{t.desc}</div>
                    <div style={{ marginTop: 6 }}>
                      {t.tags.slice(0, 3).map((tag) => (
                        <Tag key={tag} color={t.kind === "vrm" ? "blue" : "green"} style={{ marginInline: 1 }}>{tag}</Tag>
                      ))}
                      {selected && <Tag color="processing">已选择</Tag>}
                    </div>
                  </div>
                </Card>
              );
            })}
          </Space>
        ) : !providers.available ? (
          <Alert
            type="info"
            showIcon
            message="AI 生成未启用"
            description="在 .env 配置 MESHY_API_KEY 或 TRIPO_API_KEY 后重启后端即可启用（注册 meshy.ai / tripo3d.ai 获取）。"
          />
        ) : (
          <Tabs
            activeKey={aiTab}
            onChange={(k) => setAiTab(k as "text" | "image")}
            items={[
              {
                key: "text",
                label: <span><EditOutlined /> 文本生成</span>,
                disabled: !providers.meshy,
                children: (
                  <Space direction="vertical" style={{ width: "100%" }} size={10}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      一句话描述形象，Meshy 出三视图再联合建模（形体最准）。
                    </Typography.Text>
                    <Input.TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="如：粉色双马尾的二次元偶像少女，白粉演出服，元气可爱" />
                    {providers.meshy && (
                      <Space size={8}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>三视图精准建模</Typography.Text>
                        <Switch size="small" checked={multiview} onChange={setMultiview} />
                      </Space>
                    )}
                    <Button type="primary" loading={busy} disabled={busy} onClick={generate}>
                      生成 3D 模型（约 4~6 分钟）
                    </Button>
                  </Space>
                ),
              },
              {
                key: "image",
                label: <span><PictureOutlined /> 图片生成</span>,
                children: (
                  <Space direction="vertical" style={{ width: "100%" }} size={10}>
                    <Segmented size="small" value={imgSource} onChange={(v) => setImgSource(v as "portrait" | "upload")}
                      options={[{ label: "AI 生成立绘", value: "portrait" }, { label: "上传图片", value: "upload" }]} />
                    {imgSource === "portrait" ? (
                      <Space direction="vertical" style={{ width: "100%" }} size={8}>
                        <Input.TextArea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                          placeholder="描述角色形象，先出立绘确认再建模，形象最可控" />
                        <Button loading={genningPortrait} onClick={genPortrait}>
                          {portrait ? "重新生成立绘" : "生成角色立绘"}
                        </Button>
                      </Space>
                    ) : (
                      <Upload.Dragger accept="image/*" maxCount={1} showUploadList={false}
                        beforeUpload={async (file) => { setUploadUri(await fileToDataUri(file)); message.success("图片已就绪"); return false; }}>
                        <p style={{ margin: 0 }}><InboxOutlined style={{ fontSize: 28, color: "#5b7cfa" }} /></p>
                        <p style={{ margin: "8px 0 0", fontSize: 13 }}>点击或拖拽角色图片到此处</p>
                        <p style={{ color: "#888", fontSize: 12 }}>建议正面全身、A-pose、纯色底</p>
                      </Upload.Dragger>
                    )}
                    <Space size={12} wrap>
                      <span>
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>生成引擎</Typography.Text>
                        <Segmented size="small" value={engine} onChange={(v) => setEngine(v as "meshy" | "tripo")}
                          options={[
                            { label: "Meshy（官方动画）", value: "meshy", disabled: !providers.meshy },
                            { label: "Tripo", value: "tripo", disabled: !providers.tripo },
                          ]} />
                      </span>
                      {engine === "meshy" && (
                        <span>
                          <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>三视图精准</Typography.Text>
                          <Switch size="small" checked={multiview} onChange={setMultiview} />
                        </span>
                      )}
                    </Space>
                    <Button type="primary" loading={busy} disabled={busy} onClick={generate}>
                      用该图片生成 3D 模型（约 3~6 分钟）
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}

        {/* AI 任务进度/失败提示（受控 task） */}
        {route === "ai" && task.status !== "idle" && (
          <Card size="small" style={{ marginTop: 12 }}>
            {task.status === "failed" ? (
              <Alert type="error" showIcon message="生成失败" description={task.error}
                action={<Button size="small" onClick={onReset}>重试</Button>} />
            ) : done ? (
              <Space>
                <Tag color="success">✓ 已生成并应用</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {task.urls?.anims && `含官方动画：${Object.keys(task.urls.anims).join(" / ")}`}
                </Typography.Text>
                <Button size="small" onClick={onReset}>重新生成</Button>
              </Space>
            ) : (
              <Space><Spin size="small" /><Typography.Text>{task.stage}</Typography.Text></Space>
            )}
          </Card>
        )}
      </div>

      {/* 右：实时预览 */}
      <div style={{ flex: "1 1 360px", minWidth: 320 }}>
        <div style={{ background: "#0e1230", borderRadius: 12, overflow: "hidden", minHeight: 420, position: "relative" }}>
          {route === "ai" && done ? (
            <div>
              <GLBStage url={task.urls!.glb!} animUrls={task.urls!.anims} height={420} />
              {task.urls?.views && task.urls.views.length > 0 && (
                <Space size={6} style={{ padding: "8px 10px" }}>
                  {task.urls.views.map((v) => (
                    <img key={v} src={v} alt="三视图" style={{ height: 54, borderRadius: 6, border: "1px solid #2a2f55" }} />
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>三视图参考</Typography.Text>
                </Space>
              )}
            </div>
          ) : route === "ai" && busy ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
              {previewImage && <img src={previewImage} alt="参考" style={{ maxHeight: 220, borderRadius: 8, opacity: 0.85 }} />}
              <Spin />
              <Typography.Text type="secondary">{task.stage}</Typography.Text>
            </div>
          ) : previewConfig ? (
            <AvatarStage config={previewConfig} height={420} interactive />
          ) : route === "ai" && previewImage ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <img src={previewImage} alt="参考图" style={{ maxHeight: 360, borderRadius: 8 }} />
            </div>
          ) : (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b73a0" }}>
              {route === "ai" ? "生成后在此预览模型" : "选择模板后在此预览"}
            </div>
          )}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8, textAlign: "center" }}>
          可拖拽旋转 · 滚轮缩放 · 双击复位
        </Typography.Text>
      </div>
    </div>
  );
}
