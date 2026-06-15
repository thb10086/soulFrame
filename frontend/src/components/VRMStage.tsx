/**
 * VRM 3D 舞台（V1.2 Avatar 主线）：three.js + @pixiv/three-vrm
 * - 口型：文本模式正弦 / 语音模式 RMS 直驱（VRM 标准 viseme `aa`）
 * - 表情：happy/sad/surprised/angry/relaxed 预设
 * - 基础动作：通用动作库（Mixamo manifest 资产优先，UAL 内置兜底）驱动
 *   待机/说话循环，0.35s 交叉淡入；库加载失败回退程序化动作（零资产可用）
 * - 手势：程序化反应层（挥手/点头/摸头/害羞…）叠加在基础动作之上
 * - 舞蹈：VMD 真舞蹈（mocap 级，含配乐）优先；无 VMD 时用动作库舞蹈；再退程序化节拍
 * - 鼠标交互：视线/头部跟随光标、点击身体/摸头有反应（含表情与粒子反馈）、
 *   拖拽环绕视角、滚轮推拉镜头、双击复位
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { applyDancePose, DanceClip, loadVmdClip } from "../lib/vmdDance";
import { loadVrmMotions, type MotionKey } from "../lib/vrmMotions";
import type { AvatarHandle } from "./AvatarStage";

const DANCE_VMD = "/motions/wavefile_v2.vmd";
const DANCE_MUSIC = "/motions/wavefile_short.mp3";
/** 配乐相对动作的延迟（three.js 官方 wavefile 示例 delayTime=160/30s） */
const MUSIC_DELAY_S = 160 / 30;

type GestureName = "wave" | "nod" | "tilt" | "sad" | "surprised" | "pat" | "shy";

const GESTURE_DUR: Record<GestureName, number> = {
  wave: 2.4,
  nod: 1.6,
  tilt: 2.4,
  sad: 2.8,
  surprised: 1.6,
  pat: 2.2,
  shy: 2.0,
};

const EMOTION_TO_GESTURE: Record<string, GestureName> = {
  happy: "wave",
  sad: "sad",
  think: "tilt",
  surprise: "surprised",
  surprised: "surprised",
  talk: "nod",
  neutral: "nod",
  TapBody: "wave",
  Idle: "nod",
};

const EMOTION_EXPR: Partial<Record<GestureName, string>> = {
  wave: "happy",
  sad: "sad",
  surprised: "surprised",
  pat: "happy",
  shy: "happy",
};

const VRMStage = forwardRef<AvatarHandle, { url: string; height?: number | string; interactive?: boolean }>(
  ({ url, height = 480, interactive = true }, ref) => {
    /** canvas 挂载点必须是 React 不管理子节点的独立 div，否则 React 清空条件子节点时会连带移除 canvas */
    const mountRef = useRef<HTMLDivElement>(null);
    const fxRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState("3D 模型加载中…");
    const speakingRef = useRef(false);
    const mouthRef = useRef(0);
    const voiceUntilRef = useRef(0);
    /** soft：服务端情绪提示等被动触发，只允许头部/表情级微动作（不播全身片段） */
    const gestureRef = useRef<{ name: GestureName; t0: number; soft?: boolean } | null>(null);
    const danceRef = useRef(false);
    const danceEnvRef = useRef(0); // 舞蹈淡入淡出包络
    const danceClipRef = useRef<DanceClip | null>(null);
    const danceLoadingRef = useRef(false);
    const musicRef = useRef<HTMLAudioElement | null>(null);
    const musicTimerRef = useRef<number | null>(null);

    const stopMusic = () => {
      if (musicTimerRef.current) {
        window.clearTimeout(musicTimerRef.current);
        musicTimerRef.current = null;
      }
      musicRef.current?.pause();
      if (musicRef.current) musicRef.current.currentTime = 0;
    };

    /** 点击反馈粒子（❤/✨ 从点击处飘起） */
    const burst = (x: number, y: number, glyphs: string[]) => {
      const layer = fxRef.current;
      if (!layer) return;
      const n = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const s = document.createElement("span");
        s.className = "vrm-fx-burst";
        s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
        const dist = 46 + Math.random() * 60;
        s.style.left = `${x}px`;
        s.style.top = `${y}px`;
        s.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
        s.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
        s.style.fontSize = `${13 + Math.random() * 10}px`;
        s.style.animationDelay = `${Math.random() * 0.12}s`;
        s.addEventListener("animationend", () => s.remove());
        layer.appendChild(s);
      }
    };

    useImperativeHandle(ref, () => ({
      setSpeaking: (on) => {
        speakingRef.current = on;
      },
      setMouth: (v) => {
        mouthRef.current = Math.max(mouthRef.current, Math.min(1, v));
        // 语音模式没有 setSpeaking 信号，用音量活动维持"说话中"状态驱动说话手势；
        // 保持期须跨过 TTS 分句间隙，太短会 talk/idle 反复交叉淡入（姿态泵动）
        if (v > 0.06) voiceUntilRef.current = performance.now() + 1100;
      },
      motion: (hint?: string) => {
        // 被动 soft 手势（服务端回合情绪，每回合都触发）：若上一个还没演完就别覆盖，
        // 否则手势包络从高位瞬间归零 → 头部/身体猛地一抽（用户感知的"突然抽搐"）。
        // 用户主动触发（无 hint）则始终响应。
        if (hint && gestureRef.current) {
          const g = gestureRef.current;
          const e = (performance.now() / 1000 - g.t0) / GESTURE_DUR[g.name];
          if (e < 0.9) return;
        }
        const name =
          (hint && EMOTION_TO_GESTURE[hint]) ||
          (["wave", "nod", "tilt", "surprised"] as GestureName[])[Math.floor(Math.random() * 4)];
        // 带 hint = 服务端回合情绪等被动来源：每回合都会触发，若播全身
        // 片段会变成"动不动抽一下"；全身 react 只留给用户主动点击
        gestureRef.current = { name, t0: performance.now() / 1000, soft: !!hint };
      },
      dance: (on) => {
        danceRef.current = on;
        if (on) {
          if (!danceClipRef.current && !danceLoadingRef.current) {
            danceLoadingRef.current = true;
            loadVmdClip(DANCE_VMD)
              .then((c) => {
                danceClipRef.current = c;
              })
              .catch((e) => console.warn("VMD 舞蹈加载失败，退回程序化舞蹈：", e));
          }
          if (!musicRef.current) {
            musicRef.current = new Audio(DANCE_MUSIC);
            musicRef.current.loop = true;
            musicRef.current.volume = 0.45;
          }
          musicTimerRef.current = window.setTimeout(
            () => musicRef.current?.play().catch(() => {}),
            MUSIC_DELAY_S * 1000
          );
        } else {
          stopMusic();
        }
      },
    }));

    useEffect(() => {
      const wrap = mountRef.current!;
      let disposed = false;
      let vrm: VRM | null = null;

      // 尺寸跟随容器（全屏通话/布局变化时只 resize 不重建，模型不重载）
      const sizeOf = () => ({ w: wrap.clientWidth || 1, h: wrap.clientHeight || 1 });
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      // 像素率封顶 2：3x 屏全屏通话时渲染压力翻倍以上，掉帧比锐度更伤体验
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(sizeOf().w, sizeOf().h);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      wrap.appendChild(renderer.domElement);
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      if (interactive) canvas.style.cursor = "grab";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(27, sizeOf().w / sizeOf().h, 0.1, 30);
      const lookTarget = new THREE.Vector3(0, 1.1, 0);
      const dir = new THREE.DirectionalLight(0xffffff, Math.PI * 0.85);
      dir.position.set(1, 1.8, 1.5);
      const hemi = new THREE.HemisphereLight(0xfdf4ff, 0x6470a8, 0.7);
      scene.add(dir, hemi, new THREE.AmbientLight(0xffffff, 0.55));

      // 视线目标：默认看镜头，光标进入舞台后看向光标
      const gazeTarget = new THREE.Object3D();
      scene.add(gazeTarget);

      const ro = new ResizeObserver(() => {
        const { w, h } = sizeOf();
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      ro.observe(wrap);

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));

      // 骨骼基准姿态与程序化动画状态
      let bones: Record<string, THREE.Object3D | null> = {};
      let basePose: Record<string, THREE.Euler> = {};
      const hipsBasePos = new THREE.Vector3();
      let nextBlink = 1.5;
      let blinkT = -1;
      let danceStartT = -1; // 舞蹈起始时刻（clock 时间轴），切换沿在循环里检测
      // VRM0 模型原始朝向与 VRM1 相反，归一化骨骼的 X/Z 轴向旋转方向随之翻转
      let F = 1;
      let headY = 1.3;
      const clock = new THREE.Clock();

      // —— 通用动作库（Mixamo/UAL → VRM humanoid 重定向）——
      // mixer 驱动基础姿态（待机/说话/舞蹈），程序化手势/视线作为增量层叠加。
      // 注意：clip 驱动的骨骼上不可再做手臂欧拉叠加（会叠出怪姿态），
      // 手臂类手势在 mixer 模式下改用 react 片段 one-shot。
      let mixer: THREE.AnimationMixer | null = null;
      const actions: Partial<Record<MotionKey, THREE.AnimationAction>> = {};
      let currentKey: MotionKey | null = null;
      let oneShot: THREE.AnimationAction | null = null;
      const FADE = 0.35;
      const playAction = (key: MotionKey) => {
        const next = actions[key];
        if (!next || currentKey === key) return;
        const prev = currentKey ? actions[currentKey] : null;
        next.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(prev ? FADE : 0.12).play();
        prev?.fadeOut(FADE);
        currentKey = key;
      };
      const playOneShot = () => {
        const a = actions.react;
        if (!a || !mixer || oneShot) return;
        const base = currentKey ? actions[currentKey] : null;
        a.reset().setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = false;
        a.fadeIn(0.22).play();
        base?.fadeOut(0.22);
        oneShot = a;
      };

      // —— 相机环绕参数（拖拽/滚轮/双击交互） ——
      const orbit = { az: 0, el: 0, dist: 3.5, baseDist: 3.5, baseY: 0.78 };
      const placeCamera = () => {
        const c = Math.cos(orbit.el);
        camera.position.set(
          lookTarget.x + orbit.dist * Math.sin(orbit.az) * c,
          orbit.baseY + orbit.dist * Math.sin(orbit.el) * 0.6,
          lookTarget.z + orbit.dist * Math.cos(orbit.az) * c
        );
        camera.lookAt(lookTarget);
      };

      // —— 指针状态（视线跟随 + 点击命中 + 拖拽轨道） ——
      const ndc = new THREE.Vector2(0, 0);
      let pointerInside = false;
      let pointerDown = false;
      let dragging = false;
      let downX = 0, downY = 0, lastX = 0, lastY = 0;
      const raycaster = new THREE.Raycaster();
      // 平滑后的头部跟随角
      let followYaw = 0, followPitch = 0;
      let patHintT = -1; // 摸头时刻（驱动 relaxed 表情余韵）

      const toNdc = (e: PointerEvent | MouseEvent) => {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
        return { px: e.clientX - r.left, py: e.clientY - r.top };
      };

      const onPointerMove = (e: PointerEvent) => {
        toNdc(e);
        pointerInside = true;
        if (pointerDown) {
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) dragging = true;
          if (dragging) {
            orbit.az = THREE.MathUtils.clamp(orbit.az - dx * 0.0055, -1.15, 1.15);
            orbit.el = THREE.MathUtils.clamp(orbit.el + dy * 0.004, -0.18, 0.55);
            placeCamera();
          }
        }
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onPointerDown = (e: PointerEvent) => {
        pointerDown = true;
        dragging = false;
        downX = lastX = e.clientX;
        downY = lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
        if (interactive) canvas.style.cursor = "grabbing";
      };
      const onPointerUp = (e: PointerEvent) => {
        canvas.releasePointerCapture?.(e.pointerId);
        if (interactive) canvas.style.cursor = "grab";
        const wasDrag = dragging;
        pointerDown = false;
        dragging = false;
        if (wasDrag || !vrm) return;
        // 点击命中：摸头 / 戳身体
        const { px, py } = toNdc(e);
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObject(vrm.scene, true);
        if (!hits.length) return;
        const hitY = hits[0].point.y;
        const headWorld = new THREE.Vector3();
        bones.head?.getWorldPosition(headWorld);
        if (hitY > headWorld.y - 0.09) {
          // 摸头：眯眼微笑 + 歪头蹭一下 + 爱心
          gestureRef.current = { name: "pat", t0: performance.now() / 1000 };
          patHintT = performance.now() / 1000;
          burst(px, py, ["💗", "💕", "✨"]);
        } else {
          // 戳身体：惊讶/害羞二选一 + 星星
          gestureRef.current = {
            name: Math.random() < 0.5 ? "surprised" : "shy",
            t0: performance.now() / 1000,
          };
          burst(px, py, ["✨", "⭐", "💫"]);
        }
      };
      const onPointerLeave = () => {
        pointerInside = false;
        pointerDown = false;
        dragging = false;
        if (interactive) canvas.style.cursor = "grab";
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        orbit.dist = THREE.MathUtils.clamp(
          orbit.dist * (1 + Math.sign(e.deltaY) * 0.07),
          orbit.baseDist * 0.45,
          orbit.baseDist * 1.7
        );
        placeCamera();
      };
      const onDblClick = () => {
        orbit.az = 0;
        orbit.el = 0;
        orbit.dist = orbit.baseDist;
        placeCamera();
      };

      if (interactive) {
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointerleave", onPointerLeave);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("dblclick", onDblClick);
      }

      loader.load(
        url,
        (gltf) => {
          if (disposed) return;
          const v = gltf.userData.vrm as VRM;
          if (!v) {
            setStatus("文件不是有效的 VRM 模型");
            return;
          }
          try {
            VRMUtils.removeUnnecessaryVertices(gltf.scene);
            VRMUtils.combineSkeletons(gltf.scene);
          } catch {}
          VRMUtils.rotateVRM0(v); // VRM0 转向面对相机，VRM1 无操作
          F = (v.meta as any)?.metaVersion === "0" ? -1 : 1;
          vrm = v;
          scene.add(v.scene);
          if (v.lookAt) v.lookAt.target = gazeTarget;

          for (const n of [
            "hips", "spine", "chest", "neck", "head",
            "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
            "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
            "leftUpperLeg", "leftLowerLeg", "leftFoot",
            "rightUpperLeg", "rightLowerLeg", "rightFoot",
          ]) {
            bones[n] = v.humanoid?.getNormalizedBoneNode(n as any) ?? null;
          }
          // 放下手臂（VRM 默认 T-pose），小臂略内收更自然
          if (bones.leftUpperArm) bones.leftUpperArm.rotation.z = -1.25 * F;
          if (bones.rightUpperArm) bones.rightUpperArm.rotation.z = 1.25 * F;
          if (bones.leftLowerArm) bones.leftLowerArm.rotation.z = -0.12 * F;
          if (bones.rightLowerArm) bones.rightLowerArm.rotation.z = 0.12 * F;
          for (const [n, b] of Object.entries(bones)) {
            if (b) basePose[n] = b.rotation.clone();
          }
          if (bones.hips) hipsBasePos.copy(bones.hips.position);

          // 全身取景：按头部骨骼高度估算身高，镜头后移到能看到头顶~脚底（留 8% 余量）
          headY = (() => {
            const p = new THREE.Vector3();
            bones.head?.getWorldPosition(p);
            return p.y || 1.3;
          })();
          orbit.baseDist = headY * 2.7;
          orbit.dist = orbit.baseDist;
          orbit.baseY = headY * 0.6;
          lookTarget.set(0, headY * 0.58, 0);
          gazeTarget.position.set(0, headY * 0.92, orbit.baseDist);
          placeCamera();
          setStatus("");

          // 通用动作库：异步加载重定向，就绪后接管基础姿态（失败保持程序化）
          loadVrmMotions(v)
            .then((set) => {
              if (disposed || !set || vrm !== v) return;
              mixer = new THREE.AnimationMixer(v.scene);
              for (const [key, clip] of Object.entries(set.clips)) {
                actions[key as MotionKey] = mixer.clipAction(clip);
              }
              // react one-shot 播完淡回基础循环。
              // 不 reset()：基础循环时间归零会让待机从头开始（衔接跳变），
              // fadeOut 期间 action 仍在走时间，直接 fadeIn 即相位连续
              mixer.addEventListener("finished", (ev) => {
                if (ev.action !== oneShot) return;
                oneShot = null;
                ev.action.fadeOut(0.25);
                const base = currentKey ? actions[currentKey] : null;
                base?.fadeIn(0.25).play();
              });
              playAction("idle");
            })
            .catch(() => {});
        },
        undefined,
        (e) => setStatus(`模型加载失败：${(e as any)?.message ?? e}`)
      );

      renderer.setAnimationLoop(() => {
        // 钳制帧间隔：开始通话（麦克风初始化+画布全屏重建）、切标签页、GC
        // 都会让单帧 delta 飙到几百毫秒——mixer 跳帧 + 弹簧骨物理过冲振荡，
        // 表现为角色"突然抽搐"。钳到 50ms 后卡顿只表现为动作瞬时放慢。
        // t 保持真实时间轴：VMD 舞蹈据此与配乐对齐，跳帧后仍同步。
        const delta = Math.min(clock.getDelta(), 0.05);
        const t = clock.elapsedTime;
        if (vrm) {
          const ex = vrm.expressionManager;
          const talking = speakingRef.current || performance.now() < voiceUntilRef.current;

          if (mixer) {
            // —— 动作库模式：mixer 驱动基础姿态，手势/视线作为增量层叠加 ——
            // 先复位到基准立姿：clip 未覆盖的骨骼（部分动作缺 head 等轨道）
            // 不复位的话，下方加性层会逐帧累积成鞠躬/扭头
            for (const [n, b] of Object.entries(bones)) {
              if (b && basePose[n]) b.rotation.copy(basePose[n]);
            }
            if (bones.hips) bones.hips.position.copy(hipsBasePos);
            // 舞蹈优先级：VMD（独立采样）> 动作库 dance；VMD 生效时 mixer 退回 idle
            const vmdActive = danceRef.current && !!danceClipRef.current;
            const want: MotionKey =
              danceRef.current && !vmdActive && actions.dance
                ? "dance"
                : !vmdActive && talking && actions.talk
                  ? "talk"
                  : "idle";
            playAction(want);
            mixer.update(delta);
          } else {
            // —— 程序化模式（动作库未就绪/加载失败）：重置基准再叠加各层 ——
            for (const [n, b] of Object.entries(bones)) {
              if (b && basePose[n]) b.rotation.copy(basePose[n]);
            }
            if (bones.hips) bones.hips.position.copy(hipsBasePos);

            // 待机层：呼吸 + 轻微摇摆
            bones.spine?.rotation && (bones.spine.rotation.x += 0.02 * Math.sin(t * 1.7) * F);
            bones.chest?.rotation && (bones.chest.rotation.z += 0.012 * Math.sin(t * 0.8) * F);
            bones.head?.rotation && (bones.head.rotation.y += 0.04 * Math.sin(t * 0.5));
          }

          // —— 视线/头部跟随光标层 ——
          if (interactive) {
            if (pointerInside) {
              raycaster.setFromCamera(ndc, camera);
              const p = raycaster.ray.origin
                .clone()
                .add(raycaster.ray.direction.clone().multiplyScalar(orbit.dist * 0.62));
              gazeTarget.position.lerp(p, Math.min(1, delta * 10));
            } else {
              gazeTarget.position.lerp(
                camera.position.clone().setY(headY * 0.92),
                Math.min(1, delta * 4)
              );
            }
            // 头部轻量跟随（眼睛由 vrm.lookAt 负责，头补 40% 角度更鲜活）
            const headWorld = new THREE.Vector3();
            bones.head?.getWorldPosition(headWorld);
            const d = gazeTarget.position.clone().sub(headWorld);
            const horiz = Math.max(0.3, Math.hypot(d.x, d.z));
            const wantYaw = THREE.MathUtils.clamp(Math.atan2(d.x, Math.abs(d.z)), -0.55, 0.55);
            const wantPitch = THREE.MathUtils.clamp(-Math.atan2(d.y, horiz), -0.32, 0.36);
            const damp = danceEnvRef.current > 0.05 ? 0 : Math.min(1, delta * 7); // 跳舞时不抢头
            followYaw += (wantYaw - followYaw) * Math.max(damp, Math.min(1, delta * 3));
            followPitch += (wantPitch - followPitch) * Math.max(damp, Math.min(1, delta * 3));
            if (bones.head) {
              bones.head.rotation.y += followYaw * 0.42;
              bones.head.rotation.x += followPitch * 0.34 * F;
            }
            if (bones.neck) bones.neck.rotation.y += followYaw * 0.22;
          }

          // 表情：先归零情绪预设，由手势/舞蹈层赋值
          for (const e of ["happy", "sad", "surprised", "angry", "relaxed"]) ex?.setValue(e, 0);

          // 摸头余韵：眯眼放松表情慢慢消退
          if (patHintT >= 0) {
            const pe = (performance.now() / 1000 - patHintT) / 2.6;
            if (pe >= 1) patHintT = -1;
            else ex?.setValue("relaxed", 0.85 * (1 - pe));
          }

          // 手势层
          const g = gestureRef.current;
          if (g) {
            const e = (performance.now() / 1000 - g.t0) / GESTURE_DUR[g.name];
            if (e >= 1) {
              gestureRef.current = null;
            } else {
              const env = Math.sin(Math.PI * e);
              const expr = EMOTION_EXPR[g.name];
              if (expr) ex?.setValue(expr, env);
              switch (g.name) {
                case "wave":
                  // clip 模式下手臂由动作库驱动，欧拉叠加会叠出怪姿态 →
                  // 用户主动触发且有 react 片段时放片段，否则退化为头部小幅点头
                  // （被动 soft 手势不播全身片段，避免每回合"抽一下"）
                  if (mixer) {
                    if (!g.soft && actions.react) {
                      if (e < 0.1) playOneShot();
                    } else if (bones.head) {
                      bones.head.rotation.x += 0.16 * Math.sin(e * Math.PI * 3) * env * F;
                    }
                  } else {
                    if (bones.rightUpperArm) bones.rightUpperArm.rotation.z -= 1.85 * env * F;
                    if (bones.rightLowerArm) bones.rightLowerArm.rotation.z += Math.sin(t * 12) * 0.45 * env * F;
                  }
                  break;
                case "nod":
                  if (bones.head) bones.head.rotation.x += 0.2 * Math.sin(e * Math.PI * 4) * env * F;
                  break;
                case "tilt":
                  if (bones.head) {
                    bones.head.rotation.z += 0.26 * env * F;
                    bones.head.rotation.x += 0.06 * env * F;
                  }
                  break;
                case "sad":
                  if (bones.head) bones.head.rotation.x += 0.3 * env * F;
                  if (bones.spine) bones.spine.rotation.x += 0.07 * env * F;
                  break;
                case "surprised":
                  if (bones.head) bones.head.rotation.x -= 0.14 * env * F;
                  if (bones.hips) bones.hips.position.y += 0.03 * Math.sin(Math.min(e * 2, 1) * Math.PI);
                  break;
                case "pat":
                  // 被摸头：歪头眯眼往手心蹭
                  if (bones.head) {
                    bones.head.rotation.z += 0.3 * env * F;
                    bones.head.rotation.x += 0.1 * env * F;
                  }
                  if (bones.chest) bones.chest.rotation.z += 0.04 * env * F;
                  break;
                case "shy":
                  // 被戳：缩肩 + 双手收胸前（clip 模式下手臂交给 react 片段）
                  if (!mixer) {
                    if (bones.leftUpperArm) bones.leftUpperArm.rotation.z += 0.5 * env * F;
                    if (bones.rightUpperArm) bones.rightUpperArm.rotation.z -= 0.5 * env * F;
                    if (bones.leftLowerArm) bones.leftLowerArm.rotation.y += 1.15 * env;
                    if (bones.rightLowerArm) bones.rightLowerArm.rotation.y -= 1.15 * env;
                  } else if (e < 0.1) {
                    playOneShot();
                  }
                  if (bones.spine) bones.spine.rotation.x += 0.06 * env * F;
                  if (bones.head) bones.head.rotation.x += 0.12 * env * F;
                  break;
              }
            }
          }

          // 舞蹈层：VMD 真舞蹈（mocap）优先，未加载完成时退回程序化节拍
          if (danceRef.current && danceStartT < 0) danceStartT = t; // 起始沿
          if (!danceRef.current) danceStartT = -1;
          danceEnvRef.current += ((danceRef.current ? 1 : 0) - danceEnvRef.current) * Math.min(1, delta * 3);
          const dEnv = danceEnvRef.current;
          if (dEnv > 0.01) {
            const clip = danceClipRef.current;
            if (clip && danceStartT >= 0) {
              applyDancePose(clip, t - danceStartT, bones, hipsBasePos, dEnv, F === -1);
              ex?.setValue("happy", Math.max(0.45 * dEnv, ex.getValue("happy") ?? 0));
            } else if (mixer && actions.dance) {
              // 动作库舞蹈由 mixer 驱动（上方状态机已切换），这里只补表情
              ex?.setValue("happy", Math.max(0.5 * dEnv, ex.getValue("happy") ?? 0));
            } else {
              const tb = t * Math.PI * 2 * (100 / 60); // 100 BPM
              if (bones.hips) {
                bones.hips.position.y += (-0.02 + 0.05 * Math.abs(Math.sin(tb))) * dEnv;
                bones.hips.rotation.y += 0.16 * Math.sin(tb * 0.5) * dEnv;
              }
              if (bones.spine) bones.spine.rotation.z += 0.05 * Math.sin(tb * 0.5) * dEnv * F;
              if (bones.leftUpperArm) {
                bones.leftUpperArm.rotation.x += 0.5 * Math.sin(tb) * dEnv * F;
                bones.leftUpperArm.rotation.z += 0.4 * (0.5 + 0.5 * Math.sin(tb)) * dEnv * F;
              }
              if (bones.rightUpperArm) {
                bones.rightUpperArm.rotation.x += 0.5 * Math.sin(tb + Math.PI) * dEnv * F;
                bones.rightUpperArm.rotation.z -= 0.4 * (0.5 + 0.5 * Math.sin(tb + Math.PI)) * dEnv * F;
              }
              if (bones.head) bones.head.rotation.x += 0.06 * Math.sin(tb * 2) * dEnv * F;
              ex?.setValue("happy", Math.max(0.55 * dEnv, ex.getValue("happy") ?? 0));
            }
          }

          // 眨眼
          if (t > nextBlink) {
            blinkT = t;
            nextBlink = t + 2.2 + Math.random() * 3;
          }
          if (blinkT >= 0) {
            const be = (t - blinkT) / 0.14;
            ex?.setValue("blink", be >= 1 ? 0 : Math.sin(Math.PI * Math.min(be, 1)));
            if (be >= 1) blinkT = -1;
          }

          // 口型：正弦（文本回复）与 RMS（语音）取大
          const sine = speakingRef.current
            ? 0.16 + 0.5 * Math.abs(Math.sin(t * 11)) + 0.16 * Math.abs(Math.sin(t * 23))
            : 0;
          ex?.setValue("aa", Math.min(1, Math.max(sine, mouthRef.current)));
          mouthRef.current *= 0.82;

          vrm.update(delta);
        }
        renderer.render(scene, camera);
      });

      return () => {
        disposed = true;
        ro.disconnect();
        renderer.setAnimationLoop(null);
        mixer?.stopAllAction();
        stopMusic();
        if (interactive) {
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointerleave", onPointerLeave);
          canvas.removeEventListener("wheel", onWheel);
          canvas.removeEventListener("dblclick", onDblClick);
        }
        if (vrm) {
          scene.remove(vrm.scene);
          VRMUtils.deepDispose(vrm.scene);
        }
        renderer.dispose();
        wrap.removeChild(renderer.domElement);
      };
    }, [url, interactive]);

    return (
      <div style={{ position: "relative", width: "100%", height, transition: "height .3s" }}>
        <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
        <div ref={fxRef} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }} />
        {status && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#8a93c4",
              fontSize: 13,
            }}
          >
            {status}
          </div>
        )}
      </div>
    );
  }
);

export default VRMStage;
