import * as THREE from 'three';

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
  private base: THREE.AnimationAction | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  private restoreBase = false;

  constructor(normalizedRoot: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(normalizedRoot);
    this.mixer.addEventListener('finished', (e) => {
      const action = (e as unknown as { action: THREE.AnimationAction }).action;
      if (this.oneShot && action === this.oneShot) {
        this.oneShot = null;
        if (this.restoreBase && this.base) {
          this.base.fadeIn(0.3);
          this.restoreBase = false;
        }
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

  register(name: string, clip: THREE.AnimationClip, asBase = false): void {
    const variants = this.variants.get(name) ?? [];
    const registeredName = variants.length === 0 ? name : `${name}~${variants.length}`;
    variants.push(registeredName);
    this.variants.set(name, variants);

    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    this.actions.set(registeredName, action);
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
    if (this.base && this.base.isRunning()) {
      this.base.crossFadeTo(next, duration, false);
      this.base = next;
    } else {
      next.reset().fadeIn(duration).play();
      this.base = next;
    }
  }

  /** Play a (random variation of a) gesture once, fading the ambient out/in. */
  playOneShot(name: string, duration = 0.25): boolean {
    const action = this.pick(name);
    if (!action || action === this.base) return false;

    if (this.oneShot && this.oneShot.isRunning()) {
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
    }
    return true;
  }

  stopOneShot(): void {
    if (this.oneShot && this.oneShot.isRunning()) {
      this.oneShot.stop();
      this.oneShot = null;
    }
    if (this.restoreBase && this.base) {
      this.base.fadeIn(0.3);
      this.restoreBase = false;
    }
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }
}
