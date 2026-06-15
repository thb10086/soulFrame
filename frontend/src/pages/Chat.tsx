/**
 * 角色互动页（原型 §3.13）：
 * - 平时：左 3D/2D 舞台 + 右聊天记录，支持文字聊天
 * - 通话：舞台无缝放大为全屏「电话界面」（同一渲染实例不重载模型），
 *   顶部状态/计时、底部实时字幕 + 圆形通话控件（静音/挂断/跳舞/字幕/背景）
 * - 舞台支持鼠标互动：视线跟随、点击/摸头反应、拖拽环绕、滚轮推拉
 */
import {
  ArrowLeftOutlined,
  AudioMutedOutlined,
  AudioOutlined,
  BgColorsOutlined,
  ClearOutlined,
  CustomerServiceOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PhoneOutlined,
  SendOutlined,
  SmileOutlined,
} from "@ant-design/icons";
import { Badge, Button, Input, Popover, Space, Tag, Tooltip, Typography, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, CharacterConfig } from "../api/client";
import { resolveAvatar } from "../avatars";
import AvatarStage, { AvatarHandle } from "../components/AvatarStage";
import ShinyText from "../components/bits/ShinyText";
import { useRealtime } from "../hooks/useRealtime";

const STATUS_TEXT: Record<string, { text: string; color: string }> = {
  connecting: { text: "连接中…", color: "gold" },
  ready: { text: "在线 · 空闲", color: "green" },
  thinking: { text: "思考中…", color: "blue" },
  replying: { text: "回复中…", color: "cyan" },
  closed: { text: "连接断开", color: "red" },
  error: { text: "连接异常", color: "red" },
};

const VAD_TEXT: Record<string, string> = {
  listening: "正在聆听",
  user_speaking: "你正在说话",
  assistant_speaking: "对方正在说话 · 开口可打断",
};

const fmtSec = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** 舞台背景预设（CSS background 值），自定义图片以 url() 形式存储 */
const BG_PRESETS = [
  { id: "nebula", name: "深空", css: "radial-gradient(ellipse at 50% 30%, #1d2240 0%, #10121f 70%)" },
  { id: "dawn", name: "晨曦", css: "linear-gradient(180deg, #2b2a4a 0%, #7a5c8d 55%, #e8927c 100%)" },
  { id: "sakura", name: "樱粉", css: "linear-gradient(180deg, #3a2740 0%, #8d5c7d 55%, #f0a8c0 100%)" },
  { id: "mint", name: "薄荷", css: "linear-gradient(180deg, #16302e 0%, #2e5d57 60%, #7fc8a9 100%)" },
  { id: "sunset", name: "暖阳", css: "linear-gradient(200deg, #241b2f 0%, #5d3a52 50%, #c97b4a 100%)" },
  { id: "studio", name: "纯黑", css: "#0a0b12" },
];
const bgStoreKey = (charId: number) => `soulframe_stage_bg_${charId}`;

/** 通话圆形控制按钮 */
function CallBtn({
  icon, label, onClick, active, danger, size = 52,
}: {
  icon: React.ReactNode; label: string; onClick?: () => void;
  active?: boolean; danger?: boolean; size?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <button
        onClick={onClick}
        className={danger ? "call-pulse-ring" : undefined}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: danger ? "none" : `1px solid ${active ? "#7aa2ff" : "rgba(255,255,255,.22)"}`,
          background: danger
            ? "linear-gradient(135deg, #ff5b5b, #d6304f)"
            : active
              ? "rgba(122,162,255,.28)"
              : "rgba(255,255,255,.08)",
          color: "#fff",
          fontSize: size * 0.38,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          boxShadow: danger ? "0 8px 24px rgba(214,48,79,.45)" : "0 4px 16px rgba(0,0,0,.3)",
          transition: "transform .15s, background .2s",
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.92)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        {icon}
      </button>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,.75)", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>{label}</span>
    </div>
  );
}

export default function ChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const charId = Number(id);
  const stageRef = useRef<AvatarHandle>(null);
  const {
    status, charName, messages, sendText, interrupt, clear, reconnect,
    callState, vadState, callSeconds, muted, startCall, endCall, toggleMute,
  } = useRealtime(charId, {
    onMotion: (m) => stageRef.current?.motion(m.emotion || m.group),
    onLevel: (v) => stageRef.current?.setMouth(Math.min(1, v * 5)),
  });
  const [input, setInput] = useState("");
  const [fallbackName, setFallbackName] = useState(`角色 #${charId}`);
  const [charConfig, setCharConfig] = useState<CharacterConfig | null>(null);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [dancing, setDancing] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [stageBg, setStageBg] = useState(
    () => localStorage.getItem(bgStoreKey(charId)) || BG_PRESETS[0].css
  );
  const [bgUrlInput, setBgUrlInput] = useState("");
  const [bgGenPrompt, setBgGenPrompt] = useState("");
  const [bgGenLoading, setBgGenLoading] = useState(false);
  const [bgLibrary, setBgLibrary] = useState<{ url: string; name: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inCall = callState === "active";
  const callUi = inCall || callState === "connecting";
  const avatar = resolveAvatar(charConfig);

  const applyBg = (css: string) => {
    setStageBg(css);
    localStorage.setItem(bgStoreKey(charId), css);
  };
  const imgCss = (url: string) => `#10121f url(${JSON.stringify(url)}) center / cover no-repeat`;

  useEffect(() => {
    api.listAssets("background").then((r) => setBgLibrary(r.items)).catch(() => {});
  }, []);

  const genBg = async () => {
    const p = bgGenPrompt.trim();
    if (!p) return;
    setBgGenLoading(true);
    try {
      const r = await api.genBackground(p, charId);
      applyBg(imgCss(r.url));
      setBgLibrary((prev) => [{ url: r.url, name: r.url }, ...prev].slice(0, 12));
      message.success(`背景已生成并应用（${r.model}）`);
    } catch (e: any) {
      message.error(e.message || "生成失败");
    } finally {
      setBgGenLoading(false);
    }
  };

  useEffect(() => {
    api.getCharacter(charId)
      .then((c) => {
        setFallbackName(c.name);
        setCharConfig(c.config ?? null);
      })
      .catch(() => {})
      .finally(() => setCfgLoaded(true));
  }, [charId]);

  const toggleDance = () => {
    const next = !dancing;
    setDancing(next);
    stageRef.current?.dance?.(next);
  };

  // 文本回复时用正弦口型；通话中由音频 RMS 直驱（onLevel）
  useEffect(() => {
    stageRef.current?.setSpeaking(!inCall && status === "replying");
  }, [status, inCall]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const doSend = () => {
    const text = input.trim();
    if (!text) return;
    if (status === "closed" || status === "error") {
      message.warning("连接已断开，正在重连");
      reconnect();
      return;
    }
    if (sendText(text)) setInput("");
  };

  const st = STATUS_TEXT[status];
  const name = charName || fallbackName;

  // 通话字幕：取最近一条消息（流式优先）
  const caption = useMemo(() => {
    if (!messages.length) return null;
    const m = messages[messages.length - 1];
    const text = m.text?.trim();
    if (!text) return null;
    return { who: m.role === "user" ? "我" : name, text: text.slice(-90), streaming: m.streaming };
  }, [messages, name]);

  const bgPanel = (
    <div style={{ width: 240 }}>
      <div style={{ marginBottom: 8, fontSize: 12, color: "#888" }}>舞台背景</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {BG_PRESETS.map((b) => (
          <div
            key={b.id}
            onClick={() => applyBg(b.css)}
            style={{
              height: 44,
              borderRadius: 8,
              cursor: "pointer",
              background: b.css,
              border: stageBg === b.css ? "2px solid #5b7cfa" : "1px solid #d9d9d9",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: 11, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,.7)", marginBottom: 2 }}>
              {b.name}
            </span>
          </div>
        ))}
      </div>
      <div style={{ margin: "12px 0 6px", fontSize: 12, color: "#888" }}>AI 生成背景（一句话描述场景）</div>
      <Space.Compact style={{ width: "100%" }}>
        <Input
          size="small"
          placeholder="如：黄昏的海边演唱会舞台"
          value={bgGenPrompt}
          onChange={(e) => setBgGenPrompt(e.target.value)}
          onPressEnter={genBg}
          disabled={bgGenLoading}
        />
        <Button size="small" type="primary" loading={bgGenLoading} onClick={genBg}>
          {bgGenLoading ? "生成中" : "生成"}
        </Button>
      </Space.Compact>
      {bgGenLoading && (
        <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>AI 出图约 10~60 秒，完成后自动应用</div>
      )}
      {bgLibrary.length > 0 && (
        <>
          <div style={{ margin: "10px 0 6px", fontSize: 12, color: "#888" }}>背景库（点击应用）</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {bgLibrary.slice(0, 8).map((b) => (
              <div
                key={b.url}
                onClick={() => applyBg(imgCss(b.url))}
                style={{
                  height: 36,
                  borderRadius: 6,
                  cursor: "pointer",
                  background: `url(${b.url}) center / cover`,
                  border: stageBg.includes(b.url) ? "2px solid #5b7cfa" : "1px solid #d9d9d9",
                }}
              />
            ))}
          </div>
        </>
      )}
      <div style={{ marginTop: 10 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            placeholder="自定义图片 URL"
            value={bgUrlInput}
            onChange={(e) => setBgUrlInput(e.target.value)}
          />
          <Button
            size="small"
            type="primary"
            onClick={() => {
              const u = bgUrlInput.trim();
              if (u) applyBg(imgCss(u));
            }}
          >
            应用
          </Button>
        </Space.Compact>
      </div>
    </div>
  );

  const vadColor = vadState === "user_speaking" ? "#52e09c" : vadState === "assistant_speaking" ? "#5ad7e8" : "#7aa2ff";

  return (
    <div style={{ display: "flex", height: "calc(100vh - 64px)", color: "#dde2ff" }}>
      {/* 左：形象舞台（通话时无缝切换为全屏电话界面，同一渲染实例不重载模型） */}
      <div
        className={callUi ? "call-overlay-enter" : undefined}
        style={
          callUi
            ? {
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                display: "flex",
                flexDirection: "column",
                background: stageBg,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : {
                flex: "0 0 46%",
                display: "flex",
                flexDirection: "column",
                borderRight: "1px solid #23284a",
                background: stageBg,
                backgroundSize: "cover",
                backgroundPosition: "center",
                transition: "background .3s",
              }
        }
      >
        {/* 头部：平时是工具栏，通话中是状态栏 */}
        {!callUi ? (
          <div style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Space>
              <Button type="text" icon={<ArrowLeftOutlined />} style={{ color: "#8a93c4" }} onClick={() => nav("/characters")} />
              <Typography.Text strong style={{ color: "#fff", fontSize: 16 }}>{name}</Typography.Text>
              <Tag style={{ background: "transparent", color: "#8a93c4", borderColor: "#33396b", fontSize: 11 }}>
                {avatar.kind === "vrm" ? "3D · VRM" : avatar.kind === "glb" ? "3D · AI 生成" : "2D · Live2D"}
              </Tag>
              <Badge color={st.color} text={<span style={{ color: "#8a93c4", fontSize: 12 }}>{st.text}</span>} />
            </Space>
            <Space>
              <Popover trigger="click" placement="bottomRight" content={bgPanel}>
                <Tooltip title="设置背景">
                  <Button
                    shape="circle"
                    icon={<BgColorsOutlined />}
                    style={{ background: "transparent", color: "#8a93c4", borderColor: "#33396b" }}
                  />
                </Tooltip>
              </Popover>
              <Tooltip title={dancing ? "停止跳舞" : "跳舞"}>
                <Button
                  shape="circle"
                  icon={<CustomerServiceOutlined />}
                  onClick={toggleDance}
                  style={{
                    background: dancing ? "#5b7cfa" : "transparent",
                    color: dancing ? "#fff" : "#8a93c4",
                    borderColor: dancing ? "#5b7cfa" : "#33396b",
                  }}
                />
              </Tooltip>
              <Tooltip title="随机动作">
                <Button
                  shape="circle"
                  icon={<SmileOutlined />}
                  onClick={() => stageRef.current?.motion()}
                  style={{ background: "transparent", color: "#8a93c4", borderColor: "#33396b" }}
                />
              </Tooltip>
            </Space>
          </div>
        ) : (
          <div style={{ padding: "22px 24px 8px", textAlign: "center", position: "relative", zIndex: 2 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.55)" }}>
              {name}
            </div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              {inCall ? (
                <>
                  <span className={`voice-bars${vadState === "listening" ? " idle" : ""}`} style={{ color: vadColor }}>
                    <i /><i /><i /><i /><i />
                  </span>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,.85)", textShadow: "0 1px 6px rgba(0,0,0,.6)" }}>
                    {VAD_TEXT[vadState]}
                  </span>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,.6)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtSec(callSeconds)}
                  </span>
                </>
              ) : (
                <ShinyText text="正在接通 · 申请麦克风与语音通道…" speed={2.4} color="#9aa4d2" shineColor="#ffffff" />
              )}
            </div>
          </div>
        )}

        {/* 舞台主体 */}
        <div style={{ flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "hidden", minHeight: 0 }}>
          <div style={{ width: "100%", maxWidth: callUi ? 760 : 520, height: "100%" }}>
            {cfgLoaded && (
              <AvatarStage
                ref={stageRef}
                config={charConfig}
                height={callUi ? "100%" : Math.min(window.innerHeight - 220, 600)}
              />
            )}
          </div>
        </div>

        {/* 底部：平时是通话入口，通话中是字幕 + 圆形控件 */}
        {!callUi ? (
          <div
            style={{
              margin: "0 20px 16px",
              padding: "12px 16px",
              borderRadius: 14,
              background: "rgba(255,255,255,.03)",
              border: "1px solid #23284a",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ color: "#8a93c4", fontSize: 13 }}>实时语音通话 · 像打电话一样聊</span>
            <Button
              type="primary"
              shape="round"
              icon={<PhoneOutlined />}
              onClick={startCall}
              style={{ background: "#22b07d", borderColor: "#22b07d" }}
            >
              开始通话
            </Button>
          </div>
        ) : (
          <div style={{ position: "relative", zIndex: 2, padding: "0 24px 26px" }}>
            {captionsOn && caption && (
              <div
                key={`${caption.who}-${caption.text.length > 12 ? caption.text.slice(0, 12) : caption.text}`}
                className="call-caption"
                style={{
                  maxWidth: 680,
                  margin: "0 auto 18px",
                  padding: "10px 18px",
                  borderRadius: 14,
                  background: "rgba(8,10,22,.55)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  textAlign: "center",
                  fontSize: 15,
                  lineHeight: 1.7,
                  color: "#fff",
                }}
              >
                <span style={{ color: caption.who === "我" ? "#8fe3b6" : "#9db4ff", marginRight: 8, fontSize: 13 }}>
                  {caption.who}
                </span>
                {caption.text}
                {caption.streaming && <span className="cursor">▍</span>}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 26 }}>
              <Popover trigger="click" placement="topLeft" content={bgPanel}>
                <div>
                  <CallBtn icon={<BgColorsOutlined />} label="背景" />
                </div>
              </Popover>
              <CallBtn
                icon={<CustomerServiceOutlined />}
                label={dancing ? "停止跳舞" : "跳舞"}
                active={dancing}
                onClick={toggleDance}
              />
              <CallBtn
                icon={muted ? <AudioMutedOutlined /> : <AudioOutlined />}
                label={muted ? "已静音" : "静音"}
                active={muted}
                onClick={toggleMute}
              />
              <CallBtn
                icon={<PhoneOutlined rotate={225} />}
                label="挂断"
                danger
                size={64}
                onClick={() => {
                  endCall();
                  if (dancing) toggleDance();
                }}
              />
              <CallBtn
                icon={<MessageOutlined />}
                label={captionsOn ? "字幕开" : "字幕关"}
                active={captionsOn}
                onClick={() => setCaptionsOn(!captionsOn)}
              />
              <CallBtn icon={<SmileOutlined />} label="互动" onClick={() => stageRef.current?.motion()} />
            </div>
          </div>
        )}
      </div>

      {/* 右：聊天区 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#5d6594", marginTop: 80 }}>
              和「{name}」打个招呼吧～<br />
              <Tag style={{ marginTop: 12, background: "transparent", color: "#5d6594", borderColor: "#33396b" }}>
                支持文字聊天与电话式语音通话 · 鼠标可与角色互动
              </Tag>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
              <div
                style={{
                  maxWidth: "78%",
                  padding: "10px 14px",
                  borderRadius: 12,
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "#5b7cfa" : "#1d2240",
                  color: m.role === "user" ? "#fff" : "#dde2ff",
                  border: m.role === "user" ? "none" : "1px solid #2a3060",
                }}
              >
                {m.viaVoice && <AudioOutlined style={{ marginRight: 6, fontSize: 12, opacity: 0.7 }} />}
                {m.text}
                {m.streaming && <span className="cursor">▍</span>}
                {m.role === "assistant" && m.ttftMs != null && !m.streaming && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#5d6594" }}>首字 {m.ttftMs}ms</div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: "14px 20px", borderTop: "1px solid #23284a" }}>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              size="large"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={doSend}
              disabled={inCall}
              placeholder={inCall ? "通话中…直接开口说话即可" : `对 ${name} 说点什么…（Enter 发送）`}
              style={{ background: "#171a2e", borderColor: "#33396b", color: "#dde2ff" }}
            />
            <Button size="large" type="primary" icon={<SendOutlined />} onClick={doSend}
              disabled={inCall || status === "thinking" || status === "replying"}>
              发送
            </Button>
          </Space.Compact>
          <Space style={{ marginTop: 8 }}>
            <Button size="small" icon={<PauseCircleOutlined />} onClick={interrupt} disabled={status !== "replying" && status !== "thinking"}>
              打断
            </Button>
            <Button size="small" icon={<ClearOutlined />} onClick={clear}>清空对话</Button>
            {(status === "closed" || status === "error") && (
              <Button size="small" type="primary" onClick={reconnect}>重新连接</Button>
            )}
          </Space>
        </div>
      </div>

      <style>{`
        .cursor { animation: blink 1s step-start infinite; }
        @keyframes blink { 50% { opacity: 0; } }
        input::placeholder { color: #5d6594 !important; }
      `}</style>
    </div>
  );
}
