/**
 * VMD 舞蹈 → VRM 重定向播放（路线图 P1：真动作资产替换程序化占位）
 *
 * - 解析：mmd-parser（leftToRight=true 转换为 three.js 右手系）
 * - 骨骼：MMD 日文骨名 → VRM humanoid 标准骨名
 * - 姿态差修正：MMD 模型 rest pose 手臂自然下垂 ~37°，VRM 为 T-pose，
 *   对上臂叠加固定补偿四元数，使世界朝向一致
 * - 采样：30fps 关键帧，播放时按时间二分查找 + 球面插值
 */
import * as THREE from "three";
import { Parser } from "mmd-parser";

/** MMD 标准骨名 → VRM humanoid 骨名 */
const BONE_MAP: Record<string, string> = {
  "センター": "hips",
  "下半身": "hips", // 旋转分量并入 hips（VRM 无下半身骨）
  "上半身": "spine",
  "上半身2": "chest",
  "首": "neck",
  "頭": "head",
  "左肩": "leftShoulder",
  "左腕": "leftUpperArm",
  "左ひじ": "leftLowerArm",
  "左手首": "leftHand",
  "右肩": "rightShoulder",
  "右腕": "rightUpperArm",
  "右ひじ": "rightLowerArm",
  "右手首": "rightHand",
  "左足": "leftUpperLeg",
  "左ひざ": "leftLowerLeg",
  "左足首": "leftFoot",
  "右足": "rightUpperLeg",
  "右ひざ": "rightLowerLeg",
  "右足首": "rightFoot",
};

/** MMD 1单位 ≈ 0.08m（标准 miku 身高 20 单位 ≈ 1.58m） */
const MMD_UNIT = 0.079;

export interface BoneTrack {
  times: Float32Array;
  /** 每帧四元数 [x,y,z,w] */
  rots: Float32Array;
  /** 仅 hips（センター）有位移 [x,y,z]（米） */
  pos?: Float32Array;
}

export interface DanceClip {
  duration: number;
  tracks: Map<string, BoneTrack>;
}

/** 上臂 rest-pose 补偿（MMD 手臂下垂 ~37° vs VRM T-pose） */
const ARM_FIX: Record<string, THREE.Quaternion> = {
  leftUpperArm: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-37 / 180) * Math.PI),
  rightUpperArm: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (37 / 180) * Math.PI),
};

export async function loadVmdClip(url: string): Promise<DanceClip> {
  const buf = await (await fetch(url)).arrayBuffer();
  const vmd = new Parser().parseVmd(buf, true); // leftToRight=true → three.js 右手系
  type Key = { frame: number; rot: THREE.Quaternion; pos: THREE.Vector3 };
  const byBone = new Map<string, Key[]>();

  for (const m of vmd.motions as any[]) {
    const vrmBone = BONE_MAP[m.boneName];
    if (!vrmBone) continue;
    let arr = byBone.get(m.boneName);
    if (!arr) byBone.set(m.boneName, (arr = []));
    arr.push({
      frame: m.frameNum,
      rot: new THREE.Quaternion(m.rotation[0], m.rotation[1], m.rotation[2], m.rotation[3]),
      pos: new THREE.Vector3(m.position[0], m.position[1], m.position[2]),
    });
  }

  let maxFrame = 0;
  const tracks = new Map<string, BoneTrack>();

  for (const [mmdName, keys] of byBone) {
    keys.sort((a, b) => a.frame - b.frame);
    maxFrame = Math.max(maxFrame, keys[keys.length - 1].frame);
    const vrmBone = BONE_MAP[mmdName]!;
    const n = keys.length;
    const times = new Float32Array(n);
    const rots = new Float32Array(n * 4);
    const isCenter = mmdName === "センター";
    const pos = isCenter ? new Float32Array(n * 3) : undefined;
    const fix = ARM_FIX[vrmBone];
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      times[i] = keys[i].frame / 30;
      q.copy(keys[i].rot);
      if (fix) q.premultiply(fix); // 世界侧补偿 rest-pose 差
      rots[i * 4] = q.x; rots[i * 4 + 1] = q.y; rots[i * 4 + 2] = q.z; rots[i * 4 + 3] = q.w;
      if (pos) {
        pos[i * 3] = keys[i].pos.x * MMD_UNIT;
        pos[i * 3 + 1] = keys[i].pos.y * MMD_UNIT;
        pos[i * 3 + 2] = keys[i].pos.z * MMD_UNIT;
      }
    }
    // 下半身与センター都映射到 hips：分别存（采样时旋转用下半身、位移用センター）
    const trackKey = mmdName === "下半身" ? "hips" : mmdName === "センター" ? "__center" : vrmBone;
    tracks.set(trackKey, { times, rots, pos });
  }

  return { duration: maxFrame / 30, tracks };
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function sampleTrack(t: BoneTrack, time: number, outRot: THREE.Quaternion, outPos?: THREE.Vector3) {
  const times = t.times;
  const n = times.length;
  // 二分查找右边界
  let lo = 0, hi = n - 1;
  if (time <= times[0]) hi = 0;
  else if (time >= times[n - 1]) lo = n - 1;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= time) lo = mid;
      else hi = mid;
    }
  }
  if (lo === hi || lo === n - 1) {
    const i = Math.min(lo, n - 1);
    outRot.fromArray(t.rots, i * 4);
    if (outPos && t.pos) outPos.fromArray(t.pos, i * 3);
    return;
  }
  const a = lo, b = lo + 1;
  const f = (time - times[a]) / Math.max(1e-6, times[b] - times[a]);
  _qa.fromArray(t.rots, a * 4);
  _qb.fromArray(t.rots, b * 4);
  outRot.copy(_qa).slerp(_qb, f);
  if (outPos && t.pos) {
    outPos.set(
      t.pos[a * 3] + (t.pos[b * 3] - t.pos[a * 3]) * f,
      t.pos[a * 3 + 1] + (t.pos[b * 3 + 1] - t.pos[a * 3 + 1]) * f,
      t.pos[a * 3 + 2] + (t.pos[b * 3 + 2] - t.pos[a * 3 + 2]) * f,
    );
  }
}

const _rot = new THREE.Quaternion();
const _center = new THREE.Quaternion();
const _lower = new THREE.Quaternion();
const _lowerInv = new THREE.Quaternion();
const _centerPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();

/**
 * 把舞蹈姿态以权重 weight 混合到骨骼上（与待机姿态交叉淡入）。
 *
 * 骨架结构差异补偿：MMD 中「上半身」「下半身」都是センター的子骨（兄弟），
 * VRM 中 spine 是 hips 的子骨 —— hips=センター·下半身，spine=inv(下半身)·上半身。
 *
 * @param flip VRM0 模型坐标系绕 Y 翻转（四元数 x/z 取反）
 */
export function applyDancePose(
  clip: DanceClip,
  time: number,
  bones: Record<string, THREE.Object3D | null>,
  hipsBasePos: THREE.Vector3 | null,
  weight: number,
  flip: boolean
) {
  const t = time % clip.duration;

  // センター（位移 + 旋转）与 下半身（骨盆旋转）
  const centerTrack = clip.tracks.get("__center");
  const lowerTrack = clip.tracks.get("hips");
  _center.identity();
  _lower.identity();
  _centerPos.set(0, 0, 0);
  if (centerTrack) sampleTrack(centerTrack, t, _center, _centerPos);
  if (lowerTrack) sampleTrack(lowerTrack, t, _lower);
  _lowerInv.copy(_lower).invert();

  for (const [name, track] of clip.tracks) {
    if (name === "__center") continue;
    const bone = bones[name];
    if (!bone) continue;
    if (name === "hips") {
      _rot.copy(_lower).premultiply(_center); // hips = センター · 下半身
      if (hipsBasePos) {
        const px = flip ? -_centerPos.x : _centerPos.x;
        const pz = flip ? -_centerPos.z : _centerPos.z;
        _targetPos.set(hipsBasePos.x + px, hipsBasePos.y + _centerPos.y, hipsBasePos.z + pz);
        bone.position.lerp(_targetPos, weight);
      }
    } else {
      sampleTrack(track, t, _rot);
      if (name === "spine") _rot.premultiply(_lowerInv); // 抵消 hips 多出的下半身旋转
    }
    if (flip) {
      _rot.x = -_rot.x;
      _rot.z = -_rot.z;
    }
    bone.quaternion.slerp(_rot, weight);
  }
}
