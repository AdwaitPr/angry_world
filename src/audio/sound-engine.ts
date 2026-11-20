/**
 * Fragment 7 — Procedural Web Audio Synthesizer.
 * Synthesizes all gameplay SFX via Web Audio API using MATERIALS_DB[id].audio parameters
 * with zero external audio assets. Lazily initializes/resumes AudioContext on first user gesture
 * and safely no-ops in headless Node environments where AudioContext is unavailable.
 */

import { MATERIALS_DB, type MaterialId } from '../config/materials.db';
import { PHYSICS_CONFIG, type PhysicsConfig } from '../config/physics.config';
import type { AngryWorldEventMap, EventBus } from '../core/event-bus';
import { createSafeStorage, type SafeStorageAdapter } from '../gameplay/score-manager';

export interface SoundEngineOptions {
  readonly eventBus: EventBus<AngryWorldEventMap>;
  readonly config?: PhysicsConfig;
  readonly storage?: SafeStorageAdapter;
  readonly muteStorageKey?: string;
}

const DEFAULT_MUTE_KEY = 'angry_world_audio_muted_v1';

type AudioContextCtor = new () => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class SoundEngine {
  private readonly eventBus: EventBus<AngryWorldEventMap>;
  private readonly config: PhysicsConfig;
  private readonly storage: SafeStorageAdapter;
  private readonly muteStorageKey: string;
  private readonly unsubscribers: Array<() => void> = [];

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  private lastStretchBucket = -1;
  private lastStretchTimeMs = 0;
  private lastImpactTimeMs = 0;
  private synthCallCount = 0;

  constructor(options: SoundEngineOptions) {
    this.eventBus = options.eventBus;
    this.config = options.config ?? PHYSICS_CONFIG;
    this.storage = options.storage ?? createSafeStorage();
    this.muteStorageKey = options.muteStorageKey ?? DEFAULT_MUTE_KEY;
    this.muted = this.storage.getItem(this.muteStorageKey) === 'true';

    this.bindEvents();
  }

  public dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;

    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        // Ignore close errors in suspended contexts
      }
      this.ctx = null;
      this.masterGain = null;
      this.noiseBuffer = null;
    }
  }

  /** Must be called on a user gesture (pointerdown/keydown) to unlock browser audio playback. */
  public unlock(): void {
    const audio = this.ensureContext();
    if (audio && audio.state === 'suspended') {
      void audio.resume().catch(() => {
        // Ignore autoplay rejection cleanly
      });
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.storage.setItem(this.muteStorageKey, muted ? 'true' : 'false');
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.42, this.ctx.currentTime, 0.015);
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public getSynthCallCount(): number {
    return this.synthCallCount;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.42;
      master.connect(ctx.destination);

      // Pre-build reusable 1.0s white noise buffer
      const sampleRate = ctx.sampleRate || 44100;
      const buffer = ctx.createBuffer(1, sampleRate, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.random() * 2 - 1;
      }

      this.ctx = ctx;
      this.masterGain = master;
      this.noiseBuffer = buffer;
      return ctx;
    } catch {
      return null;
    }
  }

  private bindEvents(): void {
    this.unsubscribers.push(
      this.eventBus.on('sling:aimChanged', (evt) => {
        if (evt.pullRatio <= 0.05) {
          this.lastStretchBucket = -1;
          return;
        }
        const bucket = Math.floor(evt.pullRatio * 8);
        const now = Date.now();
        if (bucket !== this.lastStretchBucket && now - this.lastStretchTimeMs >= 45) {
          this.lastStretchBucket = bucket;
          this.lastStretchTimeMs = now;
          this.playStretchTick(evt.pullRatio);
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('sling:launched', () => {
        this.lastStretchBucket = -1;
        this.playLaunchTwang();
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('physics:postSolve', (evt) => {
        if (evt.normalImpulse < this.config.collision.minSoundImpulse) return;
        const now = Date.now();
        if (now - this.lastImpactTimeMs < 38) return;
        this.lastImpactTimeMs = now;

        const mat: MaterialId =
          evt.userDataA.material ?? evt.userDataB.material ?? 'WOOD';
        const intensity = Math.min(1, evt.normalImpulse / 24);
        this.playMaterialImpact(mat, intensity * 0.65);
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('entity:destroyed', (evt) => {
        if (evt.material === 'PIG') return;
        this.playMaterialBreak(evt.material);
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('pig:popped', () => {
        this.playPigPop();
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('bird:abilityTriggered', (evt) => {
        if (evt.birdType === 'RED') {
          this.playRedShockwave();
        } else if (evt.birdType === 'BLUE') {
          this.playBlueSplitChime();
        } else if (evt.birdType === 'YELLOW') {
          this.playYellowBoostZip();
        } else if (evt.birdType === 'BLACK') {
          this.playBlackExplosion();
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('level:won', () => {
        this.playVictoryFanfare();
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on('level:lost', () => {
        this.playDefeatCadence();
      }),
    );
  }

  private prepareVoice(): { ctx: AudioContext; out: GainNode; now: number } | null {
    this.synthCallCount += 1;
    if (this.muted) return null;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain || ctx.state !== 'running') return null;
    return { ctx, out: this.masterGain, now: ctx.currentTime };
  }

  private playStretchTick(pullRatio: number): void {
    const v = this.prepareVoice();
    if (!v) return;
    const osc = v.ctx.createOscillator();
    const gain = v.ctx.createGain();
    osc.type = 'triangle';
    const f = 140 + pullRatio * 150;
    osc.frequency.setValueAtTime(f, v.now);
    osc.frequency.exponentialRampToValueAtTime(f * 0.72, v.now + 0.045);

    gain.gain.setValueAtTime(0.08, v.now);
    gain.gain.exponentialRampToValueAtTime(0.001, v.now + 0.05);

    osc.connect(gain).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + 0.055);
  }

  private playLaunchTwang(): void {
    const v = this.prepareVoice();
    if (!v) return;

    // Elastic rubber twang
    const osc = v.ctx.createOscillator();
    const gain = v.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(125, v.now);
    osc.frequency.exponentialRampToValueAtTime(285, v.now + 0.07);
    osc.frequency.exponentialRampToValueAtTime(160, v.now + 0.22);

    gain.gain.setValueAtTime(0.28, v.now);
    gain.gain.exponentialRampToValueAtTime(0.001, v.now + 0.24);
    osc.connect(gain).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + 0.25);

    // Launch air whoosh
    if (this.noiseBuffer) {
      const noise = v.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = v.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(420, v.now);
      filter.frequency.exponentialRampToValueAtTime(1250, v.now + 0.18);
      filter.Q.value = 1.6;

      const nGain = v.ctx.createGain();
      nGain.gain.setValueAtTime(0.16, v.now);
      nGain.gain.exponentialRampToValueAtTime(0.001, v.now + 0.2);

      noise.connect(filter).connect(nGain).connect(v.out);
      noise.start(v.now);
      noise.stop(v.now + 0.22);
    }
  }

  private playMaterialImpact(materialId: MaterialId, intensity: number): void {
    const v = this.prepareVoice();
    if (!v) return;

    const { baseFreqHz, decaySec, noiseMix } = MATERIALS_DB[materialId].audio;
    const dur = Math.max(0.05, decaySec * 0.6);
    const vol = Math.max(0.04, Math.min(0.32, intensity * 0.32));

    const osc = v.ctx.createOscillator();
    const toneGain = v.ctx.createGain();
    osc.type = materialId === 'GLASS' ? 'sine' : materialId === 'STONE' ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(baseFreqHz * (0.94 + Math.random() * 0.12), v.now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, baseFreqHz * 0.55), v.now + dur);

    toneGain.gain.setValueAtTime(vol * (1 - noiseMix * 0.55), v.now);
    toneGain.gain.exponentialRampToValueAtTime(0.001, v.now + dur);
    osc.connect(toneGain).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + dur + 0.01);

    if (this.noiseBuffer && noiseMix > 0.05) {
      const noise = v.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = v.ctx.createBiquadFilter();
      filter.type = materialId === 'GLASS' ? 'highpass' : materialId === 'STONE' ? 'lowpass' : 'bandpass';
      filter.frequency.setValueAtTime(baseFreqHz * 1.4, v.now);

      const nGain = v.ctx.createGain();
      nGain.gain.setValueAtTime(vol * noiseMix, v.now);
      nGain.gain.exponentialRampToValueAtTime(0.001, v.now + dur);
      noise.connect(filter).connect(nGain).connect(v.out);
      noise.start(v.now);
      noise.stop(v.now + dur + 0.01);
    }
  }

  private playMaterialBreak(materialId: MaterialId): void {
    const v = this.prepareVoice();
    if (!v) return;

    const { baseFreqHz, decaySec, noiseMix } = MATERIALS_DB[materialId].audio;
    const dur = decaySec * 1.25;

    if (materialId === 'GLASS') {
      // Shimmering high-frequency shatter harmonics
      for (const mult of [1.0, 1.42, 1.88]) {
        const osc = v.ctx.createOscillator();
        const g = v.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreqHz * mult, v.now);
        osc.frequency.exponentialRampToValueAtTime(baseFreqHz * mult * 0.82, v.now + dur);
        g.gain.setValueAtTime(0.11, v.now);
        g.gain.exponentialRampToValueAtTime(0.001, v.now + dur);
        osc.connect(g).connect(v.out);
        osc.start(v.now);
        osc.stop(v.now + dur + 0.01);
      }
    } else {
      const osc = v.ctx.createOscillator();
      const g = v.ctx.createGain();
      osc.type = materialId === 'STONE' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(baseFreqHz * 1.15, v.now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(36, baseFreqHz * 0.35), v.now + dur);
      g.gain.setValueAtTime(0.28 * (1 - noiseMix * 0.35), v.now);
      g.gain.exponentialRampToValueAtTime(0.001, v.now + dur);
      osc.connect(g).connect(v.out);
      osc.start(v.now);
      osc.stop(v.now + dur + 0.01);
    }

    if (this.noiseBuffer) {
      const noise = v.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = v.ctx.createBiquadFilter();
      filter.type = materialId === 'GLASS' ? 'highpass' : materialId === 'STONE' ? 'lowpass' : 'bandpass';
      filter.frequency.setValueAtTime(
        materialId === 'GLASS' ? 2400 : materialId === 'STONE' ? 420 : 880,
        v.now,
      );
      const nGain = v.ctx.createGain();
      nGain.gain.setValueAtTime(0.32 * noiseMix, v.now);
      nGain.gain.exponentialRampToValueAtTime(0.001, v.now + dur);
      noise.connect(filter).connect(nGain).connect(v.out);
      noise.start(v.now);
      noise.stop(v.now + dur + 0.015);
    }
  }

  private playPigPop(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const { baseFreqHz, decaySec } = MATERIALS_DB.PIG.audio;

    const osc = v.ctx.createOscillator();
    const g = v.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreqHz * 0.72, v.now);
    osc.frequency.exponentialRampToValueAtTime(baseFreqHz * 1.95, v.now + 0.09);
    osc.frequency.exponentialRampToValueAtTime(baseFreqHz * 1.35, v.now + decaySec);

    g.gain.setValueAtTime(0.3, v.now);
    g.gain.exponentialRampToValueAtTime(0.001, v.now + decaySec);
    osc.connect(g).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + decaySec + 0.01);
  }

  private playRedShockwave(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const osc = v.ctx.createOscillator();
    const g = v.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, v.now);
    osc.frequency.exponentialRampToValueAtTime(62, v.now + 0.24);
    g.gain.setValueAtTime(0.36, v.now);
    g.gain.exponentialRampToValueAtTime(0.001, v.now + 0.26);
    osc.connect(g).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + 0.27);
  }

  private playBlueSplitChime(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const freqs = [660, 830, 990];
    freqs.forEach((f, idx) => {
      const start = v.now + idx * 0.028;
      const osc = v.ctx.createOscillator();
      const g = v.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, start);
      osc.frequency.exponentialRampToValueAtTime(f * 1.12, start + 0.14);
      g.gain.setValueAtTime(0.16, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(g).connect(v.out);
      osc.start(start);
      osc.stop(start + 0.17);
    });
  }

  private playYellowBoostZip(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const osc = v.ctx.createOscillator();
    const g = v.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, v.now);
    osc.frequency.exponentialRampToValueAtTime(1480, v.now + 0.18);

    const filter = v.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, v.now);
    filter.Q.value = 1.4;

    g.gain.setValueAtTime(0.22, v.now);
    g.gain.exponentialRampToValueAtTime(0.001, v.now + 0.2);
    osc.connect(filter).connect(g).connect(v.out);
    osc.start(v.now);
    osc.stop(v.now + 0.21);
  }

  private playBlackExplosion(): void {
    const v = this.prepareVoice();
    if (!v) return;

    // Sub-bass boom
    const sub = v.ctx.createOscillator();
    const subGain = v.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(115, v.now);
    sub.frequency.exponentialRampToValueAtTime(28, v.now + 0.48);
    subGain.gain.setValueAtTime(0.55, v.now);
    subGain.gain.exponentialRampToValueAtTime(0.001, v.now + 0.52);
    sub.connect(subGain).connect(v.out);
    sub.start(v.now);
    sub.stop(v.now + 0.54);

    // Low-pass filtered blast roar
    if (this.noiseBuffer) {
      const noise = v.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = v.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(950, v.now);
      filter.frequency.exponentialRampToValueAtTime(140, v.now + 0.55);

      const nGain = v.ctx.createGain();
      nGain.gain.setValueAtTime(0.52, v.now);
      nGain.gain.exponentialRampToValueAtTime(0.001, v.now + 0.58);
      noise.connect(filter).connect(nGain).connect(v.out);
      noise.start(v.now);
      noise.stop(v.now + 0.6);
    }
  }

  private playVictoryFanfare(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, idx) => {
      const t = v.now + idx * 0.095;
      const dur = idx === notes.length - 1 ? 0.42 : 0.16;
      const osc = v.ctx.createOscillator();
      const g = v.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g).connect(v.out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    });
  }

  private playDefeatCadence(): void {
    const v = this.prepareVoice();
    if (!v) return;
    const notes = [392.0, 349.23, 311.13, 261.63]; // G4 F4 Eb4 C4
    notes.forEach((freq, idx) => {
      const t = v.now + idx * 0.13;
      const dur = idx === notes.length - 1 ? 0.4 : 0.18;
      const osc = v.ctx.createOscillator();
      const g = v.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g).connect(v.out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    });
  }
}
