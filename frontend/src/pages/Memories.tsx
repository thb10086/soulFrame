/** 记忆管理（原型 §3.15）：记忆列表 + 新增 + 删除 + 语义搜索（走 pgvector 真实检索） */
import { DeleteOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Card, Form, Input, List, Modal, Select, Space, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { api, Memory } from "../api/client";

const TYPE_COLOR: Record<string, string> = { fact: "blue", preference: "purple", event: "orange", persona: "green" };

export default function MemoriesPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [results, setResults] = useState<Memory[] | null>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm();

  const load = () =>
    api
      .listMemories()
      .then((d) => setMemories(d.memories))
      .catch((e) => message.error(`加载失败：${e.message}`));

  useEffect(() => {
    load();
  }, []);

  const search = async () => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const d = await api.searchMemories(q.trim());
      setResults(d.results);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSearching(false);
    }
  };

  const add = async () => {
    const v = await form.validateFields();
    try {
      await api.addMemory({ content: v.content, memory_type: v.type, user_id: 1, character_id: 1 });
      message.success("已写入记忆（已向量化）");
      setAdding(false);
      form.resetFields();
      load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const del = async (id: number) => {
    await api.deleteMemory(id).catch((e) => message.error(e.message));
    load();
    if (results) setResults(results.filter((m) => m.id !== id));
  };

  const shown = results ?? memories;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>记忆管理</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>添加记忆</Button>
      </Space>

      <Card style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            placeholder="语义搜索（例如：用户喜欢什么口味？）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPressEnter={search}
            allowClear
          />
          <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={search}>
            搜索
          </Button>
        </Space.Compact>
        {results && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            语义检索结果 {results.length} 条（按相似度排序）·{" "}
            <a onClick={() => { setResults(null); setQ(""); }}>返回全部</a>
          </Typography.Text>
        )}
      </Card>

      <Card>
        <List
          dataSource={shown}
          locale={{ emptyText: "暂无记忆" }}
          renderItem={(m) => (
            <List.Item
              actions={[
                <Button key="d" type="text" danger icon={<DeleteOutlined />} onClick={() => del(m.id)} />,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Tag color={TYPE_COLOR[m.type] ?? "default"}>{m.type}</Tag>
                    {m.similarity != null && (
                      <Tag color="geekblue">相似度 {(m.similarity * 100).toFixed(1)}%</Tag>
                    )}
                  </Space>
                }
                description={<span style={{ color: "#333" }}>{m.content}</span>}
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal title="添加记忆" open={adding} onOk={add} onCancel={() => setAdding(false)} okText="写入" cancelText="取消">
        <Form form={form} layout="vertical" initialValues={{ type: "fact" }}>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: "请输入记忆内容" }]}>
            <Input.TextArea rows={3} placeholder="例如：用户喜欢吃辣，最爱川菜" />
          </Form.Item>
          <Form.Item name="type" label="类型">
            <Select
              options={[
                { value: "fact", label: "事实 fact" },
                { value: "preference", label: "偏好 preference" },
                { value: "event", label: "事件 event" },
                { value: "persona", label: "人设 persona" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
