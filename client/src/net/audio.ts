import type { VisemeEvent } from './types';

interface PendingUtterance {
  b64: string;
  visemes: VisemeEvent[];
}

interface PlayingUtterance {
  source: AudioBufferSourceNode;
  analyser: AnalyserNode;
  startedAt: number; // AudioContext time
  duration: number;
  visemes: VisemeEvent[];
}

/**
 * Plays streamed TTS audio sentence-by-sentence and exposes, for lip sync:
 *  - the active viseme (from server-provided phoneme timings)
 *  - the current speech energy (RMS) as a fallback driver
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private pending: PendingUtterance | null = null;
  private queue: AudioBuffer[] = [];
  private queueVisemes: VisemeEvent[][] = [];
  private current: PlayingUtterance | null = null;
  private energy = 0;
  private lastEnergy: number[] = [];

  get ready(): boolean {
    return this.ctx !== null;
  }

  get speaking(): boolean {
    return this.current !== null || this.queue.length > 0 || this.pending !== null;
  }

  async ensure(): Promise<boolean> {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch (err) {
        console.warn('AudioContext unavailable:', err);
        return false;
      }
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          /* stays suspended until user gesture; fine */
        }
      }
    }
    return true;
  }

  addAudioChunk(b64: string): void {
    if (!this.pending) this.pending = { b64: '', visemes: [] };
    this.pending.b64 += b64;
  }

  addVisemes(events: VisemeEvent[]): void {
    if (!this.pending) this.pending = { b64: '', visemes: [] };
    this.pending.visemes = events;
  }

  async finishUtterance(): Promise<void> {
    if (!this.ctx || !this.pending || !this.pending.b64) {
      this.pending = null;
      return;
    }
    const pending = this.pending;
    this.pending = null;
    try {
      const raw = atob(pending.b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const buffer = await this.ctx.decodeAudioData(bytes.buffer);
      this.queue.push(buffer);
      this.queueVisemes.push(pending.visemes);
      this.pump();
    } catch (err) {
      console.warn('audio decode failed', err);
    }
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const ctx = this.ctx!;
    const buffer = this.queue.shift()!;
    const visemes = this.queueVisemes.shift()!;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    const startedAt = ctx.currentTime + 0.03;
    source.start(startedAt);
    source.onended = () => {
      if (this.current && this.current.source === source) {
        this.current = null;
        this.energy = 0;
      }
      this.pump();
    };
    this.current = { source, analyser, startedAt, duration: buffer.duration, visemes };
  }

  /** Called every frame: returns the active viseme name + weight (0..1). */
  tick(): { v: string; weight: number } | null {
    if (!this.ctx || !this.current) return null;
    const t = this.ctx.currentTime - this.current.startedAt;
    if (t < 0 || t > this.current.duration) return null;

    let viseme: string | null = null;
    let weight = 0;
    for (const ev of this.current.visemes) {
      if (t >= ev.start && t < ev.end) {
        viseme = ev.v;
        weight = 1;
        break;
      }
    }
    if (!viseme && this.current.visemes.length > 0) return null;

    // fallback: energy-driven mouth openness
    this.updateEnergy();
    if (!viseme) {
      const w = Math.min(1, this.energy * 14);
      if (w < 0.02) return null;
      return { v: 'aa', weight: w };
    }
    return { v: viseme, weight: weight };
  }

  private updateEnergy(): void {
    if (!this.current) return;
    const data = new Uint8Array(this.current.analyser.frequencyBinCount);
    this.current.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    this.lastEnergy.push(rms);
    if (this.lastEnergy.length > 10) this.lastEnergy.shift();
    this.energy = this.lastEnergy.reduce((a, b) => a + b, 0) / this.lastEnergy.length;
  }

  async interrupt(): Promise<void> {
    this.pending = null;
    this.queue = [];
    this.queueVisemes = [];
    if (this.current && this.ctx) {
      const src = this.current.source;
      this.current = null;
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.energy = 0;
  }

  async resumeIfNeeded(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }
}
