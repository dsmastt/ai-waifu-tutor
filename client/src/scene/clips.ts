import * as THREE from 'three';

/**
 * Animation clip playback on the model's raw skeleton.
 *
 * Weight model (explicit, deterministic): a single ambient "base" action and
 * an optional one-shot gesture. Weights are driven every frame instead of
 * three.js's fadeIn/fadeOut (which fights itself when the ambient changes
 * mid-gesture):
 *
 *   one-shot active: base -> 0, one-shot -> 1
 *   otherwise:       base -> 1, everything else -> 0
 *
 * Multiple variations of a role are registered under `name`, `name~1`, ...
 * and picked at random for natural variety.
 */
export interface ClipHips {
  times: Float32Array;
  values: Float32Array; // frames * 3 (xyz)
  bobScale: number;
}

export class ClipLibrary {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private variants = new Map<string, string[]>(); // role -> registered names
  private hipsByClip = new Map<THREE.AnimationAction, ClipHips>();
  private weights = new Map<THREE.AnimationAction, number>();
  private base: THREE.AnimationAction | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  private traceEntries: string[] = [];

  private trace(msg: string): void {
    this.traceEntries.push(`${performance.now().toFixed(0)} ${msg}`);
    if (this.traceEntries.length > 200) this.traceEntries.shift();
  }

  get traceLog(): string[] {
    return [...this.traceEntries];
  }

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (e) => {
      const action = (e as unknown as { action: THREE.AnimationAction }).action;
      this.trace(`finished ${action.getClip().name}`);
      if (this.oneShot === action) {
        this.oneShot = null;
      }
    });
  }

  get loaded(): boolean {
    return this.actions.size > 0;
  }

  get hasBase(): boolean {
    return this.base !== null;
  }

  get oneShotActive(): boolean {
    return !!this.oneShot && this.oneShot.isRunning();
  }

  /** Debug: name of the clip currently acting as the ambient base. */
  get activeBase(): string | null {
    return this.base ? this.base.getClip().name : null;
  }

  has(name: string): boolean {
    return this.variantNames(name).length > 0;
  }

  names(): string[] {
    return [...this.actions.keys()];
  }

  /** All registered names for a role (variations included). */
  variantNames(name: string): string[] {
    return this.variants.get(name) ?? [];
  }

  /** Debug: registered roles with variation counts and max duration. */
  describe(): Record<string, { variants: number; duration: number }> {
    const out: Record<string, { variants: number; duration: number }> = {};
    for (const [role, names] of this.variants) {
      const durations = names.map((n) => this.actions.get(n)!.getClip().duration);
      out[role] = { variants: names.length, duration: Math.max(...durations) };
    }
    return out;
  }

  register(name: string, clip: THREE.AnimationClip, asBase = false, hips?: ClipHips | null): void {
    const variants = this.variants.get(name) ?? [];
    const registeredName = variants.length === 0 ? name : `${name}~${variants.length}`;
    variants.push(registeredName);
    this.variants.set(name, variants);

    const action = this.mixer.clipAction(clip);
    this.actions.set(registeredName, action);
    this.weights.set(action, 0);
    if (hips) this.hipsByClip.set(action, hips);
    if (asBase) {
      this.base = action;
      action.play();
      this.weights.set(action, 1);
      action.setEffectiveWeight(1);
    }
  }

  private pick(name: string): THREE.AnimationAction | null {
    const names = this.variantNames(name);
    if (names.length === 0) return null;
    const pick = names[Math.floor(Math.random() * names.length)];
    return this.actions.get(pick) ?? null;
  }

  /** Switch the ambient loop (random variation of a role). */
  crossFade(name: string, duration = 0.4): void {
    const next = this.pick(name);
    if (!next || next === this.base) return;
    this.trace(`ambient -> ${name}`);
    if (!next.isRunning()) {
      next.reset().setLoop(THREE.LoopRepeat, Infinity);
      next.play();
    }
    this.base = next;
  }

  /** Play a (random variation of a) gesture once; the base fades out/in. */
  playOneShot(name: string, duration = 0.25): boolean {
    const action = this.pick(name);
    if (!action || action === this.base) return false;
    this.trace(`oneShot ${name}`);
    if (this.oneShot && this.oneShot !== action && this.oneShot.isRunning()) {
      this.oneShot.stop();
    }
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    // start at weight 0 - the update loop fades it in smoothly; starting at
    // full weight pops the pose in a single frame
    action.setEffectiveWeight(0);
    action.play();
    this.weights.set(action, 0);
    this.oneShot = action;
    return true;
  }

  /** Stop the current gesture immediately (interrupt). */
  stopOneShot(): void {
    if (this.oneShot && this.oneShot.isRunning()) {
      this.oneShot.stop();
      this.weights.set(this.oneShot, 0);
    }
    this.oneShot = null;
  }

  private rootAt(action: THREE.AnimationAction, out: THREE.Vector3): boolean {
    const hips = this.hipsByClip.get(action);
    if (!hips) return false;
    const frames = hips.times.length;
    const t = action.time % Math.max(hips.times[frames - 1], 0.001);
    let i0 = 0;
    for (let i = 0; i < frames - 1; i++) {
      if (t <= hips.times[i + 1]) {
        i0 = i;
        break;
      }
      i0 = i + 1;
    }
    const t0 = hips.times[i0];
    const t1 = hips.times[Math.min(i0 + 1, frames - 1)];
    const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const s = hips.bobScale * 0.01; // cm -> world meters
    const i1 = Math.min(i0 + 1, frames - 1);
    out.set(
      (hips.values[i0 * 3] * (1 - a) + hips.values[i1 * 3] * a) * s,
      (hips.values[i0 * 3 + 1] * (1 - a) + hips.values[i1 * 3 + 1] * a) * s,
      (hips.values[i0 * 3 + 2] * (1 - a) + hips.values[i1 * 3 + 2] * a) * s,
    );
    // relative to the clip's neutral hip position
    out.x -= hips.values[0] * s;
    out.y -= hips.values[1] * s;
    out.z -= hips.values[2] * s;
    return true;
  }

  /** Advance the mixer, drive weights, and blend root motion (meters). */
  update(dt: number, out: THREE.Vector3): void {
    this.mixer.update(dt);

    const gesture = this.oneShotActive ? this.oneShot : null;
    const k = Math.min(1, dt * 4.5);
    for (const [action, weight] of this.weights) {
      let target = 0;
      if (action === gesture) target = 1;
      else if (action === this.base) target = gesture ? 0 : 1;
      const next = weight + (target - weight) * k;
      this.weights.set(action, next);
      action.setEffectiveWeight(next);
      if (next < 0.005 && action !== this.base && action !== this.oneShot) {
        action.stop();
      }
    }

    out.set(0, 0, 0);
    let total = 0;
    for (const action of this.actions.values()) {
      const w = this.weights.get(action) ?? 0;
      if (w <= 0.001 || !action.isRunning()) continue;
      if (this.rootAt(action, _hipsTmp)) {
        out.x += _hipsTmp.x * w;
        out.y += _hipsTmp.y * w;
        out.z += _hipsTmp.z * w;
        total += w;
      }
    }
    if (total > 0) out.multiplyScalar(1 / total);
  }
}

const _hipsTmp = new THREE.Vector3();
