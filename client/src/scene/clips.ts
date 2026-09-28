import * as THREE from 'three';

/**
 * Animation clip playback on the VRM normalized skeleton.
 *
 * A base (ambient) action loops permanently; one-shot gestures fade the base
 * out and back in. The AnimationMixer runs on the VRM's normalized bone root
 * and three-vrm copies the pose to the raw skeleton each update.
 */
export class ClipLibrary {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
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
          this.base.fadeIn(0.35);
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

  has(name: string): boolean {
    return this.actions.has(name);
  }

  names(): string[] {
    return [...this.actions.keys()];
  }

  register(name: string, clip: THREE.AnimationClip, asBase = false): void {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    this.actions.set(name, action);
    if (asBase) {
      this.base = action;
      action.play();
      action.setEffectiveWeight(1);
    }
  }

  /** Cross-fade the ambient loop to another clip. */
  crossFade(name: string, duration = 0.4): void {
    const next = this.actions.get(name);
    if (!next || next === this.base) return;
    if (this.base && this.base.isRunning()) {
      this.base.crossFadeTo(next, duration, false);
      this.base = next;
    } else {
      next.reset().fadeIn(duration).play();
      this.base = next;
    }
  }

  /** Play a gesture once, fading the ambient loop out and back in. */
  playOneShot(name: string, duration = 0.25): boolean {
    const action = this.actions.get(name);
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
