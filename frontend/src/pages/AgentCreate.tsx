/** Agent 智能建角：用户描述 → LLM 生成完整角色设定 → 用户确认/微调/发布 */
import { CheckOutlined, EditOutlined, ReloadOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Input, Space, Spin, Tag, Typography, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CharacterConfig } from "../api/client";
import { AVATAR_TEMPLATES } from "../avatars";

const EXAMPLES = [
  "一个温柔治愈的猫娘女仆，喜欢撒娇，会记得我说过的每件小事",
  "高冷理性的天才少女科学家，说话毒舌但其实很关心人",
  "元气满满的健身教练学长，每天督促我锻炼和早睡",
  "专业耐心的日语老师，上课严格，课后像朋友一样聊动漫",
];

interface Proposal {
  name: string;
  config: CharacterConfig;
}

export default function AgentCreate() {
  const nav = useNavigate();
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [acting, setActing] = useState(false);

  const generate = async () => {
    if (desc.trim().length < 2) {
      message.warning("请先描述你想要的角色");
      return;
    }
    setLoading(true);
    setProposal(null);
    try {
      setProposal(await api.agentDraft(desc.trim()));
    } catch (e: any) {
      message.error(`生成失败：${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // dest: chat=直接发布用模板形象 / studio=保存草稿并进形象工作流定制专属形象
  const saveAs = async (dest: "chat" | "studio") => {
    if (!proposal) return;
    setActing(true);
    try {
      const c = await api.createCharacter(proposal.name, proposal.config);
      if (dest === "chat") {
        await api.publishCharacter(c.id);
        message.success(`「${c.name}」已创建并发布，进入互动`);
        nav(`/chat/${c.id}`);
      } else {
        message.success("设定已保存，来给 TA 定制专属形象吧");
        nav(`/create/${c.id}`); // 进 4 步向导，落在「形象」首步
      }
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setActing(false);
    }
  };

  const p = proposal?.config.persona;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      <Card>
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text strong>
            <RobotOutlined style={{ color: "#5b7cfa", marginRight: 8 }} />
            用一句话描述你想要的角色，Agent 会生成完整设定（名字/性格/背景/声音/外观）
          </Typography.Text>
          <Input.TextArea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
            maxLength={500}
            showCount
            placeholder="例如：一个温柔治愈的猫娘女仆，喜欢撒娇……"
          />
          <Space wrap>
            {EXAMPLES.map((ex) => (
              <Tag key={ex} style={{ cursor: "pointer", padding: "4px 10px" }} onClick={() => setDesc(ex)}>
                {ex.slice(0, 18)}…
              </Tag>
            ))}
          </Space>
          <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={loading} onClick={generate}>
            {proposal ? "重新生成" : "生成角色设定"}
          </Button>
        </Space>
      </Card>

      {loading && (
        <Card>
          <div style={{ textAlign: "center", padding: 32 }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: "#888" }}>Agent 正在设计角色（约 5~15 秒）…</div>
          </div>
        </Card>
      )}

      {proposal && !loading && (
        <Card
          title={
            <Space>
              <span>生成结果：「{proposal.name}」</span>
              <Tag color="blue">{proposal.config.basic?.type}</Tag>
            </Space>
          }
        >
          <Descriptions bordered column={2} size="small">
            <Descriptions.Item label="简介" span={2}>{proposal.config.basic?.description}</Descriptions.Item>
            <Descriptions.Item label="性格">{p?.personality_tags?.join("、")}</Descriptions.Item>
            <Descriptions.Item label="说话风格">{p?.speaking_style?.join("、")}</Descriptions.Item>
            <Descriptions.Item label="口头禅">{p?.catchphrase || "-"}</Descriptions.Item>
            <Descriptions.Item label="关系 / 回复长度">{p?.relationship} / {p?.reply_length}</Descriptions.Item>
            <Descriptions.Item label="背景故事" span={2}>{p?.background_story}</Descriptions.Item>
            <Descriptions.Item label="外观" span={2}>{proposal.config.appearance?.prompt || "-"}</Descriptions.Item>
            <Descriptions.Item label="音色">{proposal.config.voice?.voice_id}</Descriptions.Item>
            <Descriptions.Item label="禁止事项">{p?.forbidden_rules || "-"}</Descriptions.Item>
            <Descriptions.Item label="形象" span={2}>
              {AVATAR_TEMPLATES.find((t) => t.id === proposal.config.avatar?.template_id)?.name ?? "Mio（3D · VRM）"}
              <Tag color="blue" style={{ marginLeft: 8 }}>
                {proposal.config.avatar?.type === "live2d_template" ? "2D" : "3D · 支持动作/舞蹈"}
              </Tag>
            </Descriptions.Item>
          </Descriptions>
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message="确认前可以修改描述重新生成；也可以保存后进向导逐项微调。"
          />
          <Space style={{ marginTop: 16 }} wrap>
            <Button type="primary" icon={<EditOutlined />} loading={acting} onClick={() => saveAs("studio")}>
              定制专属形象（推荐）
            </Button>
            <Button icon={<CheckOutlined />} loading={acting} onClick={() => saveAs("chat")}>
              直接发布（用模板形象）
            </Button>
            <Button icon={<ReloadOutlined />} onClick={generate}>换一个</Button>
          </Space>
        </Card>
      )}
    </Space>
  );
}
