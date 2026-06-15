/**
 * GLB 动作库（CC0 · Quaternius Universal Animation Library）：
 * 为 AI 生成的 mixamo 标准骨架模型提供 站立/说话/舞蹈/互动 真动作。
 *
 * 原理：UAL 的 Rigify 骨骼（DEF-*）与目标 mixamo 骨骼按人形语义建立映射，
 * 经 three SkeletonUtils.retargetClip 离线采样重定向成目标骨架的 AnimationClip，
 * 一次重定向全程复用；动作文件本地化在 storage/motions/（/files 静态服务）。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// 经 Vite/Nginx 的 /files 反代到后端静态存储
const LIB_URL = "/files/motions/ual_standard.glb";

/** 语义动作 → UAL 库内 clip 名 */
const CLIP_NAMES: Record<MotionKey, string> = {
  idle: "Idle_Loop",
  talk: "Idle_Talking_Loop",
  dance: "Dance_Loop",
  react: "Interact",
};
export type MotionKey = "idle" | "talk" | "dance" | "react";

/** mixamo / 常见人形骨骼名（规整后）→ UAL Rigify DEF 骨骼名 */
const CANON_TO_UAL: Record<string, string> = {
  hips: "DEF-hips",
  spine: "DEF-spine.001",
  spine1: "DEF-spine.002",
  spine2: "DEF-spine.003",
  chest: "DEF-spine.002",
  upperchest: "DEF-spine.003",
  neck: "DEF-neck",
  head: "DEF-head",
  leftshoulder: "DEF-shoulder.L",
  leftarm: "DEF-upper_arm.L",
  leftupperarm: "DEF-upper_arm.L",
  leftforearm: "DEF-forearm.L",
  leftlowerarm: "DEF-forearm.L",
  lefthand: "DEF-hand.L",
  rightshoulder: "DEF-shoulder.R",
  rightarm: "DEF-upper_arm.R",
  rightupperarm: "DEF-upper_arm.R",
  rightforearm: "DEF-forearm.R",
  rightlowerarm: "DEF-forearm.R",
  righthand: "DEF-hand.R",
  leftupleg: "DEF-thigh.L",
  leftupperleg: "DEF-thigh.L",
  leftleg: "DEF-shin.L",
  leftlowerleg: "DEF-shin.L",
  leftfoot: "DEF-foot.L",
  lefttoebase: "DEF-toe.L",
  lefttoes: "DEF-toe.L",
  rightupleg: "DEF-thigh.R",
  rightupperleg: "DEF-thigh.R",
  rightleg: "DEF-shin.R",
  rightlowerleg: "DEF-shin.R",
  rightfoot: "DEF-foot.R",
  righttoebase: "DEF-toe.R",
  righttoes: "DEF-toe.R",
  // 手指（mixamo: LeftHandIndex1.. → UAL: DEF-f_index.01.L..）
  ...fingerMap(),
};

function fingerMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const fingers: Array<[string, string]> = [
    ["thumb", "thumb"],
    ["index", "f_index"],
    ["middle", "f_middle"],
    ["ring", "f_ring"],
    ["pinky", "f_pinky"],
  ];
  for (const side of ["left", "right"] as const) {
    const s = side === "left" ? "L" : "R";
    for (const [mix, ual] of fingers) {
      for (let i = 1; i <= 3; i++) {
        out[`${side}hand${mix}${i}`] = `DEF-${ual}.0${i}.${s}`;
      }
    }
  }
  return out;
}

/** 骨骼名规整：去 mixamorig 前缀与分隔符，小写化，用于语义匹配 */
function canonKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mixamorig[:_.]?/, "")
    .replace(/[\s_.:|-]/g, "");
}

function findSkinnedMesh(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  return found;
}

/**
 * 拓扑推断人形骨骼映射（兜底）：Tripo 等自动绑骨产物用私有命名
 * （tripo::0_Left_Limb_0 / bone_10…），按绑定姿态的空间结构识别
 * 髋-脊柱-头 / 双腿 / 双臂，再映射到 UAL 源骨骼。
 * 头发/手指等未识别骨骼保持绑定姿态不动（不会乱舞）。
 */
function inferHumanoidMap(target: THREE.SkinnedMesh): Record<string, string> | null {
  const bones = target.skeleton.bones;
  if (bones.length < 10) return null;
  const isBone = (o: unknown): o is THREE.Bone => !!(o as THREE.Bone)?.isBone;
  const pos = new Map<THREE.Bone, THREE.Vector3>();
  for (const b of bones) pos.set(b, b.getWorldPosition(new THREE.Vector3()));
  const kids = (b: THREE.Bone) => b.children.filter(isBone) as THREE.Bone[];
  const elev = (b: THREE.Bone) => pos.get(b)!.y;

  const root = bones.find((b) => !isBone(b.parent));
  if (!root) return null;

  let minY = Infinity, maxY = -Infinity;
  for (const v of pos.values()) {
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  const H = Math.max(1e-6, maxY - minY);
  // 侧向轴：骨骼横向分布更宽的那根轴
  let sx = 0, sz = 0;
  for (const v of pos.values()) {
    sx += Math.abs(v.x);
    sz += Math.abs(v.z);
  }
  const latAxis: "x" | "z" = sx >= sz ? "x" : "z";
  const lat = (b: THREE.Bone) => pos.get(b)![latAxis];

  // 子树统计：最低/最高点、最大侧向偏移
  const subMin = new Map<THREE.Bone, number>();
  const subMax = new Map<THREE.Bone, number>();
  const subLat = new Map<THREE.Bone, number>();
  const calc = (b: THREE.Bone) => {
    let mn = elev(b), mx = elev(b), ml = Math.abs(lat(b));
    for (const c of kids(b)) {
      calc(c);
      mn = Math.min(mn, subMin.get(c)!);
      mx = Math.max(mx, subMax.get(c)!);
      ml = Math.max(ml, subLat.get(c)!);
    }
    subMin.set(b, mn);
    subMax.set(b, mx);
    subLat.set(b, ml);
    return b;
  };
  calc(root);

  const map: Record<string, string> = { [root.name]: "DEF-hips" };

  // ---- 腿链：root 孩子里子树触地且不高过胸口的，往最低处贪心走 ----
  const legRoots = kids(root)
    .filter((c) => subMin.get(c)! < minY + 0.15 * H && subMax.get(c)! < minY + 0.78 * H)
    .sort((a, b) => lat(a) - lat(b));
  if (legRoots.length < 2) return null;
  const walkDown = (start: THREE.Bone) => {
    const chain = [start];
    let cur = start;
    while (true) {
      const cs = kids(cur);
      if (!cs.length) break;
      cur = cs.reduce((m, c) => (subMin.get(c)! < subMin.get(m)! ? c : m));
      chain.push(cur);
    }
    return chain;
  };
  const mapLeg = (chain: THREE.Bone[], side: "L" | "R") => {
    if (chain.length < 2) return false;
    map[chain[0].name] = `DEF-thigh.${side}`;
    if (chain.length === 2) {
      map[chain[1].name] = `DEF-shin.${side}`;
      return true;
    }
    map[chain[1].name] = `DEF-shin.${side}`;
    map[chain[chain.length >= 4 ? chain.length - 2 : chain.length - 1].name] = `DEF-foot.${side}`;
    if (chain.length >= 4) map[chain[chain.length - 1].name] = `DEF-toe.${side}`;
    return true;
  };
  // 侧向较小者记 L（动作多对称，左右颠倒不影响观感）
  if (!mapLeg(walkDown(legRoots[0]), "L") || !mapLeg(walkDown(legRoots[legRoots.length - 1]), "R")) return null;

  // ---- 脊柱链：root 孩子里子树最高的，向上走到出现双侧手臂分支 ----
  const spineRoot = kids(root)
    .filter((c) => !legRoots.includes(c))
    .sort((a, b) => subMax.get(b)! - subMax.get(a)!)[0];
  if (!spineRoot) return null;
  const armThresh = 0.16 * H;
  const isArmBranch = (b: THREE.Bone) =>
    kids(b).filter((c) => subLat.get(c)! - Math.abs(lat(b)) > armThresh).length >= 2;
  const spineChain: THREE.Bone[] = [];
  let cur: THREE.Bone | null = spineRoot;
  while (cur) {
    spineChain.push(cur);
    if (isArmBranch(cur)) break;
    const top: number = elev(cur) + 0.02 * H;
    let next: THREE.Bone | null = null;
    for (const c of kids(cur)) {
      if (subMax.get(c)! > top && (!next || subMax.get(c)! > subMax.get(next)!)) next = c;
    }
    if (!next || spineChain.length > 8) break;
    cur = next;
  }
  const chest = spineChain[spineChain.length - 1];
  map[spineChain[0].name] = "DEF-spine.001";
  if (spineChain.length >= 3) map[spineChain[Math.floor((spineChain.length - 1) / 2)].name] = "DEF-spine.002";
  map[chest.name] = "DEF-spine.003";

  // ---- 手臂链：胸口孩子里向侧向延伸的两支 ----
  const armRoots = kids(chest)
    .filter((c) => subLat.get(c)! - Math.abs(lat(chest)) > armThresh)
    .sort((a, b) => lat(a) - lat(b));
  const walkOut = (start: THREE.Bone) => {
    const chain = [start];
    let c = start;
    while (true) {
      const cs = kids(c);
      if (!cs.length) break;
      c = cs.reduce((m, x) => (subLat.get(x)! > subLat.get(m)! ? x : m));
      chain.push(c);
    }
    return chain;
  };
  const mapArm = (chain: THREE.Bone[], side: "L" | "R") => {
    if (chain.length < 2) return false;
    // 距脊柱很近的首骨视作锁骨
    let i = 0;
    if (chain.length >= 3 && Math.abs(Math.abs(lat(chain[0])) - Math.abs(lat(chest))) < 0.06 * H) {
      map[chain[0].name] = `DEF-shoulder.${side}`;
      i = 1;
    }
    const seg = chain.slice(i);
    if (seg.length < 2) return false;
    map[seg[0].name] = `DEF-upper_arm.${side}`;
    map[seg[seg.length - 1].name] = `DEF-hand.${side}`;
    if (seg.length >= 3) map[seg[Math.floor((seg.length - 1) / 2)].name] = `DEF-forearm.${side}`;
    return true;
  };
  if (armRoots.length >= 2) {
    if (!mapArm(walkOut(armRoots[0]), "L") || !mapArm(walkOut(armRoots[armRoots.length - 1]), "R")) return null;
  } else {
    return null;
  }

  // ---- 颈/头：胸口孩子里持续向上且侧向小的链 ----
  const neckRoot = kids(chest)
    .filter((c) => !armRoots.includes(c) && subMax.get(c)! > elev(chest) + 0.04 * H)
    .sort((a, b) => subMax.get(b)! - subMax.get(a)!)[0];
  if (neckRoot) {
    const up: THREE.Bone[] = [neckRoot];
    let c = neckRoot;
    while (true) {
      const next = kids(c)
        .filter((x) => elev(x) > elev(c) - 0.01 * H && Math.abs(lat(x)) < 0.12 * H)
        .sort((a, b) => subMax.get(b)! - subMax.get(a)!)[0];
      if (!next || up.length > 4) break;
      up.push(next);
      c = next;
    }
    map[up[0].name] = "DEF-neck";
    map[(up[1] ?? up[0]).name] = "DEF-head";
  }

  // 核心骨骼齐全才算成功（髋+双腿+双臂+头）
  const vals = new Set(Object.values(map));
  const need = ["DEF-hips", "DEF-thigh.L", "DEF-thigh.R", "DEF-upper_arm.L", "DEF-upper_arm.R"];
  if (!need.every((n) => vals.has(n))) return null;
  return map;
}

interface MotionLib {
  sourceRoot: THREE.Object3D;
  source: THREE.SkinnedMesh;
  clips: THREE.AnimationClip[];
  /** 源骨骼绑定姿态的世界旋转（重定向基准） */
  bindWorldQuat: Map<string, THREE.Quaternion>;
  /** 源髋骨绑定世界位置与名字 */
  hipsBindPos: THREE.Vector3;
  /** 头骨局部坐标系下的"面朝"方向（UAL 绑定姿态面朝 +Z 标定） */
  headForward: THREE.Vector3;
}

let libPromise: Promise<MotionLib> | null = null;

function loadLib() {
  libPromise ??= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      LIB_URL,
      (gltf) => {
        const source = findSkinnedMesh(gltf.scene);
        if (!source) {
          reject(new Error("动作库中未找到蒙皮骨架"));
          return;
        }
        gltf.scene.updateMatrixWorld(true);
        const bindWorldQuat = new Map<string, THREE.Quaternion>();
        for (const b of source.skeleton.bones) {
          bindWorldQuat.set(b.name, b.getWorldQuaternion(new THREE.Quaternion()));
        }
        const hips = source.skeleton.bones.find((b) => b.name === "DEF-hips");
        const headForward = new THREE.Vector3(0, 0, 1);
        const head = source.skeleton.bones.find((b) => b.name === "DEF-head");
        if (head) {
          const q = head.getWorldQuaternion(new THREE.Quaternion()).invert();
          headForward.applyQuaternion(q);
        }
        resolve({
          sourceRoot: gltf.scene,
          source,
          clips: gltf.animations ?? [],
          bindWorldQuat,
          hipsBindPos: hips ? hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(),
          headForward,
        });
      },
      undefined,
      (e) => reject(e)
    );
  });
  return libPromise;
}

/**
 * 推断模型面朝角（当前姿态下脸的朝向——用户视觉上认的就是脸）。
 *
 * 原理：重定向保证目标头骨世界朝向跟随源骨架；用 UAL 绑定姿态（已知面朝 +Z）
 * 标定出头骨局部系的"面朝"向量，再读目标头骨的世界四元数即得真实脸朝向。
 * 肩线/骨盆线/全身 PCA 等几何法都会被站姿扭转、披发体量带偏（实测 30°+），
 * 头骨标定法不受影响。返回相对 +Z 的偏航角；无法推断时返回 null。
 */
export async function forwardCorrection(
  root: THREE.Object3D,
  names: Record<string, string>
): Promise<number | null> {
  const target = findSkinnedMesh(root);
  if (!target) return null;
  root.updateMatrixWorld(true);
  const head = target.skeleton.bones.find((b) => names[b.name] === "DEF-head");
  if (!head) return null;
  const { headForward } = await loadLib();
  const fwd = headForward
    .clone()
    .applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-8) return null;
  return Math.atan2(fwd.x, fwd.z);
}

export interface RetargetedMotions {
  clips: Partial<Record<MotionKey, THREE.AnimationClip>>;
  /** 供 AnimationMixer 使用的根（依据重定向产物的轨道路径选择） */
  mixerRoot: THREE.Object3D;
  /** 目标骨骼名 → UAL 骨骼名 映射（朝向校正等复用） */
  names: Record<string, string>;
}

/** 骨骼世界高度（hips 到原点），用于换算位移缩放 */
function hipsWorldY(mesh: THREE.SkinnedMesh, hipsName: string): number {
  const bone = mesh.skeleton.bones.find((b) => b.name === hipsName);
  if (!bone) return 0;
  const v = new THREE.Vector3();
  bone.getWorldPosition(v);
  return Math.abs(v.y);
}

/**
 * 世界空间重定向采样器（自研，替代 SkeletonUtils.retargetClip）。
 *
 * 不变量：目标骨世界旋转(t) = 源骨世界旋转(t) × M，M = 源绑定世界旋转⁻¹ × 目标绑定世界旋转。
 * - 源回到绑定姿态时目标也回到自身绑定 → A-pose/T-pose 绑定差异天然兼容；
 * - 全身共享源动作的世界姿态，仅存常数偏航差（由 forwardCorrection 整体转正），
 *   规避 SkeletonUtils 在跨绑定朝向时头/身混用参考系的问题（实测）。
 * 未映射骨骼（头发/手指等）保持绑定局部姿态随父级运动。
 */
function retargetClipWorld(
  target: THREE.SkinnedMesh,
  lib: MotionLib,
  clip: THREE.AnimationClip,
  names: Record<string, string>,
  scale: number,
  fps = 30
): THREE.AnimationClip {
  const srcByName = new Map(lib.source.skeleton.bones.map((b) => [b.name, b]));
  const isBone = (o: unknown): o is THREE.Bone => !!(o as THREE.Bone)?.isBone;

  // 目标骨骼按层级序（父先于子），记录绑定局部/世界旋转
  const bones = [...target.skeleton.bones].sort((a, b) => {
    const depth = (x: THREE.Object3D) => {
      let d = 0;
      for (let p = x.parent; p; p = p.parent) d++;
      return d;
    };
    return depth(a) - depth(b);
  });
  target.updateMatrixWorld(true);
  const bindLocalQuat = new Map<THREE.Bone, THREE.Quaternion>();
  const bindWorldQuat = new Map<THREE.Bone, THREE.Quaternion>();
  const constParentWorld = new Map<THREE.Bone, THREE.Quaternion>();
  for (const b of bones) {
    bindLocalQuat.set(b, b.quaternion.clone());
    bindWorldQuat.set(b, b.getWorldQuaternion(new THREE.Quaternion()));
    if (!isBone(b.parent)) {
      constParentWorld.set(b, (b.parent ?? target).getWorldQuaternion(new THREE.Quaternion()));
    }
  }
  // 每根映射骨的轴系转换常量 M
  const M = new Map<THREE.Bone, THREE.Quaternion>();
  const srcOf = new Map<THREE.Bone, THREE.Bone>();
  for (const b of bones) {
    const srcName = names[b.name];
    const src = srcName ? srcByName.get(srcName) : undefined;
    if (!src) continue;
    const srcBind = lib.bindWorldQuat.get(src.name);
    if (!srcBind) continue;
    M.set(b, srcBind.clone().invert().multiply(bindWorldQuat.get(b)!));
    srcOf.set(b, src);
  }
  const hipsBone = bones.find((b) => names[b.name] === "DEF-hips") ?? null;
  const srcHips = srcByName.get("DEF-hips") ?? null;
  const hipsBindLocalPos = hipsBone ? hipsBone.position.clone() : new THREE.Vector3();

  // 采样：源场景播放原始 clip，逐帧读世界姿态求目标局部姿态
  const mixer = new THREE.AnimationMixer(lib.sourceRoot);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const dt = clip.duration / (frames - 1);
  const times = new Float32Array(frames);
  const quatValues = new Map<THREE.Bone, Float32Array>();
  for (const b of M.keys()) quatValues.set(b, new Float32Array(frames * 4));
  const hipsPosValues = hipsBone ? new Float32Array(frames * 3) : null;

  const worldQuat = new Map<THREE.Bone, THREE.Quaternion>();
  const q = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  for (let f = 0; f < frames; f++) {
    const t = f * dt;
    times[f] = t;
    mixer.setTime(t);
    lib.sourceRoot.updateMatrixWorld(true);
    for (const b of bones) {
      const parentWorld = isBone(b.parent) ? worldQuat.get(b.parent as THREE.Bone)! : constParentWorld.get(b)!;
      const src = srcOf.get(b);
      if (src) {
        // 期望世界旋转 = 源世界旋转 × M
        src.getWorldQuaternion(q).multiply(M.get(b)!);
        worldQuat.set(b, q.clone());
        inv.copy(parentWorld).invert();
        const local = inv.multiply(q); // 局部 = 父世界⁻¹ × 期望世界
        const arr = quatValues.get(b)!;
        arr[f * 4] = local.x;
        arr[f * 4 + 1] = local.y;
        arr[f * 4 + 2] = local.z;
        arr[f * 4 + 3] = local.w;
      } else {
        worldQuat.set(b, parentWorld.clone().multiply(bindLocalQuat.get(b)!));
      }
    }
    if (hipsBone && srcHips && hipsPosValues) {
      // 髋骨位移：源世界位移差 × 身高比，折回目标父级空间
      const delta = srcHips.getWorldPosition(new THREE.Vector3()).sub(lib.hipsBindPos).multiplyScalar(scale);
      const parentWorld = isBone(hipsBone.parent)
        ? worldQuat.get(hipsBone.parent as THREE.Bone)!
        : constParentWorld.get(hipsBone)!;
      delta.applyQuaternion(inv.copy(parentWorld).invert());
      hipsPosValues[f * 3] = hipsBindLocalPos.x + delta.x;
      hipsPosValues[f * 3 + 1] = hipsBindLocalPos.y + delta.y;
      hipsPosValues[f * 3 + 2] = hipsBindLocalPos.z + delta.z;
    }
  }
  mixer.stopAllAction();

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [b, arr] of quatValues) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`.bones[${b.name}].quaternion`, times as any, arr as any));
  }
  if (hipsBone && hipsPosValues) {
    tracks.push(new THREE.VectorKeyframeTrack(`.bones[${hipsBone.name}].position`, times as any, hipsPosValues as any));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * 为目标模型重定向语义动作集。
 * 非人形/骨骼匹配过少时返回 null（调用方回退旧行为）。
 */
export async function retargetMotionsFor(root: THREE.Object3D): Promise<RetargetedMotions | null> {
  const target = findSkinnedMesh(root);
  if (!target) return null;
  root.updateMatrixWorld(true);

  // 优先骨骼名语义匹配（mixamo 等标准命名），失败回退空间拓扑推断
  let names: Record<string, string> = {};
  for (const b of target.skeleton.bones) {
    const src = CANON_TO_UAL[canonKey(b.name)];
    if (src) names[b.name] = src;
  }
  if (Object.keys(names).length < 12) {
    const inferred = inferHumanoidMap(target);
    if (!inferred) return null;
    names = inferred;
    console.info("[glbMotions] 私有骨骼命名，已按拓扑推断映射", names);
  }

  const lib = await loadLib();

  const tHips = target.skeleton.bones.find((b) => names[b.name] === "DEF-hips")?.name ?? "";
  const scale = (hipsWorldY(target, tHips) || 1) / (Math.abs(lib.hipsBindPos.y) || 1);

  const out: RetargetedMotions = { clips: {}, mixerRoot: target, names };
  for (const key of Object.keys(CLIP_NAMES) as MotionKey[]) {
    const src = THREE.AnimationClip.findByName(lib.clips, CLIP_NAMES[key]);
    if (!src) continue;
    try {
      const clip = retargetClipWorld(target, lib, src, names, scale);
      clip.name = key;
      out.clips[key] = clip;
    } catch (e) {
      console.warn(`[glbMotions] 重定向 ${key} 失败`, e);
    }
  }
  if (!out.clips.idle) return null;
  return out;
}
