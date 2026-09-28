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
  private speaking = false;
  private idleVariantTimer = 14;

  // idle life
  private idleGestureTimer = 8;
  private lookAroundTimer = 4;
  private listening = false;
  private listenLean = 0;

  // breath
  private breathePhase = 0;

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register((parser) => new VRMLoaderPlugin(parser));
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

    // animation clips drive the NORMALIZED skeleton; three-vrm copies it to
    // the raw skeleton every update (autoUpdateHumanBones defaults true).
    // Rename the normalized nodes to VRM bone names so AnimationMixer can
    // bind tracks (their shipped names are "Normalized_*").
    for (const [name, b] of Object.entries(vrm.humanoid!.normalizedHumanBones)) {
      if (b.node) b.node.name = name;
    }
    this.clips = new ClipLibrary(vrm.humanoid!.normalizedHumanBonesRoot!);

    this.captureBones();
    this.captureExpressions();

    // forward direction from the hips
    const hips = this.bone('hips');
    if (hips) {
      hips.getWorldQuaternion(_q);
      this.forward.set(0, 0, 1).applyQuaternion(_q).setY(0).normalize();
      this.right.crossVectors(this.forward, UP).normalize();
    }
  }

  private captureBones(): void {
    const vrm = this.vrm!;
    vrm.humanoid!.normalizedHumanBonesRoot!.updateMatrixWorld(true);
    const names = [
      'hips', 'spine', 'chest', 'neck', 'head',
      'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightUpperArm', 'rightLowerArm', 'rightHand',
    ] as const;
    for (const n of names) {
      const node = vrm.humanoid!.getNormalizedBoneNode(
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
    this.speaking = speaking;
    if (!this.clips) return;
    if (speaking && this.clips.has('talking')) {
      this.clips.crossFade('talking', 0.35);
    } else if (!speaking && this.clips.has('base')) {
      this.clips.crossFade('base', 0.35);
    }
  }

  getNormalizedBones(): Map<string, THREE.Bone> {
    const out = new Map<string, THREE.Bone>();
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return out;
    for (const [name, bone] of Object.entries(humanoid.normalizedHumanBones)) {
      const node = (bone as { node?: THREE.Bone }).node;
      if (node) out.set(name, node);
    }
    return out;
  }

  setViseme(v: string, weight: number): void {
    this.viseme = { v, weight: Math.max(0, Math.min(1, weight)) };
  }

  // ------------------------------------------------------------------ update

  update(dt: number, time: number, camera: THREE.Camera): void {
    if (!this.vrm) return;
    const clipsActive =
      !!this.clips && (this.clips.hasBase || this.clips.oneShotActive);

    if (clipsActive) this.clips!.update(dt);
    this.updateGaze(dt, time, camera);
    this.updateIdleLife(dt);
    this.updateBlink(dt, time);
    const proceduralNeeded =
      !clipsActive ||
      (this.gesture !== null && ['point', 'talk', 'stretch'].includes(this.gesture.name));
    if (proceduralNeeded) {
      this.updateBreathing(dt, time);
      this.updateGestures(dt, time);
    } else {
      this.updateClipGestures(dt);
    }
    this.updateExpressions(dt);
    this.updatePose();

    // listening lean (head tilt + slight forward lean toward the student)
    const listenTarget = this.listening ? 1 : 0;
    this.listenLean += (listenTarget - this.listenLean) * Math.min(1, dt * 6);
    if (this.listenLean > 0.01) {
      this.headOffset.roll += 0.09 * this.listenLean;
      this.headOffset.pitch -= 0.04 * this.listenLean;
    }

    // whole-body bob
    this.group.position.y = Math.sin(this.breathePhase * 1.1) * 0.006;

    this.vrm.update(dt);
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
        this.idleVariantTimer = 12 + Math.random() * 14;
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
          }, 6000 + Math.random() * 5000);
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
    // subtle idle gestures when not doing anything else
    if (!this.gesture) {
      this.idleGestureTimer -= dt;
      if (this.idleGestureTimer <= 0) {
        this.idleGestureTimer = 10 + Math.random() * 16;
        const r = Math.random();
        if (r < 0.3) this.playGesture('nod');
        else if (r < 0.5) this.playGesture('talk');
        else if (r < 0.56) this.playGesture('stretch');
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

    const k = Math.min(1, dt * 7.5);
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
    const pitch = Math.asin(THREE.MathUtils.clamp(full.y, -1, 1));
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

  private updateGestures(dt: number, _time: number): void {
    const g = this.gesture;
    if (!g) {
      this.headOffset.yaw *= Math.max(0, 1 - dt * 6);
      this.headOffset.pitch *= Math.max(0, 1 - dt * 6);
      this.headOffset.roll *= Math.max(0, 1 - dt * 6);
      this.idleArms(dt);
      return;
    }
    g.t += dt;
    const t = g.t;
    const d = g.duration;
    const inPhase = Math.min(1, t / 0.25);            // ease in
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
        this.poseArm(side, _dirUpper, null, 0.02, e, dt);
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
   * Pose an arm by aiming its segments along world-space directions.
   * Rest-agnostic: works for T-pose and A-pose models alike.
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
    const upper = this.bone(upperName);
    const lower = this.bone(lowerName);
    const restUpper = upper && this.restWorld.get(upper);
    const restLower = lower && this.restWorld.get(lower);
    const restUpperDir = this.restArmDirs.get(upperName);
    const restLowerDir = this.restArmDirs.get(lowerName);
    if (!upper || !lower || !restUpper || !restLower || !restUpperDir || !restLowerDir) {
      return;
    }

    const dir = upperDir.clone().normalize();
    const desiredUpper = restUpper
      .clone()
      .multiply(fromToQuat(restUpperDir, dir, _qFromTo));
    if (weight < 1) desiredUpper.slerp(restUpper, 1 - weight);

    let ldir: THREE.Vector3;
    if (lowerDir) {
      ldir = lowerDir.clone().normalize();
    } else {
      // bend the elbow: forearm aims between the upper arm direction and up
      ldir = dir.clone().lerp(UP, THREE.MathUtils.clamp(bend, 0, 1)).normalize();
    }
    const desiredLower = restLower
      .clone()
      .multiply(fromToQuat(restLowerDir, ldir, _qFromTo));
    if (lowerTwist !== 0) {
      // roll the forearm around its own axis to fix palm orientation
      desiredLower.multiply(_qTwist.setFromAxisAngle(ldir, lowerTwist));
    }
    if (weight < 1) desiredLower.slerp(restLower, 1 - weight);

    this.smoothTo(upper, desiredUpper, dt);
    this.smoothTo(lower, desiredLower, dt);
  }

  private smoothTo(bone: THREE.Bone, desired: THREE.Quaternion, dt: number): void {
    bone.getWorldQuaternion(_tmpQuatSmooth);
    _tmpQuatSmooth.slerp(desired, Math.min(1, dt * 9));
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
