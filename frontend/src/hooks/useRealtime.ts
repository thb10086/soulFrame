/** WebSocket 实时会话 Hook：文本回合 + 电话式语音通话（连续收音，server VAD，可打断）。
 *
 * 通话音频链路：
 *   上行 麦克风 → AudioContext(16k) → AudioWorklet → Int16 二进制帧 → WS
 *   下行 WS 二进制帧(PCM16@24k) → AudioBuffer 队列播放 → Analyser RMS → 口型
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  ttftMs?: number;
  viaVoice?: boolean;
}

export type WsStatus = "connecting" | "ready" | "thinking" | "replying" | "closed" | "error";
export type CallState = "idle" | "connecting" | "active";
export type VadState = "listening" | "user_speaking" | "assistant_speaking";

export interface MotionHint {
  emotion: string;
  group?: string;
}

interface RealtimeOpts {
  onMotion?: (m: MotionHint) => void;
  onLevel?: (v: number) => void;
}

const WORKLET_CODE = `
class PCMRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const i16 = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.buf.push(i16); this.len += i16.length;
    if (this.len >= 1280) { // 80ms @ 16k
      const out = new Int16Array(this.len); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = []; this.len = 0;
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PCMRecorder);
`;

export function useRealtime(characterId: number, opts?: RealtimeOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [status, setStatus] = useState<WsStatus>("connecting");
  const [charName, setCharName] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [callState, setCallState] = useState<CallState>("idle");
  const [vadState, setVadState] = useState<VadState>("listening");
  const [callSeconds, setCallSeconds] = useState(0);
  const [muted, setMuted] = useState(false);

  const sendAtRef = useRef(0);
  const inCallRef = useRef(false);
  const mutedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // 流式合批：把高频 llm.delta 攒到 ~60ms 一次性 setMessages，避免每 token 都
  // 触发整页重渲染 + scrollHeight 布局抖动，把 three.js 渲染循环饿到（角色抽搐主因）
  const streamBufRef = useRef("");
  const ttftRef = useRef<number | undefined>(undefined);
  const flushTimerRef = useRef<number | null>(null);
  const playStartAtRef = useRef(0); // 本段助手语音开始播放的时刻（打断保护期判定用）
  const suppressAudioRef = useRef(false); // 打断后丢弃在途音频帧，直到新回合开始

  const capRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null);
  const playRef = useRef<{
    ctx: AudioContext;
    gain: GainNode;
    analyser: AnalyserNode;
    cursor: number;
    sources: Set<AudioBufferSourceNode>;
    raf: number;
    /** 通话模式：经 <audio srcObject> 出声，使 TTS 纳入浏览器 AEC 回声参考 */
    aecEl: HTMLAudioElement | null;
    msDest: MediaStreamAudioDestinationNode | null;
    /** 最近一次"正在出声"的时刻（门控用，覆盖播放间隙与回声尾巴） */
    lastPlayingAt: number;
  } | null>(null);

  /* ---------- 下行播放 ---------- */

  const ensurePlayer = useCallback(() => {
    if (playRef.current) return playRef.current;
    const ctx = new AudioContext({ sampleRate: 24000 });
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    const p = {
      ctx, gain, analyser, cursor: 0, sources: new Set<AudioBufferSourceNode>(), raf: 0,
      aecEl: null as HTMLAudioElement | null,
      msDest: null as MediaStreamAudioDestinationNode | null,
      lastPlayingAt: 0,
    };
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const d = (data[i] - 128) / 128;
        sum += d * d;
      }
      optsRef.current?.onLevel?.(Math.sqrt(sum / data.length));
      p.raf = requestAnimationFrame(loop);
    };
    p.raf = requestAnimationFrame(loop);
    playRef.current = p;
    return p;
  }, []);

  /**
   * 通话模式出声通道升级：WebAudio 直接 destination 出声不会进入 Chrome 的
   * 回声消除参考信号（echoCancellation 只消除"浏览器知道的"播放源），
   * 改为 analyser → MediaStreamDestination → <audio srcObject> 播放，
   * TTS 即被 AEC 当作回声参考，麦克风里自动减去助手自己的声音。
   * 必须在用户手势（点击开始通话）内调用，否则 el.play() 被自动播放策略拦截。
   */
  const enableAecOutput = useCallback(async () => {
    const p = ensurePlayer();
    if (p.aecEl) return;
    try {
      const msDest = p.ctx.createMediaStreamDestination();
      const el = new Audio();
      el.srcObject = msDest.stream;
      await el.play();
      p.analyser.disconnect();
      p.analyser.connect(msDest);
      p.msDest = msDest;
      p.aecEl = el;
    } catch (e) {
      // 建不起来（罕见）则维持直接出声：通话仍可用，仅回声抑制依赖门控层
      console.warn("AEC 出声通道建立失败，回退直接播放", e);
      try { p.analyser.disconnect(); } catch { /* noop */ }
      p.analyser.connect(p.ctx.destination);
    }
  }, [ensurePlayer]);

  const playChunk = useCallback((ab: ArrayBuffer) => {
    const p = ensurePlayer();
    const i16 = new Int16Array(ab);
    if (!i16.length) return;
    if (p.sources.size === 0) playStartAtRef.current = Date.now();
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const buf = p.ctx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const src = p.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(p.gain);
    const t = Math.max(p.ctx.currentTime + 0.05, p.cursor);
    src.start(t);
    p.cursor = t + buf.duration;
    p.sources.add(src);
    src.onended = () => p.sources.delete(src);
  }, [ensurePlayer]);

  const stopPlayback = useCallback(() => {
    const p = playRef.current;
    if (!p) return;
    for (const s of p.sources) {
      try { s.stop(); } catch {}
    }
    p.sources.clear();
    p.cursor = 0;
  }, []);

  /* ---------- 通话拆除 ---------- */

  const teardownCall = useCallback(() => {
    inCallRef.current = false;
    capRef.current?.stream.getTracks().forEach((t) => t.stop());
    capRef.current?.ctx.close().catch(() => {});
    capRef.current = null;
    if (playRef.current) {
      cancelAnimationFrame(playRef.current.raf);
      stopPlayback();
      if (playRef.current.aecEl) {
        playRef.current.aecEl.pause();
        playRef.current.aecEl.srcObject = null;
      }
      playRef.current.ctx.close().catch(() => {});
      playRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    suppressAudioRef.current = false;
    setCallState("idle");
    setVadState("listening");
    optsRef.current?.onLevel?.(0);
  }, [stopPlayback]);

  /* ---------- 流式合批落地 ---------- */

  /** 把攒下的流式增量一次性写入最后一条助手气泡（不存在则新建），降低重渲染频率。 */
  const flushStream = useCallback(() => {
    const chunk = streamBufRef.current;
    if (!chunk) return;
    streamBufRef.current = "";
    const ttft = ttftRef.current;
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, text: last.text + chunk };
      } else {
        next.push({
          role: "assistant", text: chunk, streaming: true,
          viaVoice: inCallRef.current, ttftMs: ttft,
        });
      }
      return next;
    });
  }, []);

  const endStream = useCallback(() => {
    if (flushTimerRef.current != null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushStream();
    ttftRef.current = undefined;
  }, [flushStream]);

  /* ---------- WS ---------- */

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/realtime`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    setStatus("connecting");

    ws.onopen = () =>
      ws.send(JSON.stringify({ event: "session.start", mode: "text", character_id: characterId }));

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        if (!suppressAudioRef.current) playChunk(ev.data as ArrayBuffer);
        return;
      }
      const msg = JSON.parse(ev.data);
      switch (msg.event) {
        case "session.ready":
          setStatus("ready");
          if (msg.character_name) setCharName(msg.character_name);
          break;
        case "voice.ready":
          setCallState("active");
          setVadState("listening");
          setCallSeconds(0);
          timerRef.current = window.setInterval(() => setCallSeconds((s) => s + 1), 1000);
          break;
        case "voice.stopped":
        case "voice.closed":
          if (inCallRef.current) teardownCall();
          break;
        case "vad.speech_start":
          // 用户开口 → 立即停播实现打断；正在播音时同时拦截在途音频帧
          if ((playRef.current?.sources.size ?? 0) > 0) suppressAudioRef.current = true;
          stopPlayback();
          setVadState("user_speaking");
          break;
        case "vad.speech_stop":
          sendAtRef.current = Date.now();
          ttftRef.current = undefined;
          setVadState("listening");
          break;
        case "asr.final":
          setMessages((prev) => {
            const userMsg: ChatMsg = { role: "user", text: msg.text, viaVoice: true };
            const last = prev[prev.length - 1];
            // 识别结果晚到时插在正在流式输出的助手气泡之前，避免把同一条回复切成多个气泡
            if (last?.role === "assistant" && last.streaming) {
              return [...prev.slice(0, -1), userMsg, last];
            }
            return [...prev, userMsg];
          });
          break;
        case "turn.start":
          suppressAudioRef.current = false; // 新回合音频恢复放行
          setVadState("assistant_speaking");
          if (msg.motion) optsRef.current?.onMotion?.(msg.motion);
          break;
        case "llm.delta":
          setStatus("replying");
          if (ttftRef.current === undefined && sendAtRef.current) {
            ttftRef.current = Date.now() - sendAtRef.current;
          }
          // 合批：攒到缓冲区，最迟 60ms 落地一次（流式仍逐段可见，但重渲染降到 ~16/s）
          streamBufRef.current += msg.text;
          if (flushTimerRef.current == null) {
            flushTimerRef.current = window.setTimeout(() => {
              flushTimerRef.current = null;
              flushStream();
            }, 60);
          }
          break;
        case "interrupted":
        case "turn.end":
          suppressAudioRef.current = false;
          endStream(); // 收尾：清定时器 + 落地残留 token
          setStatus("ready");
          if (inCallRef.current) setVadState("listening");
          if (msg.motion) optsRef.current?.onMotion?.(msg.motion);
          setMessages((prev) =>
            prev.map((m, i) => (i === prev.length - 1 ? { ...m, streaming: false } : m))
          );
          break;
        case "error":
          endStream();
          setStatus("ready");
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: `⚠️ ${msg.message ?? "服务异常"}` },
          ]);
          break;
      }
    };
    ws.onclose = () => {
      setStatus("closed");
      teardownCall();
    };
    ws.onerror = () => setStatus("error");
  }, [characterId, playChunk, stopPlayback, teardownCall, flushStream, endStream]);

  useEffect(() => {
    connect();
    return () => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      wsRef.current?.close();
      teardownCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  /* ---------- 文本回合 ---------- */

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    sendAtRef.current = Date.now();
    ttftRef.current = undefined;
    streamBufRef.current = "";
    setMessages((prev) => [...prev, { role: "user", text }]);
    setStatus("thinking");
    ws.send(JSON.stringify({ event: "text.input", text }));
    return true;
  }, []);

  const interrupt = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ event: "interrupt" }));
    if (!inCallRef.current) setStatus("ready");
    stopPlayback();
  }, [stopPlayback]);

  /* ---------- 通话控制 ---------- */

  const startCall = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setCallState("connecting");
    try {
      // 先建播放/AEC 出声通道（必须在用户手势内，await 权限弹窗后手势可能失效）
      await enableAecOutput();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const srcNode = ctx.createMediaStreamSource(stream);
      const rec = new AudioWorkletNode(ctx, "pcm-recorder");
      // 打断平衡（防回声自触发，同时保留真实打断）：
      // 1) 播音起始 1100ms 保护期内不允许打断（回复开头不被秒切）
      // 2) 需连续 ≥6 帧（约 480ms）高于阈值才判定为"用户真的在说话"，
      //    瞬时声响/AEC 残余回声不打断
      // 3) 判定成立即刻本地停播（不等服务端往返，打断响应快半拍），并回放
      //    滚动预缓冲（覆盖安静起音与音节间隙，插话第一个字不丢）
      // 4) 播放间隙（分句之间/网络抖动）与停播后的回声尾巴按"仍在播音"处理，
      //    否则间隙里漏过去的回声会被 ASR 识别成用户输入 → 自我打断+重复回复
      const BARGE_IN_RMS = 0.085;
      const GATE_OPEN_FRAMES = 6;
      const PLAYBACK_GRACE_MS = 1100;
      const GATE_HOLD_MS = 700;
      const ECHO_TAIL_MS = 450;
      // 滚动预缓冲 ≈1.9s：须覆盖"播音保护期(1100ms)+判定窗(480ms)"，
      // 用户在保护期内就开口时首字才不丢（AEC 已除回声，回放安静段无害）
      const RING_FRAMES = 24;
      const gate = { open: false, count: 0, ring: [] as ArrayBuffer[], lastLoudAt: 0 };
      const frameRms = (ab: ArrayBuffer) => {
        const i16 = new Int16Array(ab);
        let sum = 0;
        const step = 4;
        for (let i = 0; i < i16.length; i += step) {
          const v = i16[i] / 0x8000;
          sum += v * v;
        }
        return Math.sqrt(sum / Math.ceil(i16.length / step));
      };
      rec.port.onmessage = (e) => {
        if (mutedRef.current || !inCallRef.current || ws.readyState !== WebSocket.OPEN) return;
        const ab = e.data as ArrayBuffer;
        const p = playRef.current;
        const nowMs = Date.now();
        if (p && p.sources.size > 0) p.lastPlayingAt = nowMs;
        const assistantPlaying =
          (p?.sources.size ?? 0) > 0 || nowMs - (p?.lastPlayingAt ?? 0) < ECHO_TAIL_MS;
        if (!assistantPlaying) {
          gate.open = false;
          gate.count = 0;
          gate.ring = [];
          ws.send(ab);
          return;
        }
        const now = nowMs;
        const rms = frameRms(ab);
        if (gate.open) {
          ws.send(ab);
          if (rms >= BARGE_IN_RMS) gate.lastLoudAt = now;
          else if (now - gate.lastLoudAt > GATE_HOLD_MS) {
            gate.open = false;
            gate.count = 0;
          }
          return;
        }
        // 滚动预缓冲：始终保留最近若干帧原始音频（含低于阈值的起音/音节间隙），
        // 开闸时整段回放——只回放"连续响帧"会把插话首字吃掉
        gate.ring.push(ab);
        if (gate.ring.length > RING_FRAMES) gate.ring.shift();
        const inGrace = now - playStartAtRef.current < PLAYBACK_GRACE_MS;
        if (!inGrace && rms >= BARGE_IN_RMS) {
          gate.count += 1;
          if (gate.count >= GATE_OPEN_FRAMES) {
            gate.open = true;
            gate.lastLoudAt = now;
            stopPlayback(); // 本地立即静音；取消在途音频等服务端 speech_start 确认
            for (const b of gate.ring) ws.send(b);
            gate.ring = [];
          }
          return;
        }
        gate.count = 0;
        ws.send(new ArrayBuffer(ab.byteLength)); // 回声/底噪替换为等长静音
      };
      srcNode.connect(rec);
      capRef.current = { ctx, stream };
      inCallRef.current = true;
      ws.send(JSON.stringify({ event: "voice.start", character_id: characterId }));
    } catch (e) {
      console.error("通话建立失败", e);
      teardownCall();
    }
  }, [characterId, enableAecOutput, stopPlayback, teardownCall]);

  const endCall = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ event: "voice.stop" }));
    teardownCall();
  }, [teardownCall]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      mutedRef.current = !m;
      return !m;
    });
  }, []);

  const clear = useCallback(() => setMessages([]), []);

  return {
    status, charName, messages, sendText, interrupt, clear, reconnect: connect,
    callState, vadState, callSeconds, muted, startCall, endCall, toggleMute,
  };
}
