/**
 * VRM 通用动作库（路线图 P0：模型与动作彻底解耦，不自写任何动作）
 *
 * 资产来源（manifest 驱动，storage/motions/vrm/manifest.json）：
 * - Mixamo 真人动捕 FBX（Without Skin 下载后直接丢进目录即用，免费商用）
 * - .vrma VRM 原生动画（官方/商用动作包，零重定向损失，@pixiv/three-vrm-animation）
 * - mixamorig 命名的 GLB（Blender 转换产物）
 * - 无 manifest 时回退内置资产：待机用 ChatVRM idle_loop.vrma（MIT，VRM 原生），
 *   说话用 UAL 库（CC0）重定向，点击反应用 three.js Xbot "agree"（MIT）；
 *   舞蹈仍走 VMD
 *
 * 朝向锁定：除舞蹈外的动作在重定向时剔除髋骨世界偏航（整体转身分量），
 * 角色恒面向镜头——游戏动作库常带转身位移，聊天舞台上会"背对用户"。
 *
 * 重定向：世界方向跟随法（world direction-following retarget）——
 * 不变量：目标骨的世界指向(t) 始终等于源骨的世界指向(t)。
 *   目标世界旋转(t) = C × 源世界旋转(t) × 源绑定世界旋转⁻¹ × C⁻¹ × R_align⁻¹
 *   归一化局部旋转(t) = 最近已映射祖先的目标世界旋转⁻¹ × 本骨目标世界旋转
 * 其中 C 为源模型整体朝向校正（转入 VRM 世界系），R_align 为绑定姿态下
 * 源骨方向 → 目标骨方向（VRM normalized 恒 T-pose）的最短弧旋转，
 * 吸收 A-pose/T-pose 等绑定差异；源绑定即 T-pose（如 Mixamo）时 R_align 退化为单位量。
 * 逐骨用真实层级（normalized 骨架）求局部，不要求源场景图父子链与人形链一致
 * （Rigify/UAL 存在不映射的中间骨）。VRM0 模型四元数/位移 x,z 取反（与 vmdDance 一致）。
 * 采样式实现（mixer 逐帧驱动源骨架读世界姿态），不解析轨道名，兼容任意源格式。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { VRM } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationHumanoidTracks,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";

export type MotionKey = "idle" | "talk" | "dance" | "react";

const MANIFEST_URL = "/files/motions/vrm/manifest.json";
const MANIFEST_BASE = "/files/motions/vrm/";
const UAL_URL = "/files/motions/ual_standard.glb";
/** ChatVRM（pixiv，MIT）官方待机动画：VRM 原生 .vrma，零重定向损失无穿模 */
const BUILTIN_IDLE_VRMA = "/motions/idle_loop.vrma";
/** three.js 示例 Xbot（MIT 仓库随附，mixamorig 骨架）：agree 点头作点击反应 */
const XBOT_URL = "/motions/xbot.glb";

/**
 * UAL 库内置兜底：语义动作 → clip 名。
 * 舞蹈不用 UAL（质量不足，VMD 负责）；Interact（伸手按物）已剔除——
 * 游戏交互动作放在偶像角色上观感怪异且与瘦长体型穿模。
 */
const UAL_CLIPS: Partial<Record<MotionKey, string>> = {
  idle: "Idle_Loop",
  talk: "Idle_Talking_Loop",
};

/** mixamorig 骨骼 → VRM humanoid 骨骼（pixiv 官方示例映射表） */
const MIXAMO_TO_VRM: Record<string, string> = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

/** UAL（Rigify DEF）骨骼 → VRM humanoid 骨骼 */
const UAL_TO_VRM: Record<string, string> = {
  "DEF-hips": "hips",
  "DEF-spine.001": "spine",
  "DEF-spine.002": "chest",
  "DEF-spine.003": "upperChest",
  "DEF-neck": "neck",
  "DEF-head": "head",
  "DEF-shoulder.L": "leftShoulder",
  "DEF-upper_arm.L": "leftUpperArm",
  "DEF-forearm.L": "leftLowerArm",
  "DEF-hand.L": "leftHand",
  "DEF-shoulder.R": "rightShoulder",
  "DEF-upper_arm.R": "rightUpperArm",
  "DEF-forearm.R": "rightLowerArm",
  "DEF-hand.R": "rightHand",
  "DEF-thigh.L": "leftUpperLeg",
  "DEF-shin.L": "leftLowerLeg",
  "DEF-foot.L": "leftFoot",
  "DEF-toe.L": "leftToes",
  "DEF-thigh.R": "rightUpperLeg",
  "DEF-shin.R": "rightLowerLeg",
  "DEF-foot.R": "rightFoot",
  "DEF-toe.R": "rightToes",
};

/** 骨骼名规整（mixamorig:Hips / mixamorig_Hips → mixamorigHips） */
const normName = (n: string) => n.replace(/[:\s_]/g, "");

/** 求骨骼绑定方向用的链下游骨（按 VRM humanoid 链，存在缺骨时取后备） */
const CHAIN_CHILD: Record<string, string[]> = {
  hips: ["spine", "chest"],
  spine: ["chest", "upperChest", "neck"],
  chest: ["upperChest", "neck"],
  upperChest: ["neck"],
  neck: ["head"],
  leftShoulder: ["leftUpperArm"],
  leftUpperArm: ["leftLowerArm"],
  leftLowerArm: ["leftHand"],
  rightShoulder: ["rightUpperArm"],
  rightUpperArm: ["rightLowerArm"],
  rightLowerArm: ["rightHand"],
  leftUpperLeg: ["leftLowerLeg"],
  leftLowerLeg: ["leftFoot"],
  rightUpperLeg: ["rightLowerLeg"],
  rightLowerLeg: ["rightFoot"],
};

/**
 * VRM normalized 骨架（规范 T-pose）下各骨的指向常量。
 * 不读 normalized 节点世界坐标——VRM0 场景级 180° 旋转会污染世界系，
 * 而规范保证 normalized rest 恒为标准 T-pose，常量更可靠。
 * 足部/头/手等末端骨方向因模型而异，不做对齐（纯增量已足够）。
 */
const T_POSE_DIR: Record<string, [number, number, number]> = {
  hips: [0, 1, 0],
  spine: [0, 1, 0],
  chest: [0, 1, 0],
  upperChest: [0, 1, 0],
  neck: [0, 1, 0],
  leftShoulder: [1, 0, 0],
  leftUpperArm: [1, 0, 0],
  leftLowerArm: [1, 0, 0],
  rightShoulder: [-1, 0, 0],
  rightUpperArm: [-1, 0, 0],
  rightLowerArm: [-1, 0, 0],
  leftUpperLeg: [0, -1, 0],
  leftLowerLeg: [0, -1, 0],
  rightUpperLeg: [0, -1, 0],
  rightLowerLeg: [0, -1, 0],
};

interface ManifestEntry {
  key: MotionKey;
  file: string;
}

interface SourceAsset {
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

async function loadSource(url: string): Promise<SourceAsset> {
  if (/\.fbx(\?|$)/i.test(url)) {
    const root = await new FBXLoader().loadAsync(url);
    return { root, clips: root.animations ?? [] };
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  return { root: gltf.scene, clips: gltf.animations ?? [] };
}

/** 加载 .vrma 并生成 humanoid 轨道 clip（表情/视线轨道不取——由舞台自有逻辑驱动） */
async function loadVrmaClip(url: string, vrm: VRM): Promise<THREE.AnimationClip | null> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const va = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
  if (!va || !vrm.humanoid) return null;
  const metaVersion = (vrm.meta as any)?.metaVersion === "0" ? "0" : "1";
  const tracks = createVRMAnimationHumanoidTracks(va, vrm.humanoid, metaVersion);
  const all: THREE.KeyframeTrack[] = [...tracks.rotation.values(), ...tracks.translation.values()];
  if (!all.length) return null;
  return new THREE.AnimationClip("vrma", va.duration, all);
}

/** 在源场景中按映射表收集骨骼（名字规整后匹配） */
function collectSourceBones(
  root: THREE.Object3D,
  map: Record<string, string>
): Map<string, THREE.Object3D> {
  const wanted = new Map<string, string>(); // 规整名 → vrm 骨名
  for (const [src, vrmName] of Object.entries(map)) wanted.set(normName(src), vrmName);
  const found = new Map<string, THREE.Object3D>(); // vrm 骨名 → 源节点
  root.traverse((o) => {
    const vrmName = wanted.get(normName(o.name));
    if (vrmName && !found.has(vrmName)) found.set(vrmName, o);
  });
  return found;
}

/** 自动识别源骨架命名体系 */
function detectMap(root: THREE.Object3D): Record<string, string> | null {
  let mixamo = false;
  let ual = false;
  root.traverse((o) => {
    if (o.name.startsWith("mixamorig") || normName(o.name).startsWith("mixamorig")) mixamo = true;
    if (o.name.startsWith("DEF-")) ual = true;
  });
  return mixamo ? MIXAMO_TO_VRM : ual ? UAL_TO_VRM : null;
}

/**
 * 采样式世界增量重定向：源 clip → VRM normalized humanoid 轨道。
 * 用 AnimationMixer 在源场景逐帧播放并读取世界旋转，规避轨道名解析与
 * 源骨架层级差异（ORG/MCH 中间骨、UAL 骨名含 “.”、“:” 清洗规则不一致）。
 */
export function retargetClipToVrm(
  vrm: VRM,
  src: SourceAsset,
  clip: THREE.AnimationClip,
  map: Record<string, string>,
  opts: { lockYaw?: boolean } = {},
  fps = 30
): THREE.AnimationClip | null {
  const lockYaw = !!opts.lockYaw;
  const flip = (vrm.meta as any)?.metaVersion === "0";
  src.root.updateMatrixWorld(true);
  const srcBones = collectSourceBones(src.root, map);
  if (!srcBones.has("hips")) return null;

  // 源模型绑定姿态朝向校正：用两条大腿连线推世界系下的面朝向，
  // 旋出 yaw 偏差使增量表达在 VRM 世界系（面向 +Z）。Mixamo 朝向标准时为单位量。
  const C = new THREE.Quaternion();
  {
    const l = srcBones.get("leftUpperLeg");
    const r = srcBones.get("rightUpperLeg");
    if (l && r) {
      const leftAxis = l
        .getWorldPosition(new THREE.Vector3())
        .sub(r.getWorldPosition(new THREE.Vector3()));
      leftAxis.y = 0;
      if (leftAxis.lengthSq() > 1e-8) {
        leftAxis.normalize();
        // 面向 +Z、上 +Y 时左手轴为 +X：leftAxis × up = forward
        const fwd = new THREE.Vector3().crossVectors(leftAxis, new THREE.Vector3(0, 1, 0));
        const yaw = Math.atan2(fwd.x, fwd.z);
        C.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
      }
    }
  }
  const CInv = C.clone().invert();

  // 配对：源骨 ↔ VRM normalized 骨；父指向「最近的已映射 VRM 祖先」
  interface Pair {
    src: THREE.Object3D;
    nodeName: string;
    restWorldInv: THREE.Quaternion;
    /** 绑定姿态差吸收：源骨方向 → 目标骨方向 的最短弧旋转之逆 */
    alignInv: THREE.Quaternion;
    srcRestPos: THREE.Vector3;
    parent: Pair | null;
    depth: number;
    delta: THREE.Quaternion;
    values: Float32Array;
  }
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const byNode = new Map<THREE.Object3D, Pair>();
  const byVrmName = new Map<string, Pair>();
  const pairs: Pair[] = [];
  for (const [vrmName, srcNode] of srcBones) {
    const norm = vrm.humanoid?.getNormalizedBoneNode(vrmName as any);
    if (!norm) continue;
    const p: Pair = {
      src: srcNode,
      nodeName: norm.name,
      restWorldInv: srcNode.getWorldQuaternion(new THREE.Quaternion()).invert(),
      alignInv: new THREE.Quaternion(),
      srcRestPos: srcNode.getWorldPosition(new THREE.Vector3()),
      parent: null,
      depth: 0,
      delta: new THREE.Quaternion(),
      values: new Float32Array(frames * 4),
    };
    byNode.set(norm, p);
    byVrmName.set(vrmName, p);
    pairs.push(p);
  }
  if (!pairs.length) return null;
  // 用 normalized 骨架真实层级解析父子与深度（自动适配缺 upperChest 等情况）
  for (const [norm, p] of byNode) {
    let a = norm.parent;
    let depth = 0;
    while (a) {
      const pp = byNode.get(a);
      if (pp && !p.parent) p.parent = pp;
      depth++;
      a = a.parent;
    }
    p.depth = depth;
  }
  pairs.sort((a, b) => a.depth - b.depth);
  // 绑定方向对齐量：源骨指向（C 校正后）旋到 VRM 规范 T-pose 指向
  for (const [vrmName, p] of byVrmName) {
    const dir = T_POSE_DIR[vrmName];
    const childName = (CHAIN_CHILD[vrmName] ?? []).find((n) => byVrmName.has(n));
    const child = childName ? byVrmName.get(childName)! : null;
    if (!dir || !child) continue; // 末端骨（头/手/足/手指）保持纯增量
    const srcDir = child.srcRestPos.clone().sub(p.srcRestPos).applyQuaternion(C);
    if (srcDir.lengthSq() < 1e-10) continue;
    p.alignInv
      .setFromUnitVectors(srcDir.normalize(), new THREE.Vector3(...dir))
      .invert();
  }

  // 髋骨位移缩放：VRM 髋高 / 源髋高
  const srcHips = srcBones.get("hips")!;
  const srcHipsRest = srcHips.getWorldPosition(new THREE.Vector3());
  const vrmHipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
  const vrmHipsY = vrmHipsNode
    ? vrmHipsNode.getWorldPosition(new THREE.Vector3()).y - vrm.scene.getWorldPosition(new THREE.Vector3()).y
    : 1;
  const posScale = Math.abs(vrmHipsY) / Math.max(1e-6, Math.abs(srcHipsRest.y));
  const hipsPos = vrmHipsNode ? new Float32Array(frames * 3) : null;

  // 逐帧采样
  const mixer = new THREE.AnimationMixer(src.root);
  mixer.clipAction(clip).play();
  const dt = clip.duration / (frames - 1);
  const times = new Float32Array(frames);
  const q = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  const yawInv = new THREE.Quaternion();
  const v = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    times[f] = f * dt;
    mixer.setTime(f * dt);
    src.root.updateMatrixWorld(true);
    for (const p of pairs) {
      // 目标世界旋转 = C × 源世界(t) × 源绑定世界⁻¹ × C⁻¹ × R_align⁻¹
      p.src.getWorldQuaternion(q).multiply(p.restWorldInv).premultiply(C).multiply(CInv).multiply(p.alignInv);
      // 朝向锁定：从髋骨（深度最小，必先处理）提取绕 Y 偏航并对全身剔除，
      // 相对姿态不变、整体不转身
      if (lockYaw && !p.parent) {
        yawInv.set(0, q.y, 0, q.w);
        if (yawInv.lengthSq() < 1e-12) yawInv.identity();
        else yawInv.normalize().invert();
      }
      if (lockYaw) q.premultiply(yawInv);
      p.delta.copy(q);
      // normalized 局部 = 父目标世界⁻¹ × 本骨目标世界（normalized 绑定世界恒为单位）
      if (p.parent) local.copy(p.parent.delta).invert().multiply(q);
      else local.copy(q);
      if (flip) {
        local.x = -local.x;
        local.z = -local.z;
      }
      p.values[f * 4] = local.x;
      p.values[f * 4 + 1] = local.y;
      p.values[f * 4 + 2] = local.z;
      p.values[f * 4 + 3] = local.w;
    }
    if (hipsPos) {
      srcHips.getWorldPosition(v).applyQuaternion(C).multiplyScalar(posScale);
      if (lockYaw) v.applyQuaternion(yawInv);
      hipsPos[f * 3] = flip ? -v.x : v.x;
      hipsPos[f * 3 + 1] = v.y;
      hipsPos[f * 3 + 2] = flip ? -v.z : v.z;
    }
  }
  mixer.stopAllAction();

  const tracks: THREE.KeyframeTrack[] = pairs.map(
    (p) => new THREE.QuaternionKeyframeTrack(`${p.nodeName}.quaternion`, times as any, p.values as any)
  );
  if (hipsPos && vrmHipsNode) {
    tracks.push(new THREE.VectorKeyframeTrack(`${vrmHipsNode.name}.position`, times as any, hipsPos as any));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export interface VrmMotionSet {
  clips: Partial<Record<MotionKey, THREE.AnimationClip>>;
  /** 动作来源："manifest"（落盘资产）或 "builtin"（内置兜底） */
  source: "manifest" | "builtin";
}

/**
 * 加载并重定向 VRM 通用动作集。
 * manifest 存在 → 按清单加载（Mixamo FBX / GLB / VRMA）；
 * 否则内置兜底：待机 ChatVRM idle_loop.vrma（VRM 原生）→ 失败再 UAL，说话 UAL。
 * 全部失败返回 null（调用方保持程序化动作）。
 */
export async function loadVrmMotions(vrm: VRM): Promise<VrmMotionSet | null> {
  // 1) manifest 资产（用户落盘的 Mixamo 动捕 / 商用 VRMA 包）
  try {
    const res = await fetch(MANIFEST_URL);
    if (res.ok) {
      const manifest = (await res.json()) as { clips?: ManifestEntry[] };
      const entries = (manifest.clips ?? []).filter((e) => e?.key && e?.file);
      if (entries.length) {
        const out: VrmMotionSet = { clips: {}, source: "manifest" };
        const assetCache = new Map<string, Promise<SourceAsset>>();
        for (const e of entries) {
          try {
            let rc: THREE.AnimationClip | null = null;
            if (/\.vrma(\?|$)/i.test(e.file)) {
              rc = await loadVrmaClip(MANIFEST_BASE + e.file, vrm);
            } else {
              let p = assetCache.get(e.file);
              if (!p) {
                p = loadSource(MANIFEST_BASE + e.file);
                assetCache.set(e.file, p);
              }
              const asset = await p;
              const clip = asset.clips[0];
              const map = detectMap(asset.root);
              if (!clip || !map) continue;
              // 舞蹈保留编舞转身；其余动作锁定朝向（恒面向镜头）
              rc = retargetClipToVrm(vrm, asset, clip, map, { lockYaw: e.key !== "dance" });
            }
            if (rc) {
              rc.name = e.key;
              out.clips[e.key] = rc;
            }
          } catch (err) {
            console.warn(`[vrmMotions] 动作 ${e.file} 加载失败`, err);
          }
        }
        if (out.clips.idle) return out;
      }
    }
  } catch {
    /* manifest 不存在/解析失败 → 走兜底 */
  }

  // 2) 内置兜底：VRM 原生待机（ChatVRM MIT）优先，UAL（CC0）补说话；舞蹈由 VMD 负责
  const out: VrmMotionSet = { clips: {}, source: "builtin" };
  try {
    const idleVrma = await loadVrmaClip(BUILTIN_IDLE_VRMA, vrm);
    if (idleVrma) {
      idleVrma.name = "idle";
      out.clips.idle = idleVrma;
    }
  } catch (e) {
    console.warn("[vrmMotions] 内置待机 VRMA 加载失败，改用 UAL", e);
  }
  try {
    const asset = await loadSource(UAL_URL);
    for (const [key, clipName] of Object.entries(UAL_CLIPS) as [MotionKey, string][]) {
      if (out.clips[key]) continue;
      const clip = THREE.AnimationClip.findByName(asset.clips, clipName);
      if (!clip) continue;
      const rc = retargetClipToVrm(vrm, asset, clip, UAL_TO_VRM, { lockYaw: true });
      if (rc) {
        rc.name = key;
        out.clips[key] = rc;
      }
    }
  } catch (e) {
    console.warn("[vrmMotions] UAL 动作库加载失败", e);
  }
  // 点击反应：Xbot "agree"（点头+全身微动），自然不夸张、无穿模风险
  if (!out.clips.react) {
    try {
      const xbot = await loadSource(XBOT_URL);
      const clip = THREE.AnimationClip.findByName(xbot.clips, "agree");
      if (clip) {
        const rc = retargetClipToVrm(vrm, xbot, clip, MIXAMO_TO_VRM, { lockYaw: true });
        if (rc) {
          rc.name = "react";
          out.clips.react = rc;
        }
      }
    } catch (e) {
      console.warn("[vrmMotions] Xbot react 加载失败", e);
    }
  }
  return out.clips.idle ? out : null;
}
