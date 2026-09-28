import 'katex/dist/katex.min.css';
import './styles.css';

import * as THREE from 'three';
import { World } from './scene/world';
import { TutorCharacter } from './scene/character';
import { WindowManager } from './ui/windows';
import { HUD } from './ui/hud';
import { TutorClient } from './net/client';
import { AudioManager } from './net/audio';
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
(window as unknown as { __wt: unknown }).__wt = { world, character, windows, hud, client, audio };

const tmpVec = new THREE.Vector3();

// ------------------------------------------------------------------ loading

(async () => {
  try {
    hud.setLoading('Loading avatar…', false);
    await character.load(MODEL_PATH);
    hud.setLoading('Ready', true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('failed to load character', err);
    hud.setLoading(`Avatar failed to load: ${message}`, true);
    hud.showError(`Avatar model failed to load: ${message}`);
  }
  client.connect();
})();

// ------------------------------------------------------------------ actions

function handleAction(a: ServerEvent & { t: 'action' }): void {
  const action = a.a;
  switch (action.type) {
    case 'create_window':
      windows.createFromSpec(action.win, action.id ?? undefined);
      break;
    case 'close_window':
      windows.close(action.id);
      break;
    case 'focus_window':
      windows.focus(action.id);
      break;
    case 'expression':
      character.setExpression(action.name, action.intensity ?? 1);
      break;
    case 'look_at': {
      if (action.target === 'me') {
        character.lookAt('me');
      } else if (action.target === 'board') {
        const last = windows.lastFocused;
        character.lookAt('board', last ? last.object.position : null);
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
      windows.createFromSpec({
        kind: 'question',
        title: 'Question',
        question: {
          prompt: action.prompt,
          answer_type: (action.answer_type as 'text' | 'choice' | 'numeric') ?? 'text',
          options: action.options ?? null,
          correct: action.correct ?? null,
        },
        position: 'center',
      });
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
      hud.setStatus('thinking');
      break;
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
  client.sendAnswer(questionId, text);
  void audio.interrupt();
};

// ------------------------------------------------------------------ loop

let lastTalkGesture = 0;

world.onFrame(({ dt }) => {
  character.update(dt, performance.now() / 1000, world.camera);
  windows.update(viewport.clientHeight);

  // audio -> status + lip sync
  const speaking = audio.speaking;
  hud.setSpeaking(speaking);
  const vis = audio.tick();
  if (vis) character.setViseme(vis.v, vis.weight);
  else character.setViseme('', 0);

  // natural hand gestures while explaining
  const now = performance.now() / 1000;
  if (speaking && now - lastTalkGesture > 7 + Math.random() * 9) {
    lastTalkGesture = now;
    character.playGesture('talk');
  }

  if (!speaking && !turnActive) hud.setStatus('idle');
  else if (speaking && turnActive) hud.setStatus('speaking');
});

// resume audio context on first interaction (autoplay policy)
window.addEventListener(
  'pointerdown',
  () => {
    void audio.ensure();
    void audio.resumeIfNeeded();
  },
  { once: true },
);

world.start();
