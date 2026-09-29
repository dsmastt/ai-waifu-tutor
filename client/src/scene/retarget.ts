import * as THREE from 'three';

/**
 * Mixamo -> VRM animation retargeting (exact world-space method).
 *
 * Mixamo bones carry baked rotations in their bind pose (e.g. arm bones are
 * rotated 120 deg around X in the T-pose), so static parent offsets cannot
 * retarget them. Instead, per sample we reconstruct the source's world pose
 * from its local track values, map it into the target's frame through both
 * skeletons' bind orientations, and solve the target's local rotations:
 *
 *   W_t(bone) * inv(W_s(bone)) * world_s(bone, t) = world_t(bone, t)
 *   L_t(bone, t) = inv(world_t(parent, t)) * world_t(bone, t)
 *
 * Both hierarchies are walked parent-first, so the target's animated parent
 * is used exactly. Position tracks are dropped (clips stay in place).
 */

export const BONE_MAP: Record<string, string> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

let result_debug: { avgLeanZ: number; pitchDeg: number } = { avgLeanZ: 0, pitchDeg: 0 };

export interface RetargetResult {
  clip: THREE.AnimationClip;
  mapped: number;
  total: number;
  /** Hips root motion: times (s) + xyz values (FBX units, cm). */
  hipsPos: { times: Float32Array; values: Float32Array } | null;
  /** Convert hipsPos values (cm) to world meters for the target character. */
  bobScale: number;
  debug: { avgLeanZ: number; pitchDeg: number };
}

interface SrcBone {
  name: string;
  bone: THREE.Bone;
  parent: SrcBone | null;
  tgtName: string | null;
  track: THREE.QuaternionKeyframeTrack | null;
}

interface TgtBone {
  name: string;
  bone: THREE.Bone;
  parent: TgtBone | null;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();

const FPS = 30;

export function retargetMixamoClip(
  fbxRoot: THREE.Object3D,
  srcClip: THREE.AnimationClip,
  targetBones: Map<string, THREE.Bone>,
  targetBindWorld: Map<string, THREE.Quaternion>,
  rootCorrectionDeg = 0,
): RetargetResult | null {
  fbxRoot.updateMatrixWorld(true);

  // --- source hierarchy (mapped bones only, parent-first) ---
  const byName = new Map<string, THREE.Bone>();
  fbxRoot.traverse((obj) => {
    const norm = obj.name.replace(/:/g, '');
    if ((obj as THREE.Bone).isBone && BONE_MAP[norm] && !byName.has(norm)) {
      byName.set(norm, obj as THREE.Bone);
    }
  });

  const srcList: SrcBone[] = [];
  const trackMap = new Map<string, THREE.QuaternionKeyframeTrack>();
  for (const track of srcClip.tracks) {
    const parts = track.name.split('.');
    if (parts[parts.length - 1] === 'quaternion') {
      trackMap.set(parts.slice(0, -1).join('.').replace(/:/g, ''), track as THREE.QuaternionKeyframeTrack);
    }
  }
  // include bones that only appear as parents (no own track)
  const seen = new Set<string>();
  const visit = (name: string, parent: SrcBone | null): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const bone = byName.get(name);
    if (!bone) return;
    const mappedName = BONE_MAP[name];
    const tgtName = mappedName && targetBones.has(mappedName) ? mappedName : null;
    // pass-through nodes (unmapped bones like upperChest/shoulders) stay in
    // the list so their rotations contribute to the world reconstruction,
    // but are not mapped onto the target
    const node: SrcBone = {
      name,
      bone,
      parent,
      tgtName,
      track: trackMap.get(name) ?? null,
    };
    srcList.push(node);
    for (const child of bone.children) {
      const cname = child.name.replace(/:/g, '');
      if (byName.has(cname) || trackMap.has(cname)) visit(cname, node);
    }
  };
  if (byName.has('mixamorigHips')) visit('mixamorigHips', null);
  if (srcList.length === 0) return null;

  // --- target hierarchy mirror ---
  const tgtList: TgtBone[] = [];
  for (const src of srcList) {
    if (!src.tgtName) continue;
    const bone = targetBones.get(src.tgtName)!;
    let parent: TgtBone | null = null;
    if (src.parent) {
      const p = src.parent;
      // find the nearest mapped ancestor that exists in tgtList
      let probe: SrcBone | null = p;
      while (probe) {
        const found = tgtList.find((t) => t.name === probe!.tgtName);
        if (found) {
          parent = found;
          break;
        }
        probe = probe.parent;
      }
    }
    tgtList.push({ name: src.tgtName, bone, parent });
  }

  // --- bind world orientations ---
  const srcBind = new Map<SrcBone, THREE.Quaternion>();
  for (const s of srcList) {
    srcBind.set(s, s.bone.getWorldQuaternion(new THREE.Quaternion()));
  }
  const tgtBind = new Map<TgtBone, THREE.Quaternion>();
  for (const t of tgtList) {
    const bind = targetBindWorld.get(t.name);
    tgtBind.set(t, bind ? bind.clone() : t.bone.getWorldQuaternion(new THREE.Quaternion()));
  }

  const rootCorrection = _q.setFromAxisAngle(_axis.set(0, 1, 0), THREE.MathUtils.degToRad(rootCorrectionDeg));

  // --- resample ---
  let duration = Math.max(srcClip.duration, 0.1);
  let frames = Math.max(2, Math.ceil(duration * FPS));
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = (duration * f) / (frames - 1);

  const samples = new Map<string, Float32Array>(); // tgtName -> frames*4
  const srcWorld = new Map<SrcBone, THREE.Quaternion>();
  const srcLocal = new Map<SrcBone, THREE.Quaternion>();
  const tgtWorld = new Map<TgtBone, THREE.Quaternion>();
  // accumulate the chest's average world orientation (relative to its bind)
  // so the whole clip can be leveled by the VISIBLE posture, not the root
  const chestTgt = tgtList.find((t) => t.name === 'chest') ?? tgtList.find((t) => t.name === 'spine');
  const chestBind = chestTgt ? tgtBind.get(chestTgt) ?? null : null;
  const avgChestDelta = new THREE.Quaternion();
  let avgSign: number | null = null;
  // visible lean: average head-vs-hips offset in target space (meters)
  const headTgt = tgtList.find((t) => t.name === 'head');
  const chainNames = ['hips', 'spine', 'chest', 'neck', 'head'];
  let leanSumX = 0;
  let leanSumZ = 0;
  let heightSum = 0;
  let leanFrames = 0;

  const interpolants = new Map<string, THREE.Interpolant>();
  const at = (track: THREE.QuaternionKeyframeTrack | null, t: number, out: THREE.Quaternion): THREE.Quaternion => {
    if (!track) return out.set(0, 0, 0, 1);
    let interpolant = interpolants.get(track.name);
    if (!interpolant) {
      interpolant = track.createInterpolant();
      interpolants.set(track.name, interpolant);
    }
    interpolant.evaluate(t);
    const buf = interpolant.resultBuffer;
    return out.set(buf[0], buf[1], buf[2], buf[3]);
  };

  for (let f = 0; f < frames; f++) {
    const t = times[f];
    // source world pose from locals (parent-first)
    for (const s of srcList) {
      const local = at(s.track, t, _q);
      srcLocal.set(s, local.clone());
      if (s.parent) {
        // NOTE: clone - the temp quaternions are reused, storing them
        // directly would alias every map entry to one object
        srcWorld.set(s, _q2.copy(srcWorld.get(s.parent)!).multiply(local).clone());
      } else {
        srcWorld.set(s, local.clone());
      }
    }
    // map to target
    for (const tgt of tgtList) {
      // find the corresponding source node
      const src = srcList.find((s) => s.tgtName === tgt.name)!;
      // world-space delta convention: the source's world rotation delta from
      // its bind is applied to the target's bind orientation:
      //   world_t = (world_s * inv(W_s)) * W_t
      // (the conjugated variant W_t * inv(W_s) * world_s assumes matching
      // bone frames; Mixamo and VRoid limb frames differ wildly in bind, so
      // conjugation sends arms swinging around the wrong axes)
      const delta = _q.copy(srcWorld.get(src)!).multiply(_q2.copy(srcBind.get(src)!).invert());
      const worldT = delta.multiply(tgtBind.get(tgt)!);
      let local: THREE.Quaternion;
      if (tgt.parent) {
        local = _q2.copy(tgtWorld.get(tgt.parent)!).invert().multiply(worldT);
      } else {
        local = worldT.clone();
        if (tgt.name === 'hips') local.premultiply(rootCorrection);
      }
      tgtWorld.set(tgt, worldT.clone());
      if (tgt === chestTgt && chestBind) {
        const delta = _q2.copy(worldT).multiply(_q.copy(chestBind).invert()).clone();
        if (avgSign === null) avgSign = delta.w >= 0 ? 1 : -1;
        const s = delta.w >= 0 ? 1 : -1;
        avgChestDelta.x += delta.x * s;
        avgChestDelta.y += delta.y * s;
        avgChestDelta.z += delta.z * s;
        avgChestDelta.w += delta.w * s;
      }
      let arr = samples.get(tgt.name);
      if (!arr) {
        arr = new Float32Array(frames * 4);
        samples.set(tgt.name, arr);
      }
      arr[f * 4] = local.x;
      arr[f * 4 + 1] = local.y;
      arr[f * 4 + 2] = local.z;
      arr[f * 4 + 3] = local.w;
    }

    // visible lean accumulation (target-space, after the chain is solved):
    // the head's world offset from the hips, summing each chain bone's
    // rotated local offset
    if (headTgt) {
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let ci = 0; ci < chainNames.length - 1; ci++) {
        const t = tgtList.find((tt) => tt.name === chainNames[ci]);
        const nxt = tgtList.find((tt) => tt.name === chainNames[ci + 1]);
        if (!t || !nxt) continue;
        const wq = tgtWorld.get(t);
        if (!wq) continue;
        const off = _v.copy(nxt.bone.position).applyQuaternion(wq);
        px += off.x;
        py += off.y;
        pz += off.z;
      }
      leanSumX += px;
      leanSumZ += pz;
      heightSum += py;
      leanFrames++;
    }

    if (f === 0) {
      // sanity: reconstructed source bind should match the loaded bind pose
      const err = srcWorld.get(srcList[0])!.angleTo(srcBind.get(srcList[0])!);
      if (err > 0.35) {
        console.warn(
          `[anim] bind/track mismatch in ${srcClip.name}: ${err.toFixed(2)} rad`,
        );
      }
    }
  }

  // final leveling correction: rotate the whole clip so the average visible
  // posture (chest) returns to upright, removing constant leans while
  // preserving motion around the average. The correction is distributed
  // through the spine chain (not dumped on the pelvis) so the stance stays
  // natural.
  let levelCorrection: THREE.Quaternion | null = null;
  if (avgSign !== null && avgChestDelta.lengthSq() > 1e-8) {
    avgChestDelta.normalize();
    levelCorrection = avgChestDelta.clone().invert();
  }
  // correct the measured visible lean: rotate around X/Z so the average
  // head offset from the hips matches the model's natural bind posture
  let debugPitch = 0;
  let debugAvgZ = 0;
  if (levelCorrection && leanFrames > 0) {
    const avgX = leanSumX / leanFrames;
    const avgZ = leanSumZ / leanFrames;
    const height = Math.max(0.3, heightSum / leanFrames);
    debugAvgZ = avgZ;
    const pitch = -Math.asin(THREE.MathUtils.clamp(avgZ / height, -0.6, 0.6));
    const roll = Math.asin(THREE.MathUtils.clamp(avgX / height, -0.6, 0.6));
    debugPitch = pitch;
    const fix = _q.setFromEuler(new THREE.Euler(pitch, 0, roll, 'XYZ'));
    levelCorrection = fix.clone().multiply(levelCorrection);
  }
  result_debug = { avgLeanZ: debugAvgZ, pitchDeg: (debugPitch * 180) / Math.PI };
  const identity = new THREE.Quaternion();
  const levelParts: Record<string, number> = { hips: 0.45, spine: 0.3, chest: 0.25 };
  const partCache = new Map<string, THREE.Quaternion>();
  if (levelCorrection) {
    for (const [bone, frac] of Object.entries(levelParts)) {
      partCache.set(bone, new THREE.Quaternion().slerpQuaternions(identity, levelCorrection, frac));
    }
  }

  // hips root motion (kept so feet plant correctly: the source hips carry
  // the weight shifts side-to-side and the vertical bob)
  let hipsPos: RetargetResult['hipsPos'] = null;
  const hipsSrc = srcList.find((s) => s.name === 'mixamorigHips');
  const hipsPosTrack = hipsSrc
    ? (srcClip.tracks.find(
        (t) => t.name === 'mixamorigHips.position' || t.name === 'mixamorig:Hips.position',
      ) as THREE.VectorKeyframeTrack | undefined)
    : undefined;
  if (hipsPosTrack) {
    const interpolant = hipsPosTrack.createInterpolant();
    const raw = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const buf = interpolant.evaluate(times[f]) as unknown as Float32Array;
      raw[f * 3] = buf[0];
      raw[f * 3 + 1] = buf[1];
      raw[f * 3 + 2] = buf[2];
    }
    // Detrend X/Z with a moving average (~3s window): clips downloaded
    // without Mixamo's "In Place" option carry a slow wander that would
    // otherwise slide the feet across the floor. The fast weight shifts
    // survive untouched. Y keeps full motion (vertical bob).
    const win = Math.max(2, Math.round(FPS * 3));
    const out = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const from = Math.max(0, f - win);
      const to = Math.min(frames, f + win);
      const n = to - from;
      let sx = 0;
      let sz = 0;
      for (let k = from; k < to; k++) {
        sx += raw[k * 3];
        sz += raw[k * 3 + 2];
      }
      out[f * 3] = raw[f * 3] - sx / n;
      out[f * 3 + 1] = raw[f * 3 + 1];
      out[f * 3 + 2] = raw[f * 3 + 2] - sz / n;
    }
    hipsPos = { times: times.slice(), values: out };
  }

  // trim neutral bookends: Mixamo action clips typically start and end at
  // the bind (T-pose). A one-shot clamping its last frame would flash that
  // pose, and durations include dead time. Slice to the active range.
  {
    const devs = new Float32Array(frames);
    for (const tgt of tgtList) {
      const arr = samples.get(tgt.name);
      if (!arr) continue;
      const bind = tgtBind.get(tgt)!;
      for (let f = 0; f < frames; f++) {
        _q.set(arr[f * 4], arr[f * 4 + 1], arr[f * 4 + 2], arr[f * 4 + 3]);
        const dev = 1 - Math.abs(_q.dot(bind));
        if (dev > devs[f]) devs[f] = dev;
      }
    }
    let f0 = 0;
    while (f0 < frames - 1 && devs[f0] < 0.002) f0++;
    let f1 = frames - 1;
    while (f1 > f0 && devs[f1] < 0.002) f1--;
    const pad = Math.round(FPS * 0.2);
    f0 = Math.max(0, f0 - pad);
    f1 = Math.min(frames - 1, f1 + pad);
    if (f0 > 0 || f1 < frames - 1) {
      const newFrames = f1 - f0 + 1;
      if (newFrames >= Math.round(FPS * 0.5)) {
        const newTimes = new Float32Array(newFrames);
        const t0 = times[f0];
        for (let f = 0; f < newFrames; f++) newTimes[f] = times[f0 + f] - t0;
        for (const [name, arr] of samples) {
          const sliced = new Float32Array(newFrames * 4);
          sliced.set(arr.subarray(f0 * 4, (f1 + 1) * 4));
          samples.set(name, sliced);
        }
        if (hipsPos) {
          const sliced = new Float32Array(newFrames * 3);
          sliced.set(hipsPos.values.subarray(f0 * 3, (f1 + 1) * 3));
          hipsPos = { times: newTimes, values: sliced };
        }
        for (let f = 0; f < newFrames; f++) times[f] = newTimes[f];
        frames = newFrames;
        duration = Math.max(0.1, times[newFrames - 1]);
      }
    }
  }

  // build tracks (named after the target bones' actual node names so an
  // AnimationMixer on the model root can bind them directly)
  const tracks: THREE.KeyframeTrack[] = [];
  for (const tgt of tgtList) {
    let arr = samples.get(tgt.name);
    if (!arr) continue;

    const part = partCache.get(tgt.name);
    if (part) {
      const leveled = new Float32Array(arr.length);
      for (let f = 0; f < frames; f++) {
        const q = new THREE.Quaternion(arr[f * 4], arr[f * 4 + 1], arr[f * 4 + 2], arr[f * 4 + 3]);
        q.premultiply(part);
        leveled[f * 4] = q.x;
        leveled[f * 4 + 1] = q.y;
        leveled[f * 4 + 2] = q.z;
        leveled[f * 4 + 3] = q.w;
      }
      arr = leveled;
    }

    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${tgt.bone.name}.quaternion`, times.slice(), arr),
    );
  }

  // scale: mixamo rigs are ~180 cm tall; the target is ~1.62 world units
  let mixamoHeightCm = 180;
  const head = byName.get('mixamorigHead');
  const foot = byName.get('mixamorigLeftFoot');
  if (head && foot) {
    const hy = head.getWorldPosition(_v).y;
    const fy = foot.getWorldPosition(_v).y;
    mixamoHeightCm = Math.max(50, Math.abs(hy - fy));
  }
  const bobScale = 1.62 / (mixamoHeightCm / 100);

  return {
    clip: new THREE.AnimationClip(srcClip.name, duration, tracks),
    mapped: tracks.length,
    total: srcClip.tracks.length,
    hipsPos,
    bobScale,
    debug: result_debug,
  };
}
