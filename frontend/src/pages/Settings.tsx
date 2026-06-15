/** 个人设置：系统状态 + Embedding 提供方热切换（本地模型 ⇄ 网关） */
import { Alert, Button, Card, Descriptions, Radio, Space, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function SettingsPage() {
  const [health, setHealth] = useState<any>(null);
  const [provider, setProvider] = useState<any>(null);
  const [switching, setSwitching] = useState(false);

  const load = () => {
    api.health().then(setHealth).catch(() => setHealth({ status: "down" }));
    api.embeddingProvider().then(setProvider).catch(() => {});
  };

  useEffect(() => {
    load();
  }, []);

  const doSwitch = async (kind: string) => {
    setSwitching(true);
    try {
      const r = await api.switchEmbedding(kind);
      message.success(`已切换至 ${r.provider?.kind ?? kind}`);
      load();
    } catch (e: any) {
      message.error(`切换失败：${e.message}`);
      load();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <Typography.Title level={4}>个人设置</Typography.Title>

      <Card title="系统状态" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="后端服务">
            <Tag color={health ? "green" : "red"}>{health ? "运行中" : "不可达"}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="数据库">
            <Tag color={health?.db === "up" ? "green" : "red"}>{health?.db ?? "-"}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="AI 网关">
            <Tag color="blue">{health?.gateway ?? "agentllm.linkyun.co"}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Embedding">
            <Tag color="purple">
              {health?.embedding?.model ?? "-"} {health?.embedding?.ready ? "✓" : ""}
            </Tag>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="向量化（Embedding）提供方">
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Alert
            type="info"
            showIcon
            message="本地模型开箱即用；网关模型上线后可热切换。维度变化时需对存量记忆重建索引。"
          />
          <Radio.Group
            value={provider?.kind}
            disabled={switching}
            onChange={(e) => doSwitch(e.target.value)}
          >
            <Radio.Button value="local">本地 bge-small-zh-v1.5（512维）</Radio.Button>
            <Radio.Button value="gateway">AgentLLM 网关 /v1/embeddings</Radio.Button>
          </Radio.Group>
          {provider && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前：{provider.kind} · {provider.model} · {provider.dim ?? "?"} 维
            </Typography.Text>
          )}
          <Button
            onClick={async () => {
              try {
                const r = await api.reindexMemories();
                message.success(`重建完成：${JSON.stringify(r)}`);
              } catch (e: any) {
                message.error(e.message);
              }
            }}
          >
            对存量记忆重建向量索引
          </Button>
        </Space>
      </Card>
    </div>
  );
}
