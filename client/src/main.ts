import 'katex/dist/katex.min.css';
import './styles.css';

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { World } from './scene/world';
import { TutorCharacter } from './scene/character';
import { WindowManager } from './ui/windows';
import { HUD } from './ui/hud';
import { TutorClient } from './net/client';
import { AudioManager } from './net/audio';
import { retargetMixamoClip } from './scene/retarget';
import { MODEL_PATH, loadSettings, saveSettings, type TutorSettings } from './config';
import type { ServerEvent } from './net/types';

const app = document.getElementById('app')!;
const viewport = document.createElement('div');
viewport.id = 'viewport';
app.appendChild(viewport);

window.addEventListener('error', (e) => {
  const list = (window as unknown as { __errors: string[] }).__errors ?? [];
  list.push(String(e.message));
  (window as unknown as { __errors: string[] }).__errors = list;
});
window.addEventListener('unhandledrejection', (e) => {
  const list = (window as unknown as { __errors: string[] }).__errors ?? [];
  list.push('unhandled: ' + String(e.reason));
  (window as unknown as { __errors: string[] }).__errors = list;
});

const world = new World(viewport);
const character = new TutorCharacter();
world.scene.add(character.group);
const windows = new WindowManager(world);
const hud = new HUD(app);
const client = new TutorClient();
const audio = new AudioManager();

let settings: TutorSettings = loadSettings();
hud.populateSettings(settings);
applyQuality(settings.quality);

function applyQuality(quality: TutorSettings['quality']): void {
  const dpr = window.devicePixelRatio || 1;
  const cap = quality === 'low' ? 1 : quality === 'high' ? 2 : 1.5;
  world.renderer.setPixelRatio(Math.min(dpr, cap));
  world.renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}

// debug handle (test harness + power users)
(window as unknown as { __wt: unknown }).__wt = {
  world, character, windows, hud, client, audio,
  THREE, retargetMixamoClip, FBXLoader,
};

const tmpVec = new THREE.Vector3();

// ------------------------------------------------------------------ loading

(async () => {
  try {
    hud.setLoading('Loading avatar…', false);
    await character.load(MODEL_PATH);
    hud.setLoading('Ready', true);
    void loadAnimations();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('failed to load character', err);
    hud.setLoading(`Avatar failed to load: ${message}`, true);
    hud.showError(`Avatar model failed to load: ${message}`);
  }
  client.connect();
})();

// ------------------------------------------------------------------ clips

interface ManifestEntry {
  file: string;
  rootCorrection?: number;
}

type ManifestSlot = ManifestEntry | ManifestEntry[];

interface AnimManifest {
  base?: ManifestEntry;
  idleAlts?: ManifestEntry[];
  talking?: ManifestSlot;
  gestures?: Record<string, ManifestSlot>;
}

async function loadAnimations(): Promise<void> {
  if (!character.clips) return;
  const animErrors: string[] = [];
  (window as unknown as { __animErrors?: string[] }).__animErrors = animErrors;
  try {
    const res = await fetch('/animations/manifest.json');
    if (!res.ok) return;
    const manifest = (await res.json()) as AnimManifest;
    const fbx = new FBXLoader();
    const bones = character.getRawBones();
    const bind = character.getRawBind();

    const loadOne = async (
      name: string,
      entry: ManifestEntry,
      asBase: boolean,
    ): Promise<boolean> => {
      try {
        const root = await fbx.loadAsync(`/animations/${entry.file}`);
        const clip = root.animations[0];
        if (!clip) return false;
        const result = retargetMixamoClip(
          root,
          clip,
          bones,
          bind,
          entry.rootCorrection ?? 0,
        );
        if (!result) {
          animErrors.push(`${entry.file}: no retargetable tracks`);
          console.warn(`[anim] no retargetable tracks in ${entry.file}`);
          return false;
        }
        (window as unknown as { __animDebug?: unknown[] }).__animDebug = [
          ...(((window as unknown as { __animDebug?: unknown[] }).__animDebug) ?? []),
          { name, file: entry.file, debug: result.debug },
        ];
        character.clips!.register(
          name,
          result.clip,
          asBase,
          result.hipsPos
            ? { times: result.hipsPos.times, values: result.hipsPos.values, bobScale: result.bobScale }
            : null,
        );
        console.info(
          `[anim] ${entry.file}: ${result.mapped} tracks, ${result.clip.duration.toFixed(1)}s -> ${name}`,
        );
        return true;
      } catch (err) {
        const msg = `${entry.file}: ${err instanceof Error ? err.message : String(err)}`;
        animErrors.push(msg);
        console.warn(`[anim] failed ${msg}`);
        return false;
      }
    };

    const loadSlot = async (
      name: string,
      slot: ManifestSlot | undefined,
      asBase: boolean,
    ): Promise<void> => {
      if (!slot) return;
      const list = Array.isArray(slot) ? slot : [slot];
      for (const entry of list) {
        await loadOne(name, entry, asBase);
      }
    };

    // the base slot is a priority list: first successful clip wins
    const loadFirst = async (
      name: string,
      slot: ManifestSlot | undefined,
      asBase: boolean,
    ): Promise<boolean> => {
      if (!slot) return false;
      const list = Array.isArray(slot) ? slot : [slot];
      for (const entry of list) {
        if (await loadOne(name, entry, asBase)) return true;
      }
      return false;
    };

    await loadFirst('base', manifest.base, true);
    for (const alt of manifest.idleAlts ?? []) {
      await loadOne('idleAlt', alt, false);
    }
    await loadSlot('talking', manifest.talking, false);
    for (const [name, slot] of Object.entries(manifest.gestures ?? {})) {
      await loadSlot(name, slot, false);
    }
    if (character.clips.hasBase) {
      console.info(`[anim] ready: ${character.clips.names().join(', ')}`);
    } else {
      console.info('[anim] no idle clip found; using procedural animation');
    }
  } catch (err) {
    console.warn('[anim] manifest load failed', err);
  }
}

// ------------------------------------------------------------------ actions

let autoGazeTimer: number | null = null;

function gazeAtWindow(winId: string | null | undefined, seconds: number): void {
  const id = winId ?? windows.lastFocused?.id;
  if (!id) return;
  if (!windows.getPosition(id, tmpVec)) return;
  character.lookAt('window', tmpVec);
  // optionally gesture at it if it sits off to a side
  if (Math.abs(tmpVec.x) > 1.2 && Math.random() < 0.4) {
    character.playGesture('point', tmpVec.clone());
  }
  if (autoGazeTimer !== null) window.clearTimeout(autoGazeTimer);
  autoGazeTimer = window.setTimeout(() => character.lookAt('me'), seconds * 1000);
}

function handleAction(a: ServerEvent & { t: 'action' }): void {
  const action = a.a;
  switch (action.type) {
    case 'create_window': {
      const win = windows.createFromSpec(action.win, action.id ?? undefined);
      gazeAtWindow(win.id, 3);
      break;
    }
    case 'close_window':
      windows.close(action.id);
      break;
    case 'focus_window':
      windows.focus(action.id);
      gazeAtWindow(action.id, 2);
      break;
    case 'expression':
      character.setExpression(action.name, action.intensity ?? 1);
      break;
    case 'look_at': {
      if (autoGazeTimer !== null) {
        window.clearTimeout(autoGazeTimer);
        autoGazeTimer = null;
      }
      if (action.target === 'me') {
        character.lookAt('me');
      } else if (action.target === 'board') {
        const last = windows.lastFocused;
        character.lookAt('board', last ? last.position : null);
      } else if (action.target.startsWith('window:')) {
        const id = action.target.slice('window:'.length);
        if (windows.getPosition(id, tmpVec)) character.lookAt('window', tmpVec);
      } else if (action.target === 'random') {
        character.lookAt('random');
      } else if (action.target === 'none') {
        character.lookAt('none');
      }
      break;
    }
    case 'gesture': {
      let target: THREE.Vector3 | null = null;
      if (action.target && action.target.startsWith('window:')) {
        const id = action.target.slice('window:'.length);
        if (windows.getPosition(id, tmpVec)) target = tmpVec.clone();
      }
      character.playGesture(action.name, target);
      break;
    }
    case 'ask_question': {
      const win = windows.createFromSpec({
        kind: 'question',
        title: 'Question',
        question: {
          prompt: action.prompt,
          answer_type: (action.answer_type as 'text' | 'choice' | 'numeric') ?? 'text',
          options: action.options ?? null,
          correct: action.correct ?? null,
        },
        position: 'center',
      }, action.id ?? undefined);
      // she shows you the question, then turns back to you
      gazeAtWindow(win.id, 1.6);
      break;
    }
    default:
      break;
  }
}

let turnActive = false;
let dropAudio = false;

client.onStatus = (connected) => {
  if (!connected) {
    turnActive = false;
    dropAudio = true;
    void audio.interrupt();
    hud.setStatus('connecting');
    hud.showNotice(
      'Lost connection to the tutor server. Trying to reconnect… (is it running? scripts/dev.sh)',
      8000,
    );
  } else {
    hud.setStatus('idle');
  }
};

client.on((event) => {
  switch (event.t) {
    case 'hello':
      if (event.provider === 'mock') {
        hud.showNotice(
          'Running in mock mode (no LLM API key). Add LLM_API_KEY to .env and restart the server for a real tutor.',
          14000,
        );
      }
      greetOnce();
      break;
    case 'status':
      turnActive = true;
      dropAudio = false;
      character.setListening(false);
      character.setExpression('thinking', 0.9);
      hud.setStatus('thinking');
      break;
    case 'verdict': {
      if (event.ok === true) {
        character.setExpression('happy', 1);
        character.playGesture('nod');
      } else if (event.ok === false) {
        character.setExpression('sad', 0.7);
      }
      break;
    }
    case 'speech_delta':
      hud.appendSubtitle(event.text);
      break;
    case 'action':
      handleAction(event as ServerEvent & { t: 'action' });
      break;
    case 'audio':
      if (dropAudio) break;
      audio.addAudioChunk(event.chunk);
      hud.setStatus('speaking');
      break;
    case 'visemes':
      if (dropAudio) break;
      audio.addVisemes(event.events);
      break;
    case 'utterance_end':
      if (dropAudio) break;
      void audio.finishUtterance();
      break;
    case 'turn_end':
      turnActive = false;
      dropAudio = false;
      character.setListening(false);
      hud.setStatus('idle');
      hud.clearSubtitle();
      break;
    case 'interrupted':
      turnActive = false;
      dropAudio = false;
      void audio.interrupt();
      hud.setStatus('idle');
      hud.clearSubtitle();
      break;
    case 'error':
      hud.showError(event.message);
      hud.setStatus('error');
      break;
    default:
      break;
  }
});

// ------------------------------------------------------------------ input

function greetOnce(): void {
  try {
    if (localStorage.getItem('wt.greeted')) return;
    localStorage.setItem('wt.greeted', '1');
  } catch {
    return;
  }
  window.setTimeout(() => {
    turnActive = false;
    dropAudio = false;
    client.sendUserMessage('Hello!');
  }, 600);
}

hud.onSend = (text) => {
  if (!client.connected) {
    hud.showError('Not connected to the tutor server. Start it with scripts/dev.sh, then try again.');
    return;
  }
  turnActive = false;
  dropAudio = false;
  character.setListening(true);
  client.sendUserMessage(text);
  void audio.interrupt();
  audio.ensure().catch(() => {
    /* audio unavailable; the lesson still works silently */
  });
};

hud.onStop = () => {
  dropAudio = true;
  client.sendInterrupt();
  void audio.interrupt();
};

hud.onSettings = (s) => {
  settings = s;
  saveSettings(s);
  applyQuality(s.quality);
  client.sendSettings({ tutor: { ...s } });
};

windows.onAnswer = (questionId, text) => {
  turnActive = false;
  dropAudio = false;
  character.setListening(true);
  client.sendAnswer(questionId, text);
  void audio.interrupt();
};

// ------------------------------------------------------------------ loop

let lastTalkGesture = 0;
let lastSmile = 0;

world.onFrame(({ dt }) => {
  character.update(dt, performance.now() / 1000, world.camera);
  windows.update();

  // audio -> status + lip sync
  const speaking = audio.speaking;
  hud.setSpeaking(speaking);
  const vis = audio.tick();
  if (vis) character.setViseme(vis.v, vis.weight);
  else character.setViseme('', 0);

  // natural hand gestures + warm micro-smiles while explaining. The
  // procedural talk gesture only runs without clips - during the talking
  // clip the mixer already animates her arms, and the procedural pose
  // would fight it frame to frame (twitching)
  const now = performance.now() / 1000;
  if (speaking) {
    const hasClips = !!character.clips && character.clips.hasBase;
    if (!hasClips && now - lastTalkGesture > 7 + Math.random() * 9) {
      lastTalkGesture = now;
      character.playGesture('talk');
    }
    if (now - lastSmile > 11 + Math.random() * 8) {
      lastSmile = now;
      character.setExpression('happy', 0.35);
    }
  }

  if (!speaking && !turnActive) hud.setStatus('idle');
  else if (speaking && turnActive) hud.setStatus('speaking');
});

// browser autoplay: unlock audio on any interaction and hint when muted
const unlockAudio = () => {
  void audio.ensure();
  void audio.resumeIfNeeded();
};
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
audio.onMuted = () => {
  hud.showNotice('Sound is muted until you click anywhere in the page.', 6000);
};

world.start();
