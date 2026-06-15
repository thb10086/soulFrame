/**
 * GLB 舞台：渲染 AI 生成的绑骨模型（Meshy/Tripo 产出）。
 *
 * 动作体系（双层，设计见《Meshy接入与角色创建策略设计》§2.2）：
 * 1. Meshy 官方烘焙动画优先（animUrls：与绑骨模型同骨架的带皮 GLB，
 *    抽 clip 按骨骼名直接绑定播放，零重定向误差）；
 * 2. 本地 CC0 动作库（UAL）重定向补缺（talk 等未烘焙动作 / Tripo 与旧资产全量），
 *    拓扑推断映射兼容非标准骨架；再退内嵌动画或静态展示。
 * 站立/说话/舞蹈/互动四态状态机，0.35s 交叉淡入。
 * 表情口型 blendshape 待 GLB→VRM 转换（路线图 P4）后统一。
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { forwardCorrection, retargetMotionsFor, type MotionKey } from "../lib/glbMotions";
import type { AvatarHandle } from "./AvatarStage";

const FADE = 0.35;
const MOTION_KEYS: MotionKey[] = ["idle", "talk", "dance", "react"];

/** 软接触阴影：径向渐变圆盘，把角色"锚"在地面上 */
function makeContactShadow(radius: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  g.addColorStop(0, "rgba(8,10,30,0.42)");
  g.addColorStop(0.55, "rgba(8,10,30,0.18)");
  g.addColorStop(1, "rgba(8,10,30,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.005;
  mesh.renderOrder = -1;
  return mesh;
}

const GLBStage = forwardRef<
  AvatarHandle,
  {
    url: string;
    height?: number | string;
    interactive?: boolean;
    /** Meshy 官方烘焙动画（同骨架带皮 GLB）：key → 文件地址 */
    animUrls?: Partial<Record<MotionKey, string>>;
  }
>(
  ({ url, height = 480, interactive = true, animUrls }, ref) => {
    // 对象按内容参与 effect 依赖（父组件每次渲染都会重建对象，避免误重载模型）
    const animKey = useMemo(() => JSON.stringify(animUrls ?? {}), [animUrls]);
    const mountRef = useRef<HTMLDivElement>(null);
    const fxRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState("3D 模型加载中…");
    // 驱动状态（跨重渲染存活）
    const speakRef = useRef(false);
    const voiceUntilRef = useRef(0);
    const danceRef = useRef(false);
    const reactRef = useRef(false);
    const nodRef = useRef(0);
    const bounceRef = useRef(-1);
    const reactOnceRef = useRef<() => void>(() => {});

    useImperativeHandle(ref, () => ({
      setSpeaking: (on) => {
        speakRef.current = on;
      },
      // 语音 RMS：有声段视作"在说话"，600ms 静音后回到 idle
      setMouth: (v) => {
        if (v > 0.06) voiceUntilRef.current = performance.now() + 600;
      },
      motion: () => {
        reactOnceRef.current();
        nodRef.current = performance.now() / 1000;
      },
      dance: (on) => {
        danceRef.current = on;
      },
    }));

    useEffect(() => {
      const wrap = mountRef.current!;
      let disposed = false;
      let root: THREE.Object3D | null = null;
      let mixer: THREE.AnimationMixer | null = null;
      // 动作库模式
      let actions: Partial<Record<MotionKey, THREE.AnimationAction>> = {};
      let current: MotionKey | null = null;
      let regroundAt = 0;
      let groundFix = { from: 0, to: 0, t: 1 };
      // 旧模式（内嵌动画 GLB）
      let legacyClips: THREE.AnimationClip[] = [];
      let activeClip = 0;

      const sizeOf = () => ({ w: wrap.clientWidth || 1, h: wrap.clientHeight || 1 });
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(sizeOf().w, sizeOf().h);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      wrap.appendChild(renderer.domElement);
      const canvas = renderer.domElement;
      canvas.style.touchAction = "none";
      if (interactive) canvas.style.cursor = "grab";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, sizeOf().w / sizeOf().h, 0.1, 100);
      const dir = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
      dir.position.set(1, 2, 2);
      scene.add(dir, new THREE.HemisphereLight(0xfdf4ff, 0x6470a8, 0.8), new THREE.AmbientLight(0xffffff, 0.5));

      const ro = new ResizeObserver(() => {
        const { w, h } = sizeOf();
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      ro.observe(wrap);

      // 相机推拉与模型拖转
      const view = { dist: 2.2, baseDist: 2.2, h: 1 };
      const placeCamera = () => {
        camera.position.set(0, view.h * 0.55, view.dist);
        camera.lookAt(0, view.h * 0.5, 0);
      };

      // ---------- 动作状态机 ----------
      const playAction = (key: MotionKey, once = false) => {
        const next = actions[key];
        if (!next || current === key) return;
        const prev = current ? actions[current] : undefined;
        next.reset();
        if (once) {
          next.setLoop(THREE.LoopOnce, 1);
          next.clampWhenFinished = true;
        } else {
          next.setLoop(THREE.LoopRepeat, Infinity);
        }
        if (prev) {
          prev.crossFadeTo(next.play(), FADE, true);
        } else {
          next.play();
        }
        current = key;
        // 动作姿态差异可能改变最低点：延迟重新贴地（平滑过渡）
        regroundAt = performance.now() + 250;
      };

      const desiredKey = (): MotionKey => {
        if (danceRef.current && actions.dance) return "dance";
        if (reactRef.current && actions.react) return "react";
        const talking = speakRef.current || performance.now() < voiceUntilRef.current;
        if (talking && actions.talk) return "talk";
        return "idle";
      };

      reactOnceRef.current = () => {
        if (!actions.react || danceRef.current) return;
        reactRef.current = true;
        playAction("react", true);
      };

      const reground = () => {
        if (!root) return;
        const box = new THREE.Box3().setFromObject(root);
        if (!isFinite(box.min.y)) return;
        // 包围盒含当前位移：目标位置 = 当前位置 - 最低点（让脚底回到 y=0）
        groundFix = { from: root.position.y, to: root.position.y - box.min.y, t: 0 };
      };

      let pointerDown = false;
      let dragging = false;
      let downX = 0, lastX = 0, lastY = 0;

      const burst = (x: number, y: number) => {
        const layer = fxRef.current;
        if (!layer) return;
        const glyphs = ["✨", "⭐", "💫"];
        for (let i = 0; i < 6; i++) {
          const s = document.createElement("span");
          s.className = "vrm-fx-burst";
          s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          const dist = 40 + Math.random() * 56;
          s.style.left = `${x}px`;
          s.style.top = `${y}px`;
          s.style.setProperty("--dx", `${Math.cos(ang) * dist}px`);
          s.style.setProperty("--dy", `${Math.sin(ang) * dist}px`);
          s.style.fontSize = `${12 + Math.random() * 10}px`;
          s.addEventListener("animationend", () => s.remove());
          layer.appendChild(s);
        }
      };

      const onPointerDown = (e: PointerEvent) => {
        pointerDown = true;
        dragging = false;
        downX = lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
        canvas.style.cursor = "grabbing";
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!pointerDown || !root) return;
        const dx = e.clientX - lastX;
        if (Math.abs(e.clientX - downX) > 6) dragging = true;
        if (dragging) root.rotation.y += dx * 0.01;
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onPointerUp = (e: PointerEvent) => {
        canvas.releasePointerCapture?.(e.pointerId);
        canvas.style.cursor = "grab";
        const wasDrag = dragging;
        pointerDown = false;
        dragging = false;
        if (wasDrag || !root) return;
        const r = canvas.getBoundingClientRect();
        burst(e.clientX - r.left, e.clientY - r.top);
        if (actions.react) {
          // 动作库模式：点击 → 互动动作（一次）
          reactOnceRef.current();
        } else {
          // 旧模式：弹跳 + 切换内嵌动画
          bounceRef.current = performance.now() / 1000;
          if (legacyClips.length > 1 && mixer) {
            activeClip = (activeClip + 1) % legacyClips.length;
            mixer.stopAllAction();
            mixer.clipAction(legacyClips[activeClip]).play();
          }
        }
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        view.dist = THREE.MathUtils.clamp(
          view.dist * (1 + Math.sign(e.deltaY) * 0.07),
          view.baseDist * 0.45,
          view.baseDist * 1.8
        );
        placeCamera();
      };
      const onDblClick = () => {
        view.dist = view.baseDist;
        if (root) root.rotation.y = 0;
        placeCamera();
      };

      // 程序化"活感"叠加层：头部视线跟随 + 呼吸（在 mixer 写入骨骼后逐帧叠加，
      // 不累积；GLB 无 VRM lookAt/眨眼 blendshape，镜头前像人偶的主要代偿手段）
      let headBone: THREE.Object3D | null = null;
      let chestBone: THREE.Object3D | null = null;
      const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
      const overlay = { headY: 0, headX: 0, chestX: 0 };
      const onHoverMove = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        gaze.tx = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
        gaze.ty = THREE.MathUtils.clamp(((e.clientY - r.top) / r.height - 0.45) * 2, -1, 1);
      };
      const onHoverLeave = () => {
        gaze.tx = 0;
        gaze.ty = 0;
      };

      if (interactive) {
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("dblclick", onDblClick);
        canvas.addEventListener("pointermove", onHoverMove);
        canvas.addEventListener("pointerleave", onHoverLeave);
      }

      const clock = new THREE.Clock();
      const bakedUrls: Partial<Record<MotionKey, string>> = JSON.parse(animKey);
      new GLTFLoader().load(
        url,
        async (gltf) => {
          if (disposed) return;
          root = gltf.scene;
          scene.add(root);
          // 头/胸骨骼定位（Mixamo 命名：Head / Spine2；Tripo 带 mixamorig: 前缀）
          root.traverse((o) => {
            const n = o.name.toLowerCase();
            if (!headBone && /(^|[:_])head$/.test(n)) headBone = o;
            if (!chestBone && /spine2$|chest$/.test(n)) chestBone = o;
          });

          // 1) Meshy 官方烘焙动画（同骨架带皮 GLB）：抽 clip 按骨骼名直接绑定，
          //    质量 = Meshy 官网效果，零重定向误差
          let yaw: number | null = null;
          await Promise.all(
            (Object.entries(bakedUrls) as [MotionKey, string][]).map(async ([key, u]) => {
              if (!u) return;
              try {
                const g = await new GLTFLoader().loadAsync(u);
                const clip = g.animations?.[0];
                if (clip && root) {
                  clip.name = key;
                  mixer ??= new THREE.AnimationMixer(root);
                  actions[key] = mixer.clipAction(clip);
                }
              } catch (e) {
                console.warn(`[GLBStage] 烘焙动画 ${key} 加载失败（重定向兜底）`, e);
              }
            })
          );
          if (disposed) return;

          // 2) 本地动作库重定向补缺：talk 等未烘焙动作 / 完全无烘焙时全量
          try {
            if (MOTION_KEYS.some((k) => !actions[k])) {
              const motions = await retargetMotionsFor(root);
              if (disposed) return;
              if (motions) {
                const retargetRoot = motions.mixerRoot;
                mixer ??= new THREE.AnimationMixer(retargetRoot);
                for (const [key, clip] of Object.entries(motions.clips)) {
                  if (actions[key as MotionKey]) continue;
                  const sameRoot = mixer.getRoot() === retargetRoot;
                  actions[key as MotionKey] = sameRoot
                    ? mixer.clipAction(clip)
                    : mixer.clipAction(clip, retargetRoot);
                }
                // 上台姿态由重定向动作决定：按动画后的头骨朝向测面朝角
                yaw = await forwardCorrection(root, motions.names);
              }
            }
          } catch (e) {
            console.warn("[GLBStage] 动作库加载失败，回退内嵌动画", e);
          }

          if (mixer && actions.idle) {
            mixer.addEventListener("finished", () => {
              // 一次性动作（react）结束 → 回到状态机期望动作
              reactRef.current = false;
              current = null;
              playAction(desiredKey());
            });
            playAction("idle");
            mixer.update(0.05);
          }
          console.info(
            `[GLBStage] 动作就绪: ${Object.keys(actions).join("/") || "无"}` +
              `（烘焙 ${Object.keys(bakedUrls).filter((k) => actions[k as MotionKey]).length} 个）`
          );
          // 开发态调试句柄（E2E 验证用）：skeleton(true) 叠加骨架线框
          // （深度测试关闭、透出网格），用于人工核验绑骨与网格对齐精度
          let skelHelper: THREE.SkeletonHelper | null = null;
          (window as any).__glbStage = {
            actions: () => Object.keys(actions),
            current: () => current,
            time: () => (current ? actions[current]?.time : null),
            rotate: (rad: number) => { if (root) root.rotation.y = rad; },
            skeleton: (on: boolean) => {
              if (on && !skelHelper && root) {
                skelHelper = new THREE.SkeletonHelper(root);
                (skelHelper.material as THREE.LineBasicMaterial).depthTest = false;
                scene.add(skelHelper);
              } else if (!on && skelHelper) {
                scene.remove(skelHelper);
                skelHelper.dispose();
                skelHelper = null;
              }
              return !!skelHelper;
            },
          };

          // 3) 回退：内嵌动画（旧 anim GLB）按首 clip 循环
          if (!actions.idle) {
            legacyClips = gltf.animations ?? [];
            if (legacyClips.length) {
              mixer = new THREE.AnimationMixer(root);
              mixer.clipAction(legacyClips[0]).play();
              mixer.update(0.05);
            }
          }

          // 朝向转正：优先按动画姿态的头骨朝向，无映射回退包围盒启发式
          let box = new THREE.Box3().setFromObject(root);
          let size = box.getSize(new THREE.Vector3());
          if (yaw !== null) {
            root.rotation.y -= yaw;
            root.updateMatrixWorld(true);
            box = new THREE.Box3().setFromObject(root);
            size = box.getSize(new THREE.Vector3());
          } else if (size.z > size.x * 1.25) {
            root.rotation.y += Math.PI / 2;
            box = new THREE.Box3().setFromObject(root);
            size = box.getSize(new THREE.Vector3());
          }
          // 自动取景：包围盒居中 + 贴地 + 全身入框
          const center = box.getCenter(new THREE.Vector3());
          root.position.x -= center.x;
          root.position.z -= center.z;
          root.position.y -= box.min.y;
          const h = Math.max(size.y, 0.5);
          view.h = h;
          view.baseDist = h * 2.2;
          view.dist = view.baseDist;
          placeCamera();
          // 软接触阴影锚定地面
          scene.add(makeContactShadow(Math.max(size.x, size.z) * 0.46));
          setStatus("");
        },
        undefined,
        (e) => setStatus(`模型加载失败：${(e as any)?.message ?? e}`)
      );

      renderer.setAnimationLoop(() => {
        const delta = clock.getDelta();
        const t = clock.elapsedTime;
        if (root) {
          mixer?.update(delta);
          // "活感"叠加（mixer 写入骨骼之后）：仅 idle/talk 叠加，跳舞/互动全身
          // 动作朝向多变，叠头部转向会怪异。先撤销上一帧叠加量再施新值，
          // 避免该骨骼无动画轨道（mixer 不重写）时增量逐帧累积跑偏
          const calm = current === "idle" || current === "talk" || !actions.idle;
          gaze.x += (gaze.tx - gaze.x) * Math.min(1, delta * 4.5);
          gaze.y += (gaze.ty - gaze.y) * Math.min(1, delta * 4.5);
          if (headBone) {
            headBone.rotation.y += -overlay.headY + (overlay.headY = calm ? gaze.x * 0.22 : 0);
            headBone.rotation.x += -overlay.headX + (overlay.headX = calm ? gaze.y * 0.12 : 0);
          }
          if (chestBone) {
            // 呼吸：胸骨 ~3.6s 周期微俯仰，幅度小到只在静止时可感知
            chestBone.rotation.x += -overlay.chestX + (overlay.chestX = calm ? Math.sin(t * 1.75) * 0.012 : 0);
          }
          // 动作库模式：按驱动状态切换动作（说话/跳舞/互动/待机）
          if (actions.idle && !reactRef.current) {
            const want = desiredKey();
            if (want !== current) playAction(want);
          }
          // 动作切换后的平滑贴地校准
          if (regroundAt && performance.now() > regroundAt) {
            regroundAt = 0;
            reground();
          }
          if (groundFix.t < 1) {
            groundFix.t = Math.min(1, groundFix.t + delta / 0.3);
            const k = groundFix.t * (2 - groundFix.t); // easeOut
            root.position.y = THREE.MathUtils.lerp(root.position.y, groundFix.to, k);
          }
          // 旧模式的点头/弹跳反馈
          if (!actions.idle) {
            const nodAge = performance.now() / 1000 - nodRef.current;
            if (nodAge < 1.2) root.rotation.y += 0.18 * Math.sin(nodAge * Math.PI * 3) * Math.sin(Math.PI * (1 - nodAge / 1.2));
            if (bounceRef.current > 0) {
              const be = (performance.now() / 1000 - bounceRef.current) / 0.55;
              if (be < 1) root.position.y += 0.045 * view.h * Math.abs(Math.sin(be * Math.PI * 2)) * (1 - be);
              else bounceRef.current = -1;
            }
            if (!mixer) root.position.y += Math.sin(t * 1.6) * 0.0008; // 无动画时轻微呼吸浮动
          }
        }
        renderer.render(scene, camera);
      });

      return () => {
        disposed = true;
        ro.disconnect();
        renderer.setAnimationLoop(null);
        if (interactive) {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("wheel", onWheel);
          canvas.removeEventListener("dblclick", onDblClick);
          canvas.removeEventListener("pointermove", onHoverMove);
          canvas.removeEventListener("pointerleave", onHoverLeave);
        }
        if (root) scene.remove(root);
        renderer.dispose();
        wrap.removeChild(renderer.domElement);
      };
    }, [url, interactive, animKey]);

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

export default GLBStage;
