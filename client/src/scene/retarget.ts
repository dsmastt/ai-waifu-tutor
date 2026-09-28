import * as THREE from 'three';

/**
 * Mixamo -> VRM animation retargeting.
 *
 * Mixamo FBX files use the `mixamorig:*` skeleton and quaternion tracks per
 * bone. VRM exposes a normalized humanoid skeleton (T-pose) with names like
 * `hips`, `spine`, `chest`, `leftUpperArm`, ... Animations are retargeted by
 * renaming tracks and applying a per-bone static offset computed from both
 * skeletons' bind poses:
 *
 *   L_target(t) = inv(P_target_bind) * P_src_bind * L_src(t)
 *
 * where P_* are the bind world rotations of the mapped parent bones. This is
 * the standard static-offset retarget; both skeletons are T-poses so it is
 * accurate for idle/gesture clips.
 */

export const BONE_MAP: Record<string, string> = {
  'mixamorigHips': 'hips',
  'mixamorigSpine': 'spine',
  'mixamorigSpine1': 'chest',
  'mixamorigSpine2': 'upperChest',
  'mixamorigNeck': 'neck',
  'mixamorigHead': 'head',
  'mixamorigLeftShoulder': 'leftShoulder',
  'mixamorigLeftArm': 'leftUpperArm',
  'mixamorigLeftForeArm': 'leftLowerArm',
  'mixamorigLeftHand': 'leftHand',
  'mixamorigLeftUpLeg': 'leftUpperLeg',
  'mixamorigLeftLeg': 'leftLowerLeg',
  'mixamorigLeftFoot': 'leftFoot',
  'mixamorigLeftToeBase': 'leftToes',
  'mixamorigRightShoulder': 'rightShoulder',
  'mixamorigRightArm': 'rightUpperArm',
  'mixamorigRightForeArm': 'rightLowerArm',
  'mixamorigRightHand': 'rightHand',
  'mixamorigRightUpLeg': 'rightUpperLeg',
  'mixamorigRightLeg': 'rightLowerLeg',
  'mixamorigRightFoot': 'rightFoot',
  'mixamorigRightToeBase': 'rightToes',
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export interface RetargetResult {
  clip: THREE.AnimationClip;
  mapped: number;
  total: number;
}

/**
 * Retarget a Mixamo clip onto the VRM normalized skeleton.
 * `targetBones` maps VRM normalized bone names -> THREE.Bone.
 * `rootCorrection` rotates the whole animation around Y (in degrees) to fix
 * character facing mismatches.
 */
export function retargetMixamoClip(
  fbxRoot: THREE.Object3D,
  srcClip: THREE.AnimationClip,
  targetBones: Map<string, THREE.Bone>,
  rootCorrectionDeg = 0,
): RetargetResult | null {
  // gather source bones by name
  const srcBones = new Map<string, THREE.Bone>();
  fbxRoot.updateMatrixWorld(true);
  fbxRoot.traverse((obj) => {
    const norm = obj.name.replace(/:/g, '');
    if ((obj as THREE.Bone).isBone && BONE_MAP[norm] && !srcBones.has(norm)) {
      srcBones.set(norm, obj as THREE.Bone);
    }
  });

  // bind world rotations (source + target)
  const srcBind = new Map<string, THREE.Quaternion>();
  for (const [name, bone] of srcBones) {
    srcBind.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
  }
  const tgtBind = new Map<string, THREE.Quaternion>();
  for (const [name, bone] of targetBones) {
    tgtBind.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
  }

  const rootCorrection = _q.setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(rootCorrectionDeg),
  );

  // per-source-bone offset
  const offsets = new Map<string, THREE.Quaternion>();
  for (const [srcName, srcBone] of srcBones) {
    const tgtName = BONE_MAP[srcName];
    if (!tgtName || !targetBones.has(tgtName)) continue;

    // nearest mapped ancestor (parent bind chain)
    let parentSrc: THREE.Bone | null = null;
    let p = srcBone.parent;
    while (p) {
      if ((p as THREE.Bone).isBone && BONE_MAP[p.name.replace(/:/g, '')]) {
        parentSrc = p as THREE.Bone;
        break;
      }
      p = p.parent;
    }
    let offset: THREE.Quaternion;
    if (parentSrc && srcBind.has(parentSrc.name) && targetBones.has(BONE_MAP[parentSrc.name])) {
      const parentTgtWorld = tgtBind.get(BONE_MAP[parentSrc.name])!;
      const parentSrcWorld = srcBind.get(parentSrc.name)!;
      offset = _q2.copy(parentTgtWorld).invert().multiply(parentSrcWorld);
    } else if (srcName === 'mixamorigHips') {
      const tgtHips = tgtBind.get('hips');
      const srcHips = srcBind.get(srcName);
      offset = _q2.copy(tgtHips!).invert().multiply(srcHips!).multiply(rootCorrection);
    } else {
      continue;
    }
    offsets.set(srcName, offset.clone());
  }

  // rebuild tracks
  const tracks: THREE.KeyframeTrack[] = [];
  let mapped = 0;
  let total = 0;
  for (const track of srcClip.tracks) {
    total++;
    const parts = track.name.split('.');
    const srcName = parts.slice(0, -1).join('.').replace(/:/g, '');
    const prop = parts[parts.length - 1];
    if (prop !== 'quaternion') continue; // keep her in place: no position tracks
    const tgtName = BONE_MAP[srcName];
    const offset = tgtName ? offsets.get(srcName) : undefined;
    if (!tgtName || !offset) continue;

    const times = (track as THREE.QuaternionKeyframeTrack).times.slice();
    const srcValues = (track as THREE.QuaternionKeyframeTrack).values;
    const values = new Float32Array(srcValues.length);
    for (let i = 0; i < srcValues.length; i += 4) {
      _q.set(srcValues[i], srcValues[i + 1], srcValues[i + 2], srcValues[i + 3]);
      _q.premultiply(offset);
      values[i] = _q.x;
      values[i + 1] = _q.y;
      values[i + 2] = _q.z;
      values[i + 3] = _q.w;
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${tgtName}.quaternion`, times, values));
    mapped++;
  }

  if (mapped === 0) return null;
  return { clip: new THREE.AnimationClip(srcClip.name, srcClip.duration, tracks), mapped, total };
}
