import * as THREE from 'three';

export interface ClipHips {
  times: Float32Array;
  values: Float32Array; // frames * 3 (xyz)
  bobScale: number;
}

/**
 * Animation clip playback on the VRM normalized skeleton.
 *
 * A base (ambient) action loops permanently; one-shot gestures fade the base
 * out and back in. Multiple variations of a role are registered under
 * `name`, `name~1`, `name~2`, ... and picked at random for natural variety.
 * The AnimationMixer runs on the VRM's normalized bone root and three-vrm
 * copies the pose to the raw skeleton each update.
 */
export class ClipLibrary {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private variants = new Map<string, string[]>(); // base name -> all registered names
  private hipsByClip = new Map<THREE.AnimationAction, ClipHips>();
  private base: THREE.AnimationAction | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  private restoreBase = false;
  private traceEntries: string[] = [];

  private trace(msg: string): void {
    this.traceEntries.push(`${performance.now().toFixed(0)} ${msg}`);
    if (this.traceEntries.length > 200) this.traceEntries.shift();
  }

  get traceLog(): string[] {
    return [...this.traceEntries];
  }

  constructor(normalizedRoot: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(normalizedRoot);
    this.mixer.addEventListener('finished', (e) => {
      const action = (e as unknown as { action: THREE.AnimationAction }).action;
      this.trace(`finished ${action.getClip().name}`);
      if (this.oneShot && action === this.oneShot) {
        this.oneShot = null;
        if (this.restoreBase && this.base) {
          this.trace(`restore base ${this.base.getClip().name}`);
          this.revive(this.base, 0.3);
          this.restoreBase = false;
        }
      }
    });
  }

  /** three.js disables an action when it fades to zero; play() alone does
   * not re-enable it, so restore `enabled` explicitly. */
  private revive(action: THREE.AnimationAction, fadeIn = 0.3): void {
    action.enabled = true;
    action.paused = false;
    action.play();
    action.fadeIn(fadeIn);
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

  /** Debug: registered roles with their variation counts and durations. */
  describe(): Record<string, { variants: number; duration: number }> {
    const out: Record<string, { variants: number; duration: number }> = {};
    for (const [role, names] of this.variants) {
      const durations = names.map((n) => this.actions.get(n)!.getClip().duration);
      out[role] = {
        variants: names.length,
        duration: Math.max(...durations),
      };
    }
    return out;
  }

  /** All registered names for a role (variations included). */
  variantNames(name: string): string[] {
    return this.variants.get(name) ?? [];
  }

  register(name: string, clip: THREE.AnimationClip, asBase = false, hips?: ClipHips | null): void {
    const variants = this.variants.get(name) ?? [];
    const registeredName = variants.length === 0 ? name : `${name}~${variants.length}`;
    variants.push(registeredName);
    this.variants.set(name, variants);

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    this.actions.set(registeredName, action);
    if (hips) this.hipsByClip.set(action, hips);
    if (asBase) {
      this.base = action;
      action.play();
      action.setEffectiveWeight(1);
    }
  }

  private pick(name: string): THREE.AnimationAction | null {
    const names = this.variantNames(name);
    if (names.length === 0) return null;
    const pick = names[Math.floor(Math.random() * names.length)];
    return this.actions.get(pick) ?? null;
  }

  /** Cross-fade the ambient loop to a (random variation of a) clip. */
  crossFade(name: string, duration = 0.4): void {
    const next = this.pick(name);
    if (!next || next === this.base) return;
    this.trace(`crossFade -> ${name} (from ${this.base?.getClip().name})`);
    // three.js deactivates an action whose weight fades to zero, and fadeIn
    // does not restart it: always play() explicitly
    next.reset();
    if (!next.isRunning()) next.play();
    if (this.base && this.base !== next) {
      this.base.crossFadeTo(next, duration, false);
    } else {
      next.fadeIn(duration);
    }
    this.base = next;
  }

  /** Play a (random variation of a) gesture once, fading the ambient out/in. */
  playOneShot(name: string, duration = 0.25): boolean {
    const action = this.pick(name);
    if (!action || action === this.base) return false;
    this.trace(`oneShot ${name} (base ${this.base?.getClip().name})`);

    if (this.oneShot && this.oneShot.isRunning()) {
      this.trace(`stop previous oneShot ${this.oneShot.getClip().name}`);
      this.oneShot.stop();
    }
    action.reset().setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.play();
    this.oneShot = action;
    if (this.base && this.base.isRunning()) {
      this.base.fadeOut(duration);
      this.restoreBase = true;
    } else {
      this.restoreBase = false;
    }
    return true;
  }

  stopOneShot(): void {
    if (this.oneShot && this.oneShot.isRunning()) {
      this.oneShot.stop();
      this.oneShot = null;
    }
    if (this.restoreBase && this.base) {
      this.revive(this.base, 0.3);
      this.restoreBase = false;
    }
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
    out.set(
      (hips.values[i0 * 3] * (1 - a) + hips.values[Math.min(i0 + 1, frames - 1) * 3] * a) * s,
      (hips.values[i0 * 3 + 1] * (1 - a) + hips.values[Math.min(i0 + 1, frames - 1) * 3 + 1] * a) * s,
      (hips.values[i0 * 3 + 2] * (1 - a) + hips.values[Math.min(i0 + 1, frames - 1) * 3 + 2] * a) * s,
    );
    // relative to the clip's neutral hip position
    out.x -= hips.values[0] * s;
    out.y -= hips.values[1] * s;
    out.z -= hips.values[2] * s;
    return true;
  }

  /** Root motion (meters) blended across running actions, for grounding. */
  update(dt: number, out: THREE.Vector3): void {
    this.mixer.update(dt);
    out.set(0, 0, 0);
    let total = 0;
    for (const action of this.actions.values()) {
      if (!action.isRunning()) continue;
      const w = action.getEffectiveWeight();
      if (w <= 0.001) continue;
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
