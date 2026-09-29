import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { ClipLibrary } from './clips';

const EXPRESSION_PRESETS = {
  happy: ['happy'],
  sad: ['sad'],
  angry: ['angry'],
  surprised: ['surprised'],
  relaxed: ['relaxed'],
  neutral: [] as string[],
} as Record<string, string[]>;

const VISEME_PRESET: Record<string, string> = {
  aa: 'aa',
  ih: 'ih',
  ou: 'ou',
  ee: 'ee',
  oh: 'oh',
};

export interface GestureRequest {
  name: string;
  target?: THREE.Vector3 | null;
}

interface ActiveGesture {
  name: string;
  t: number;
  duration: number;
  target: THREE.Vector3 | null;
}

const _q = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _tmpQuatSmooth = new THREE.Quaternion();
const _qFromTo = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const _qLayered = new THREE.Quaternion();
const _qOutward = new THREE.Quaternion();
const _deltaDir = new THREE.Vector3();
const _deltaDir2 = new THREE.Vector3();
const _rootTmp = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _dirUpper = new THREE.Vector3();
const _dirLower = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function fromToQuat(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const d = from.dot(to);
  if (d < -0.999999) {
    _axis.set(0, 1, 0);
    if (Math.abs(_axis.dot(from)) > 0.9) _axis.set(1, 0, 0);
    return out.set(_axis.x, _axis.y, _axis.z, 0).normalize();
  }
  _axis.crossVectors(from, to);
  return out.set(_axis.x, _axis.y, _axis.z, 1 + d).normalize();
}

export class TutorCharacter {
  vrm: VRM | null = null;
  readonly group = new THREE.Group();
  loaded = false;

  private bones = new Map<string, THREE.Bone | null>();
  private restWorld = new Map<THREE.Bone, THREE.Quaternion>();
  private restArmDirs = new Map<string, THREE.Vector3>();
  private armLengths = new Map<string, number>();
  private headForwardLocal: THREE.Vector3 | null = null;
  private forward = new THREE.Vector3(0, 0, 1);
  private right = new THREE.Vector3(-1, 0, 0);
  private hasExpression = new Map<string, boolean>();
  private blinkName: string | null = null;

  // gaze state
  private gazeMode: 'me' | 'window' | 'random' | 'none' = 'me';
  private gazeTarget: THREE.Vector3 | null = null;
  private curYaw = 0;
  private curPitch = 0;
  private desiredYaw = 0;
  private desiredPitch = 0;
  private bodyYaw = 0;
  private curBodyYaw = 0;
  private saccadeTimer = 2;
  private saccadeRemain = 0;
  private saccadeYaw = 0;
  private saccadePitch = 0;

  // idle
  private blinkTimer = 2.0;
  private blinkPhase = -1;
  private blinkDuration = 0.1;
  private nextBlinkDelay = 2.5;

  // expressions
  private exprWeights = new Map<string, number>();
  private viseme: { v: string; weight: number } | null = null;
  private visemeWeight = 0;

  // gestures
  private gesture: ActiveGesture | null = null;
  private headOffset = { yaw: 0, pitch: 0, roll: 0 };

  // animation clips (Mixamo, optional)
  clips: ClipLibrary | null = null;
  private rawBind = new Map<string, THREE.Quaternion>();
  private speaking = false;
  private idleVariantTimer = 14;

  // idle life
  private idleGestureTimer = 8;
  private lookAroundTimer = 4;
  private listening = false;
  private listenLean = 0;
  private groundBias = 0;
  private leanFixPitch = 0;
  private lastGestureAt = 0;
  private lastExprName = '';
  private lastExprAt = 0;
  private leanFixRoll = 0;

  // breath
  private breathePhase = 0;

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register(
      (parser) =>
        new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }),
    );
    const gltf = await loader.loadAsync(url);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    const vrm = gltf.userData.vrm as VRM;
    this.vrm = vrm;
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });
    this.group.add(vrm.scene);
    this.loaded = true;

    // fit scale + ground the feet
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    const height = size.y || 1;
    const scale = 1.62 / height;
    vrm.scene.scale.setScalar(scale);
    vrm.scene.position.y = -box.min.y * scale;

    // disable the VRM's own look-at; we drive gaze procedurally
    (vrm as unknown as { lookAt: unknown }).lookAt = null;

    // animations and procedural poses both drive the RAW skeleton directly
    // (autoUpdateHumanBones is off; the normalized-rig conjugation would
    // re-frame every rotation and distort poses)
    vrm.scene.updateMatrixWorld(true);
    this.clips = new ClipLibrary(vrm.scene);

    this.captureBones();
    this.captureExpressions();
    this.captureRawBind();

    // forward direction from the hips
    const hips = this.bone('hips');
    if (hips) {
      hips.getWorldQuaternion(_q);
      this.forward.set(0, 0, 1).applyQuaternion(_q).setY(0).normalize();
      this.right.crossVectors(this.forward, UP).normalize();
    }
    // the head's forward axis in its own local frame (for delta gaze)
    const headBone = this.bone('head');
    const restHead = headBone && this.restWorld.get(headBone);
    if (restHead) {
      this.headForwardLocal = this.forward.clone().applyQuaternion(restHead.clone().invert());
    }
  }

  private captureBones(): void {
    const vrm = this.vrm!;
    // ensure the scaled/positioned world matrices are current before
    // measuring bone offsets (otherwise lengths come out in native units)
    vrm.scene.updateMatrixWorld(true);
    const names = [
      'hips', 'spine', 'chest', 'neck', 'head',
      'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightUpperArm', 'rightLowerArm', 'rightHand',
    ] as const;
    for (const n of names) {
      const node = vrm.humanoid!.getRawBoneNode(
        VRMHumanBoneName[
          n.charAt(0).toUpperCase() + n.slice(1) as keyof typeof VRMHumanBoneName
        ],
      ) as THREE.Bone | null;
      this.bones.set(n, node);
      if (node) {
        this.restWorld.set(node, node.getWorldQuaternion(new THREE.Quaternion()));
      }
    }
    // arm segment directions at rest (works for T-pose and A-pose alike)
    const pairs: [string, string][] = [
      ['rightUpperArm', 'rightLowerArm'],
      ['leftUpperArm', 'leftLowerArm'],
      ['rightLowerArm', 'rightHand'],
      ['leftLowerArm', 'leftHand'],
    ];
    for (const [a, b] of pairs) {
      const A = this.bone(a);
      const B = this.bone(b);
      if (A && B) {
        const p1 = A.getWorldPosition(new THREE.Vector3());
        const p2 = B.getWorldPosition(new THREE.Vector3());
        this.restArmDirs.set(a, p2.sub(p1).normalize());
        this.armLengths.set(a, p1.distanceTo(p2));
      }
    }
  }

  private captureExpressions(): void {
    const vrm = this.vrm!;
    for (const exp of vrm.expressionManager!.expressions) {
      this.hasExpression.set(exp.expressionName.toLowerCase(), true);
    }
    if (this.hasExpression.get('blink')) this.blinkName = 'blink';
    else if (this.hasExpression.get('blinkleft') && this.hasExpression.get('blinkright')) {
      this.blinkName = 'blink_lr';
    }
  }

  private bone(name: string): THREE.Bone | null {
    return this.bones.get(name) ?? null;
  }

  // ------------------------------------------------------------------ actions

  setExpression(name: string, intensity = 1): void {
    const key = name.toLowerCase();
    // debounce expression changes: rapid alternation makes the face flap
    const nowS = performance.now() / 1000;
    if (key !== this.lastExprName && nowS - this.lastExprAt < 0.7) return;
    this.lastExprName = key;
    this.lastExprAt = nowS;
    const presets = EXPRESSION_PRESETS[key] ?? [];
    const mult = Math.max(0, Math.min(1, intensity));
    for (const p of presets) {
      if (this.hasExpression.get(p)) {
        this.raise(p, mult);
      }
    }
    if (key === 'thinking') {
      this.playGesture('think');
    } else if (key === 'angry') {
      this.playGesture('angry');
    } else if (key === 'sad' && mult > 0.6) {
      this.playGesture('sad');
    }
  }

  private raise(preset: string, value: number): void {
    this.exprWeights.set(preset, Math.max(this.exprWeights.get(preset) ?? 0, value));
  }

  lookAt(target: 'me' | 'board' | 'random' | 'none' | string, windowPos?: THREE.Vector3 | null): void {
    if (target === 'me') this.gazeMode = 'me';
    else if (target === 'random') this.gazeMode = 'random';
    else if (target === 'none') this.gazeMode = 'none';
    else if (target === 'board' || (target && windowPos)) {
      this.gazeMode = 'window';
      this.gazeTarget = windowPos ? windowPos.clone() : null;
    } else {
      this.gazeMode = 'me';
    }
  }

  setGazePoint(worldPos: THREE.Vector3 | null): void {
    this.gazeTarget = worldPos;
    this.gazeMode = 'window';
  }

  playGesture(name: string, target?: THREE.Vector3 | null): void {
    // rate limit: bursty action streams (the LLM emits several gestures per
    // second) would interrupt every transition mid-flight and thrash
    const nowS = performance.now() / 1000;
    if (nowS - this.lastGestureAt < 1.0) return;
    this.lastGestureAt = nowS;
    // Mixamo one-shot when available (pointing keeps its procedural aim
    // because the clip can't target an arbitrary window)
    const clipName: Record<string, string> = {
      nod: 'nod', shake: 'shake', wave: 'wave', think: 'thinking',
      shrug: 'shrug', clap: 'clap', cheer: 'cheer', sad: 'sad',
      angry: 'angry', lookaway: 'lookaway',
    };
    if (name !== 'point' && this.clips && this.clips.has(clipName[name])) {
      this.clips.playOneShot(clipName[name]);
      return;
    }
    const durations: Record<string, number> = {
      point: 2.4, nod: 1.0, shake: 1.2, wave: 1.6,
      think: 2.8, shrug: 1.2, clap: 1.4, talk: 1.4, stretch: 2.4,
      sad: 1.6, angry: 1.6, lookaway: 1.6,
    };
    this.gesture = {
      name,
      t: 0,
      duration: durations[name] ?? 1.4,
      target: target ?? null,
    };
  }

  /** Talking state: switch the ambient clip while she explains. */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    if (!this.clips) return;
    if (speaking && this.clips.has('talking')) {
      this.clips.crossFade('talking', 0.35);
    } else if (!speaking && this.clips.has('base')) {
      this.clips.crossFade('base', 0.35);
    }
  }

  /** VRM name -> raw bone map, for the animation retargeter. */
  getRawBones(): Map<string, THREE.Bone> {
    const out = new Map<string, THREE.Bone>();
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return out;
    for (const name of Object.keys(humanoid.rawHumanBones)) {
      const node = humanoid.getRawBoneNode(name as never) as THREE.Bone | null;
      if (node) out.set(name, node);
    }
    return out;
  }

  /** VRM name -> bind world quaternion (captured at rest, before any pose). */
  getRawBind(): Map<string, THREE.Quaternion> {
    return this.rawBind;
  }

  private captureRawBind(): void {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return;
    for (const name of Object.keys(humanoid.rawHumanBones)) {
      const node = humanoid.getRawBoneNode(name as never) as THREE.Bone | null;
      if (node) {
        this.rawBind.set(name, node.getWorldQuaternion(new THREE.Quaternion()));
      }
    }
  }

  setViseme(v: string, weight: number): void {
    this.viseme = { v, weight: Math.max(0, Math.min(1, weight)) };
  }

  // ------------------------------------------------------------------ update

  update(dt: number, time: number, camera: THREE.Camera): void {
    if (!this.vrm) return;
    const clipsActive =
      !!this.clips && (this.clips.hasBase || this.clips.oneShotActive);

    let clipRootX = 0;
    let clipRootY = 0;
    let clipRootZ = 0;
    if (this.clips && clipsActive) {
      this.clips.update(dt, _rootTmp);
      clipRootX = _rootTmp.x;
      clipRootY = _rootTmp.y;
      clipRootZ = _rootTmp.z;
    }
    // refresh world matrices after the mixer wrote the clip pose: all the
    // world-space pose math below reads these, and stale (render-time)
    // matrices made corrections fight their own previous state (shivering)
    this.vrm.scene.updateMatrixWorld(true);
    if (clipsActive) this.updateLeanLeveler(dt);
    this.updateGaze(dt, time, camera);
    this.updateIdleLife(dt);
    this.updateBlink(dt, time);
    if (!clipsActive) {
      this.updateBreathing(dt, time);
    } else {
      this.updateClipGestures(dt);
      // layered life: breathing + arm sway composed on top of the clip pose
      this.updateLayeredLife(dt, time);
    }
    // gestures always run: with clips, procedural arms are delta-based and
    // compose on top of the animated pose
    this.updateGestures(dt, time, clipsActive);
    this.updateExpressions(dt);
    this.updatePose();

    // listening lean (head tilt + slight forward lean toward the student)
    const listenTarget = this.listening ? 1 : 0;
    this.listenLean += (listenTarget - this.listenLean) * Math.min(1, dt * 6);
    if (this.listenLean > 0.01) {
      this.headOffset.roll += 0.09 * this.listenLean;
      this.headOffset.pitch -= 0.04 * this.listenLean;
    }

    // vertical grounding: procedural breathing bob, or the clip's root motion
    // plus a self-calibrating bias that settles her lowest foot on the floor
    if (clipsActive) {
      this.updateGroundBias(dt);
      this.group.position.set(
        clipRootX,
        clipRootY + this.groundBias,
        clipRootZ,
      );
    } else {
      this.group.position.y = Math.sin(this.breathePhase * 1.1) * 0.006;
    }

    this.vrm.update(dt);
  }

  /**
   * Procedural life composed ON TOP of an animated clip pose: breathing in
   * the chest and a gentle arm sway, so even a rigid idle clip feels alive.
   * Deltas are applied to the bones' current (animated) orientation.
   */
  private updateLayeredLife(dt: number, time: number): void {
    this.breathePhase += dt;
    const breath = Math.sin(this.breathePhase * 1.35) * 0.028;
    const sway = Math.sin(time * 0.85) * 0.05;

    const chest = this.bone('chest');
    if (chest) {
      chest.getWorldQuaternion(_q);
      const desired = _q
        .clone()
        .multiply(_qLayered.setFromEuler(new THREE.Euler(0, 0, breath)));
      this.smoothTo(chest, desired, dt, 7);
    }
    // arm overlay only while idle: during speech the talking clip owns the
    // arms, and a procedural bias + sway on top looked like two animations
    // fighting (the clash)
    if (this.speaking) return;
    for (const side of ['left', 'right'] as const) {
      const upper = this.bone(`${side}UpperArm`);
      if (!upper) continue;
      // constant outward + slight-forward bias (hands clear the hips) plus
      // sway and breath, composed as world-space premultiplications
      const outward = _qLayered.setFromAxisAngle(_zAxis, side === 'left' ? 0.2 : -0.2);
      const forward = _qOutward.setFromAxisAngle(_xAxis, -0.07);
      const wobble = _qTwist.setFromEuler(
        new THREE.Euler((side === 'left' ? sway : -sway) * 0.7, 0, breath * 0.4),
      );
      const desired = upper
        .getWorldQuaternion(new THREE.Quaternion())
        .premultiply(outward)
        .premultiply(forward)
        .multiply(wobble);
      this.smoothTo(upper, desired, dt, 7);
    }
  }

  /**
   * Runtime lean leveler: measures the OBSERVED head-vs-hips lean and slowly
   * tilts the hips to cancel it. Unlike offline per-clip corrections this
   * closes the loop on what is actually rendered, self-calibrating per clip,
   * and its slow rate keeps transitions smooth.
   */
  private updateLeanLeveler(dt: number): void {
    const head = this.bone('head');
    const hips = this.bone('hips');
    if (!head || !hips) return;
    const hp = head.getWorldPosition(_deltaDir);
    const ip = hips.getWorldPosition(_deltaDir2);
    const height = Math.max(0.3, hp.y - ip.y);
    const targetPitch = THREE.MathUtils.clamp(-(hp.z - ip.z) / height, -0.3, 0.3);
    const targetRoll = THREE.MathUtils.clamp((hp.x - ip.x) / height, -0.3, 0.3);
    this.leanFixPitch += (targetPitch - this.leanFixPitch) * Math.min(1, dt * 0.7);
    this.leanFixRoll += (targetRoll - this.leanFixRoll) * Math.min(1, dt * 0.7);
    const fix = _qOutward.setFromEuler(
      new THREE.Euler(this.leanFixPitch, 0, this.leanFixRoll, 'XYZ'),
    );
    const hipsW = hips.getWorldQuaternion(new THREE.Quaternion()).premultiply(fix);
    this.setBoneWorldRotation(hips, hipsW);
  }

  private updateGroundBias(dt: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    // measure the lowest point of both feet+toes WITHOUT the group offset
    let minFoot = Infinity;
    for (const name of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const) {
      const b = vrm.humanoid!.getRawBoneNode(name as never);
      if (b) minFoot = Math.min(minFoot, b.getWorldPosition(_deltaDir).y);
    }
    if (!Number.isFinite(minFoot)) return;
    const localFoot = minFoot - this.group.position.y;
    // slow continuous tracking (no sliding-window minimum): a window min
    // jumps whenever an extreme sample drops out, jolting the whole body
    const instant = THREE.MathUtils.clamp(0.012 - localFoot, -0.25, 0.25);
    this.groundBias += (instant - this.groundBias) * Math.min(1, dt * 1.2);
  }

  private updateClipGestures(dt: number): void {
    // breathing phase still drives the body bob
    this.breathePhase += dt;
    this.headOffset.yaw *= Math.max(0, 1 - dt * 6);
    this.headOffset.pitch *= Math.max(0, 1 - dt * 6);
    this.headOffset.roll *= Math.max(0, 1 - dt * 6);

    // ambient variety while idle: cycle the idle clips, and occasionally
    // throw in a small one-shot gesture so she never just stands there
    if (!this.speaking && !this.clips!.oneShotActive) {
      this.idleVariantTimer -= dt;
      if (this.idleVariantTimer <= 0) {
        this.idleVariantTimer = 8 + Math.random() * 10;
        const roll = Math.random();
        const alts = this.clips!.variantNames('idleAlt');
        if (roll < 0.12 && this.clips!.has('lookaway')) {
          this.clips!.playOneShot('lookaway', 0.3);
        } else if (roll < 0.2 && this.clips!.has('nod')) {
          this.clips!.playOneShot('nod', 0.3);
        } else if (alts.length) {
          this.clips!.crossFade('idleAlt', 0.5);
          window.setTimeout(() => {
            if (!this.speaking && !this.clips?.oneShotActive) {
              this.clips?.crossFade('base', 0.5);
            }
          }, 8000 + Math.random() * 6000);
        }
      }
    }
  }

  setListening(active: boolean): void {
    this.listening = active;
  }

  private updateIdleLife(dt: number): void {
    // periodic random glances
    this.lookAroundTimer -= dt;
    if (this.lookAroundTimer <= 0) {
      const r = Math.random();
      if (r < 0.4 && this.gazeMode === 'me') {
        this.gazeMode = 'random';
        this.lookAroundTimer = 2 + Math.random() * 3;
      } else {
        if (this.gazeMode === 'random') this.gazeMode = 'me';
        this.lookAroundTimer = 5 + Math.random() * 8;
      }
    }
    // subtle idle gestures when not doing anything else. Procedural arm
    // gestures only run when no clips exist - during clips the mixer owns
    // the arms and a procedural pose would fight it (twitching)
    if (!this.gesture && !this.speaking) {
      this.idleGestureTimer -= dt;
      if (this.idleGestureTimer <= 0) {
        this.idleGestureTimer = 10 + Math.random() * 16;
        const clipsLoaded = !!this.clips && this.clips.hasBase;
        const r = Math.random();
        if (r < 0.3) this.playGesture('nod');
        else if (r < 0.5 && !clipsLoaded) this.playGesture('talk');
        else if (r < 0.56 && !clipsLoaded) this.playGesture('stretch');
      }
    }
  }

  private updateGaze(dt: number, time: number, camera: THREE.Camera): void {
    const head = this.bone('head');
    if (!head) return;

    let desiredYaw = 0;
    let desiredPitch = 0;
    if (this.gazeMode === 'none') {
      desiredYaw = desiredPitch = 0;
    } else if (this.gazeMode === 'window' && this.gazeTarget) {
      const p = this.desiredAnglesTo(this.gazeTarget, head);
      desiredYaw = p.x;
      desiredPitch = p.y;
    } else if (this.gazeMode === 'random') {
      desiredYaw = Math.sin(time * 0.35) * 0.5;
      desiredPitch = Math.sin(time * 0.27 + 2) * 0.2 - 0.05;
    } else {
      // me: look at camera
      camera.getWorldPosition(_v);
      const p = this.desiredAnglesTo(_v, head);
      desiredYaw = p.x;
      desiredPitch = p.y;
    }

    // saccades: micro glances
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0 && this.saccadeRemain <= 0) {
      this.saccadeRemain = 0.35 + Math.random() * 0.45;
      this.saccadeYaw = (Math.random() - 0.5) * 0.5;
      this.saccadePitch = (Math.random() - 0.5) * 0.3;
      this.saccadeTimer = 2.2 + Math.random() * 4.5;
    }
    if (this.saccadeRemain > 0) {
      this.saccadeRemain -= dt;
      desiredYaw += this.saccadeYaw;
      desiredPitch += this.saccadePitch;
    }

    // head handles up to ±1.0 rad; the excess turns the upper body
    const clampYaw = THREE.MathUtils.clamp(desiredYaw, -1.0, 1.0);
    const clampPitch = THREE.MathUtils.clamp(desiredPitch, -0.42, 0.5);
    this.desiredYaw = clampYaw;
    this.desiredPitch = clampPitch;
    this.bodyYaw = THREE.MathUtils.clamp((desiredYaw - clampYaw) * 0.75, -0.95, 0.95);

    const k = Math.min(1, dt * 5.5);
    this.curYaw += (this.desiredYaw - this.curYaw) * k;
    this.curPitch += (this.desiredPitch - this.curPitch) * k;
    this.curBodyYaw += (this.bodyYaw - this.curBodyYaw) * Math.min(1, dt * 4);
  }

  private desiredAnglesTo(target: THREE.Vector3, head: THREE.Bone): THREE.Vector2 {
    head.getWorldPosition(_v);
    const dir = target.clone().sub(_v).setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z) - Math.atan2(this.forward.x, this.forward.z);
    head.getWorldPosition(_v);
    const full = target.clone().sub(_v).normalize();
    // X-axis rotations tilt +Z-forward downward for positive angles, so a
    // target above the head needs a NEGATIVE pitch
    const pitch = -Math.asin(THREE.MathUtils.clamp(full.y, -1, 1));
    return new THREE.Vector2(yaw, pitch);
  }

  private updateBlink(dt: number, _time: number): void {
    if (!this.blinkName) return;
    this.blinkTimer -= dt;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      if (this.blinkPhase >= this.blinkDuration) {
        this.blinkPhase = -1;
        this.blinkTimer = this.nextBlinkDelay;
      }
    } else if (this.blinkTimer <= 0) {
      this.blinkPhase = 0;
      this.blinkDuration = 0.09 + Math.random() * 0.07;
      this.nextBlinkDelay = 1.6 + Math.random() * 3.4;
    }
    let v = 0;
    if (this.blinkPhase >= 0) {
      const p = this.blinkPhase / this.blinkDuration;
      v = Math.sin(Math.min(1, p) * Math.PI);
    }
    const proxy = this.vrm!.expressionManager!;
    if (this.blinkName === 'blink') {
      proxy.setValue('blink', v);
    } else {
      proxy.setValue('blinkLeft', v);
      proxy.setValue('blinkRight', v);
    }
  }

  private updateBreathing(dt: number, time: number): void {
    this.breathePhase += dt;
    const chest = this.bone('chest');
    if (chest) {
      const roll = Math.sin(this.breathePhase * 1.38) * 0.02;
      const rest = this.restWorld.get(chest);
      if (rest) {
        const desired = rest
          .clone()
          .multiply(_q.setFromEuler(new THREE.Euler(
            this.listenLean * 0.05,
            this.curBodyYaw,
            roll,
          )));
        this.setBoneWorldRotation(chest, desired);
      }
    }
    const hips = this.bone('hips');
    if (hips) {
      const sway = Math.sin(time * 0.5) * 0.014;
      const rest = this.restWorld.get(hips);
      if (rest) {
        const desired = rest
          .clone()
          .multiply(_q.setFromEuler(new THREE.Euler(0, this.curBodyYaw * 0.85, -sway)));
        this.setBoneWorldRotation(hips, desired);
      }
    }
  }

  private updateGestures(dt: number, _time: number, clipsActive: boolean): void {
    const g = this.gesture;
    if (!g) {
      this.headOffset.yaw *= Math.max(0, 1 - dt * 6);
      this.headOffset.pitch *= Math.max(0, 1 - dt * 6);
      this.headOffset.roll *= Math.max(0, 1 - dt * 6);
      if (!clipsActive) this.idleArms(dt);
      return;
    }
    g.t += dt;
    const t = g.t;
    const d = g.duration;
    const inPhase = Math.min(1, t / (g.name === 'point' ? 0.5 : 0.25)); // ease in
    const outPhase = Math.max(0, Math.min(1, (d - t) / 0.3)); // ease out
    const env = Math.min(inPhase, outPhase);
    const e = env * env * (3 - 2 * env); // smoothstep

    this.headOffset.yaw = 0;
    this.headOffset.pitch = 0;
    this.headOffset.roll = 0;

    const f = this.forward;
    const r = this.right;

    switch (g.name) {
      case 'point': {
        // pick the arm on the target's side; default to her right arm
        let side: 'left' | 'right' = 'right';
        const shoulder = this.bone('rightUpperArm');
        if (shoulder) {
          shoulder.getWorldPosition(_tmpA);
          if (g.target) {
            _dirUpper.copy(g.target).sub(_tmpA).normalize();
            side = _dirUpper.dot(r) < 0 ? 'left' : 'right';
            if (side === 'left') {
              const lShoulder = this.bone('leftUpperArm');
              if (lShoulder) {
                lShoulder.getWorldPosition(_tmpA);
                _dirUpper.copy(g.target).sub(_tmpA).normalize();
              }
            }
          } else {
            // forward, out to her right, slightly up
            _dirUpper
              .set(0, 0, 0)
              .addScaledVector(f, 1.0)
              .addScaledVector(r, 0.5)
              .addScaledVector(UP, -0.55)
              .normalize();
          }
        } else {
          _dirUpper.set(0.4, -0.5, 1).normalize();
        }
        // relaxed casual point: the upper arm only partly raises (elbow stays
        // low, no straight out-and-up "salute"), the forearm does the aiming
        _dirLower.copy(_dirUpper);
        _dirUpper.lerp(DOWN, 0.35).normalize();
        this.poseArm(side, _dirUpper, _dirLower, 0, e, dt);
        // small head tilt + torso turn toward the target
        const lateral = -_dirLower.dot(r); // + = target on her left
        this.headOffset.roll += THREE.MathUtils.clamp(lateral * 0.1, -0.12, 0.12);
        const chest = this.bone('chest');
        if (chest) {
          chest.getWorldQuaternion(_q);
          const desired = _q
            .clone()
            .premultiply(
              _qOutward.setFromAxisAngle(UP, THREE.MathUtils.clamp(-lateral * 0.22, -0.22, 0.22) * e),
            );
          this.setBoneWorldRotation(chest, desired);
        }
        break;
      }
      case 'wave': {
        const wob = Math.sin(t * 11) * 0.7 * e;
        _dirUpper.set(0, 0, 0)
          .addScaledVector(f, 0.25)
          .addScaledVector(r, 0.25)
          .addScaledVector(UP, -0.75)
          .normalize();
        _dirLower.set(0, 0, 0)
          .addScaledVector(f, 0.7)
          .addScaledVector(r, wob)
          .addScaledVector(UP, 0.4)
          .normalize();
        this.poseArm('right', _dirUpper, _dirLower, 0, e, dt);
        break;
      }
      case 'nod':
        this.headOffset.pitch = Math.sin((t / d) * Math.PI * 2) * 0.14 * e;
        this.idleArms(dt);
        break;
      case 'shake':
        this.headOffset.yaw = Math.sin((t / d) * Math.PI * 2.4) * 0.2 * e;
        this.idleArms(dt);
        break;
      case 'think': {
        this.headOffset.roll = 0.14 * e;
        this.headOffset.pitch = 0.12 * e;
        const headBone = this.bone('head');
        const shoulder = this.bone('rightUpperArm');
        const upperLen = this.armLengths.get('rightUpperArm') ?? 0.4;
        if (headBone && shoulder) {
          // a point in front of the mouth
          headBone.getWorldPosition(_tmpA);
          _tmpB.set(0, 0, 0)
            .addScaledVector(f, 0.16)
            .addScaledVector(UP, -0.26)
            .addScaledVector(r, -0.04);
          const chin = _tmpA.add(_tmpB);
          shoulder.getWorldPosition(_tmpB); // shoulder position
          // upper arm hangs mostly down, elbow stays low and natural
          _dirUpper.set(0, 0, 0)
            .addScaledVector(f, 0.18)
            .addScaledVector(UP, -0.92)
            .addScaledVector(r, -0.12)
            .normalize();
          const elbow = _tmpB.clone().addScaledVector(_dirUpper, upperLen);
          _dirLower.copy(chin).sub(elbow).normalize();
          this.poseArm('right', _dirUpper, _dirLower, 0, e, dt, 1.05);
        }
        break;
      }
      case 'shrug': {
        _dirUpper.set(0, 0, 0)
          .addScaledVector(r, -0.5)
          .addScaledVector(UP, -0.82)
          .addScaledVector(f, 0.08)
          .normalize();
        this.poseArm('left', _dirUpper, null, 0.12, e, dt);
        _dirUpper.set(0, 0, 0)
          .addScaledVector(r, 0.5)
          .addScaledVector(UP, -0.82)
          .addScaledVector(f, 0.08)
          .normalize();
        this.poseArm('right', _dirUpper, null, 0.12, e, dt);
        break;
      }
      case 'clap': {
        const cl = Math.sin(t * 16) * 0.05 * e;
        _dirUpper.set(0, 0, 0)
          .addScaledVector(f, 0.78)
          .addScaledVector(UP, -0.55)
          .addScaledVector(r, 0.3)
          .normalize();
        _dirLower.set(0, 0, 0)
          .addScaledVector(f, 1.0)
          .addScaledVector(r, 0.1 + cl)
          .addScaledVector(UP, 0.02)
          .normalize();
        this.poseArm('left', _dirUpper, _dirLower, 0, e, dt);
        _dirUpper.set(0, 0, 0)
          .addScaledVector(f, 0.78)
          .addScaledVector(UP, -0.55)
          .addScaledVector(r, -0.3)
          .normalize();
        _dirLower.set(0, 0, 0)
          .addScaledVector(f, 1.0)
          .addScaledVector(r, -0.1 - cl)
          .addScaledVector(UP, 0.02)
          .normalize();
        this.poseArm('right', _dirUpper, _dirLower, 0, e, dt);
        break;
      }
      case 'stretch': {
        // arms up and out, head back slightly, like a lazy stretch
        this.headOffset.pitch = -0.08 * e;
        _dirUpper.set(0, 0, 0)
          .addScaledVector(r, -0.75)
          .addScaledVector(UP, -0.35)
          .addScaledVector(f, 0.05)
          .normalize();
        this.poseArm('left', _dirUpper, null, 0.35, e, dt);
        _dirUpper.set(0, 0, 0)
          .addScaledVector(r, 0.75)
          .addScaledVector(UP, -0.35)
          .addScaledVector(f, 0.05)
          .normalize();
        this.poseArm('right', _dirUpper, null, 0.35, e, dt);
        break;
      }
      case 'talk': {
        const bob = Math.sin(t * 5) * 0.08 * e;
        _dirUpper.set(0, 0, 0)
          .addScaledVector(f, 0.12)
          .addScaledVector(UP, -0.85)
          .addScaledVector(r, 0.2)
          .normalize();
        _dirLower.set(0, 0, 0)
          .addScaledVector(f, 0.85)
          .addScaledVector(UP, -0.15 + bob)
          .addScaledVector(r, 0.1)
          .normalize();
        this.poseArm('right', _dirUpper, _dirLower, 0, e, dt);
        break;
      }
      default:
        this.idleArms(dt);
    }
    if (t >= d) this.gesture = null;
  }

  /**
   * Pose an arm by rotating its segments toward world-space directions.
   * Delta-based: works on top of any animated pose (reads the bones' current
   * orientation and rotates toward the target), and from any rest pose.
   */
  private poseArm(
    side: 'left' | 'right',
    upperDir: THREE.Vector3,
    lowerDir: THREE.Vector3 | null,
    bend: number,
    weight: number,
    dt: number,
    lowerTwist = 0,
  ): void {
    const upperName = side + 'UpperArm';
    const lowerName = side + 'LowerArm';
    const handName = side + 'Hand';
    const upper = this.bone(upperName);
    const lower = this.bone(lowerName);
    const hand = this.bone(handName);
    if (!upper || !lower) return;
    if (weight < 0.01) return;

    const upperWorld = upper.getWorldQuaternion(new THREE.Quaternion());
    const shoulder = upper.getWorldPosition(new THREE.Vector3());
    const elbow = lower.getWorldPosition(new THREE.Vector3());
    const upperLen = this.armLengths.get(upperName) ?? 0.4;

    const dir = upperDir.clone().normalize();
    const curUpperDir = _deltaDir.copy(elbow).sub(shoulder);
    if (curUpperDir.lengthSq() < 1e-6) {
      curUpperDir.set(0, -1, 0);
    }
    curUpperDir.normalize();
    // world-space delta must PREmultiply the world orientation (applying it
    // post-multiply would rotate around the bone's local axes instead)
    const desiredUpper = upperWorld
      .clone()
      .premultiply(fromToQuat(curUpperDir, dir, _qFromTo));
    if (weight < 1) desiredUpper.slerp(upperWorld, 1 - weight);

    let ldir: THREE.Vector3;
    if (lowerDir) {
      ldir = lowerDir.clone().normalize();
    } else {
      ldir = dir.clone().lerp(UP, THREE.MathUtils.clamp(bend, 0, 1)).normalize();
    }

    const lowerWorld = lower.getWorldQuaternion(new THREE.Quaternion());
    let curLowerDir: THREE.Vector3;
    if (hand) {
      curLowerDir = _deltaDir2.copy(hand.getWorldPosition(new THREE.Vector3())).sub(elbow);
    } else {
      curLowerDir = _deltaDir2.copy(dir).multiplyScalar(upperLen * 0.9);
    }
    if (curLowerDir.lengthSq() < 1e-6) curLowerDir.set(0, -1, 0);
    curLowerDir.normalize();
    const desiredLower = lowerWorld
      .clone()
      .premultiply(fromToQuat(curLowerDir, ldir, _qFromTo));
    if (lowerTwist !== 0) {
      desiredLower.premultiply(_qTwist.setFromAxisAngle(ldir, lowerTwist));
    }
    if (weight < 1) desiredLower.slerp(lowerWorld, 1 - weight);

    // write directly: when clips play, the mixer rewrites the bones every
    // frame, so frame-rate smoothing can never accumulate - the gesture's
    // own ease-in/out provides the smoothness instead
    this.setBoneWorldRotation(upper, desiredUpper);
    this.setBoneWorldRotation(lower, desiredLower);
  }

  private smoothTo(bone: THREE.Bone, desired: THREE.Quaternion, dt: number, rate = 9): void {
    bone.getWorldQuaternion(_tmpQuatSmooth);
    _tmpQuatSmooth.slerp(desired, Math.min(1, dt * rate));
    this.setBoneWorldRotation(bone, _tmpQuatSmooth);
  }

  private idleArms(dt: number): void {
    const t = performance.now() / 1000;
    const sway = Math.sin(t * 0.9) * 0.05;
    // left arm hangs toward her left (-right)
    _dirUpper.set(0, 0, 0)
      .addScaledVector(this.forward, 0.09)
      .addScaledVector(this.right, -(0.2 + sway))
      .addScaledVector(UP, -1)
      .normalize();
    this.poseArm('left', _dirUpper, null, 0.04, 0.85, dt);
    _dirUpper.set(0, 0, 0)
      .addScaledVector(this.forward, 0.09)
      .addScaledVector(this.right, 0.2 - sway)
      .addScaledVector(UP, -1)
      .normalize();
    this.poseArm('right', _dirUpper, null, 0.04, 0.85, dt);
  }

  private updateExpressions(dt: number): void {
    const proxy = this.vrm!.expressionManager!;
    // decay existing weights
    for (const [name, w] of [...this.exprWeights]) {
      const next = w - dt * 0.25;
      if (next <= 0.005) this.exprWeights.delete(name);
      else this.exprWeights.set(name, next);
    }
    for (const [name, w] of this.exprWeights) {
      if (this.hasExpression.get(name)) proxy.setValue(name, w);
    }

    // visemes: one mouth preset at a time, smoothed
    const mouth = ['aa', 'ih', 'ou', 'ee', 'oh'];
    if (this.viseme && this.viseme.weight > 0.02) {
      const preset = VISEME_PRESET[this.viseme.v] ?? 'i';
      this.visemeWeight += (this.viseme.weight * 0.9 - this.visemeWeight) * Math.min(1, dt * 18);
      for (const p of mouth) {
        proxy.setValue(p, p === preset ? this.visemeWeight : 0);
      }
    } else {
      this.visemeWeight *= Math.max(0, 1 - dt * 12);
      if (this.visemeWeight < 0.01) this.visemeWeight = 0;
      for (const p of mouth) proxy.setValue(p, 0);
    }
  }

  private updatePose(): void {
    // head + neck from gaze + gesture offsets
    const head = this.bone('head');
    const neck = this.bone('neck');
    const yaw = this.curYaw + this.headOffset.yaw;
    const pitch = this.curPitch + this.headOffset.pitch;
    const roll = this.headOffset.roll;

    const clipsActive =
      !!this.clips && (this.clips.hasBase || this.clips.oneShotActive);

    if (clipsActive) {
      // apply gaze as a world-space delta ON TOP of the animated head/neck,
      // so clip head motion (nods, shakes, glances) survives while she still
      // looks at the player/windows
      const aim = _deltaDir
        .copy(this.forward)
        .applyQuaternion(_q.setFromEuler(new THREE.Euler(this.curPitch, this.curYaw, 0, 'YXZ')));
      const offset = _qLayered.setFromEuler(
        new THREE.Euler(this.headOffset.pitch, this.headOffset.yaw, this.headOffset.roll, 'YXZ'),
      );
      if (head && this.headForwardLocal) {
        const curW = head.getWorldQuaternion(new THREE.Quaternion());
        const curF = _deltaDir2.copy(this.headForwardLocal).applyQuaternion(curW);
        const delta = fromToQuat(curF, aim, _qFromTo).clone();
        const desired = curW.clone().premultiply(delta).premultiply(offset);
        this.setBoneWorldRotation(head, desired);
      }
      return;
    }

    if (neck) {
      const rest = this.restWorld.get(neck);
      if (rest) {
        // split: neck takes 55% yaw / 40% pitch
        const neckQ = _q.setFromEuler(new THREE.Euler(pitch * 0.4, yaw * 0.55, roll * 0.4));
        this.setBoneWorldRotation(neck, rest.clone().multiply(neckQ));
      }
    }
    if (head) {
      const rest = this.restWorld.get(head);
      if (rest) {
        const headQ = _q.setFromEuler(new THREE.Euler(pitch * 0.6, yaw * 0.45, roll * 0.6));
        this.setBoneWorldRotation(head, rest.clone().multiply(headQ));
      }
    }
  }

  private setBoneWorldRotation(bone: THREE.Bone, worldQuat: THREE.Quaternion): void {
    const parent = bone.parent;
    if (parent) {
      parent.getWorldQuaternion(_qParent);
      bone.quaternion.copy(_qParent.invert().multiply(worldQuat));
    } else {
      bone.quaternion.copy(worldQuat);
    }
  }
}
