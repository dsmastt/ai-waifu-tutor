import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

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
const _qX = new THREE.Quaternion();
const _qY = new THREE.Quaternion();
const _qZ = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class TutorCharacter {
  vrm: VRM | null = null;
  readonly group = new THREE.Group();
  loaded = false;

  private bones = new Map<string, THREE.Bone | null>();
  private restWorld = new Map<THREE.Bone, THREE.Quaternion>();
  private forward = new THREE.Vector3(0, 0, 1);
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

  // idle life
  private idleGestureTimer = 8;
  private lookAroundTimer = 4;

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

    this.captureBones();
    this.captureExpressions();

    // forward direction from the hips
    const hips = this.bone('hips');
    if (hips) {
      hips.getWorldQuaternion(_q);
      this.forward.set(0, 0, 1).applyQuaternion(_q).setY(0).normalize();
    }
  }

  private captureBones(): void {
    const vrm = this.vrm!;
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
    const durations: Record<string, number> = {
      point: 2.4, nod: 1.0, shake: 1.2, wave: 1.6,
      think: 2.8, shrug: 1.2, clap: 1.4, talk: 1.4,
    };
    this.gesture = {
      name,
      t: 0,
      duration: durations[name] ?? 1.4,
      target: target ?? null,
    };
  }

  setViseme(v: string, weight: number): void {
    this.viseme = { v, weight: Math.max(0, Math.min(1, weight)) };
  }

  // ------------------------------------------------------------------ update

  update(dt: number, time: number, camera: THREE.Camera): void {
    if (!this.vrm) return;
    this.updateGaze(dt, time, camera);
    this.updateIdleLife(dt);
    this.updateBlink(dt, time);
    this.updateBreathing(dt, time);
    this.updateGestures(dt, time);
    this.updateExpressions(dt);
    this.updatePose();
    this.vrm.update(dt);
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
        if (r < 0.35) this.playGesture('nod');
        else if (r < 0.55) this.playGesture('talk');
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
          .multiply(_q.setFromEuler(new THREE.Euler(0, this.curBodyYaw, roll)));
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

    switch (g.name) {
      case 'point': {
        const az = this.targetAzimuth(g.target);
        this.armPose('rightUpperArm', az, -1.35, 0.1, e);
        this.armPose('rightLowerArm', 0.05, -1.15, 0, e);
        break;
      }
      case 'wave': {
        const wob = Math.sin(t * 11) * 0.45 * e;
        this.armPose('rightUpperArm', 0, -1.25, -0.15, e);
        this.armPose('rightLowerArm', wob, -0.5, 0, e);
        break;
      }
      case 'nod':
        this.headOffset.pitch = Math.sin((t / d) * Math.PI * 2) * 0.14 * e;
        break;
      case 'shake':
        this.headOffset.yaw = Math.sin((t / d) * Math.PI * 2.4) * 0.2 * e;
        break;
      case 'think': {
        this.headOffset.roll = 0.14 * e;
        this.headOffset.pitch = 0.12 * e;
        this.armPose('rightUpperArm', 0.35, -0.85, 0.15, e);
        this.armPose('rightLowerArm', 0.25, -1.55, 0.1, e);
        break;
      }
      case 'shrug': {
        this.headOffset.roll = 0.1 * e;
        this.armPose('leftUpperArm', 0, -0.3, 0.45, e);
        this.armPose('rightUpperArm', 0, -0.3, -0.45, e);
        this.armPose('leftLowerArm', 0, -0.5, 0.2, e);
        this.armPose('rightLowerArm', 0, -0.5, -0.2, e);
        break;
      }
      case 'clap': {
        const cl = Math.sin(t * 16) * 0.06 * e;
        this.armPose('leftUpperArm', 0.5, -1.2, 0.25, e);
        this.armPose('rightUpperArm', 0.5, -1.2, -0.25, e);
        this.armPose('leftLowerArm', 0.2, -0.35 + cl, 0.1, e);
        this.armPose('rightLowerArm', 0.2, -0.35 - cl, -0.1, e);
        break;
      }
      case 'talk': {
        const bob = Math.sin(t * 5) * 0.1 * e;
        this.armPose('rightUpperArm', 0.25 + bob * 0.3, -0.55, 0.1, e);
        this.armPose('rightLowerArm', 0.1, -0.7, 0.05, e);
        break;
      }
      default:
        this.idleArms(dt);
    }
    if (t >= d) this.gesture = null;
  }

  private targetAzimuth(target: THREE.Vector3 | null): number {
    if (!target) return 0.35;
    const shoulder = this.bone('rightUpperArm');
    if (!shoulder) return 0.35;
    shoulder.getWorldPosition(_v);
    const dir = target.clone().sub(_v).setY(0).normalize();
    return Math.atan2(dir.x, dir.z) - Math.atan2(this.forward.x, this.forward.z);
  }

  private armPose(boneName: string, yaw: number, pitch: number, roll: number, weight: number): void {
    const bone = this.bone(boneName);
    const rest = bone && this.restWorld.get(bone);
    if (!bone || !rest) return;
    if (weight < 0.01) return;
    // world-space offsets applied in raise->aim->tilt order
    const offset = _qY.setFromEuler(new THREE.Euler(0, yaw, 0))
      .multiply(_qX.setFromEuler(new THREE.Euler(pitch, 0, 0)))
      .multiply(_qZ.setFromEuler(new THREE.Euler(0, 0, roll)));
    const desired = rest.clone().multiply(offset);
    // blend toward rest when weight < 1
    if (weight < 1) {
      desired.slerp(rest, 1 - weight);
    }
    this.setBoneWorldRotation(bone, desired);
  }

  private idleArms(dt: number): void {
    const t = performance.now() / 1000;
    const swayL = Math.sin(t * 0.9) * 0.03;
    const swayR = Math.sin(t * 0.9 + Math.PI) * 0.03;
    this.armPose('leftLowerArm', 0, 0.06, swayL, 0.6);
    this.armPose('rightLowerArm', 0, -0.06, swayR, 0.6);
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
      parent.getWorldQuaternion(_q);
      bone.quaternion.copy(_q.invert().multiply(worldQuat));
    } else {
      bone.quaternion.copy(worldQuat);
    }
  }
}
