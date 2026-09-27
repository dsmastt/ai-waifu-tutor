import { DEFAULT_SETTINGS, VOICES, type TutorSettings } from '../config';

export class HUD {
  readonly root: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private subtitle: HTMLElement;
  private statusPill: HTMLElement;
  private errorBanner: HTMLElement;
  private settingsPanel: HTMLElement;
  private loadingScreen: HTMLElement;
  private loadingLabel: HTMLElement;
  private speechText = '';
  private subtitleTimer: number | null = null;

  onSend: ((text: string) => void) | null = null;
  onStop: (() => void) | null = null;
  onSettings: ((settings: TutorSettings) => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    container.appendChild(this.root);

    this.root.innerHTML = `
      <div id="status-pill" class="hidden"><span id="status-dot"></span><span id="status-text"></span></div>
      <div id="subtitle" class="hidden"></div>
      <div id="input-bar">
        <textarea id="msg-input" rows="1" placeholder="Ask me to teach you something…"></textarea>
        <button id="stop-btn" title="Stop">■</button>
        <button id="send-btn" title="Send">➤</button>
      </div>
      <button id="settings-btn" title="Settings">⚙</button>
      <div id="error-banner" class="hidden"></div>
      <div id="settings-panel" class="hidden">
        <button id="settings-close">✕</button>
        <h2>Tutor settings</h2>
        <div class="st-field"><label>Name</label><input type="text" id="st-name"></div>
        <div class="st-field"><label>Personality</label><input type="text" id="st-personality"></div>
        <div class="st-field"><label>Teaching style</label><input type="text" id="st-style"></div>
        <div class="st-field"><label>Explanation depth</label>
          <select id="st-depth"><option>light</option><option>moderate</option><option>deep</option></select></div>
        <div class="st-field"><label>Difficulty</label>
          <select id="st-difficulty"><option>easy</option><option>adaptive</option><option>hard</option></select></div>
        <div class="st-field"><label>Question frequency</label>
          <select id="st-questions"><option>rarely</option><option>sometimes</option><option>often</option></select></div>
        <div class="st-field"><label>Response length</label>
          <select id="st-length"><option>short</option><option>medium</option><option>long</option></select></div>
        <div class="st-field"><label>Custom instructions</label><textarea id="st-custom"></textarea></div>
        <div class="st-field"><label>Voice</label>
          <select id="st-voice">${VOICES.map((v) => `<option>${v}</option>`).join('')}</select></div>
        <div class="st-field"><label>Speech speed</label>
          <div class="st-range-row"><input type="range" id="st-speed" min="0.6" max="1.6" step="0.05"><output id="st-speed-out">1.0</output></div></div>
        <div class="st-field"><label>Graphics quality</label>
          <select id="st-quality">
            <option value="low">Low</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
          </select></div>
        <div class="st-field"><label>Learning material (PDF / text)</label>
          <input type="file" id="st-file" accept=".pdf,.txt,.md,.markdown,.csv,.json">
          <div style="display:flex;gap:8px;margin-top:8px">
            <button id="st-upload" class="wt-submit">Upload</button>
            <button id="st-clear-materials" class="wt-option" style="flex:1">Clear material</button>
          </div>
          <div id="st-materials-status" style="font-size:12px;color:var(--text-dim);margin-top:6px"></div>
        </div>
        <button id="settings-save">Save & apply</button>
      </div>
      <div id="loading-screen"><div><div class="spinner"></div><div id="loading-label">Loading…</div></div></div>
    `;

    this.input = this.root.querySelector('#msg-input')!;
    this.sendBtn = this.root.querySelector('#send-btn')!;
    this.stopBtn = this.root.querySelector('#stop-btn')!;
    this.subtitle = this.root.querySelector('#subtitle')!;
    this.statusPill = this.root.querySelector('#status-pill')!;
    this.errorBanner = this.root.querySelector('#error-banner')!;
    this.settingsPanel = this.root.querySelector('#settings-panel')!;
    this.loadingScreen = this.root.querySelector('#loading-screen')!;
    this.loadingLabel = this.root.querySelector('#loading-label')!;

    this.bind();
  }

  private bind(): void {
    const send = () => {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      this.autoGrow();
      this.onSend?.(text);
    };
    this.sendBtn.addEventListener('click', send);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    this.input.addEventListener('input', () => this.autoGrow());
    this.stopBtn.addEventListener('click', () => this.onStop?.());

    const settingsBtn = this.root.querySelector('#settings-btn')!;
    settingsBtn.addEventListener('click', () => this.settingsPanel.classList.toggle('hidden'));
    this.root.querySelector('#settings-close')!.addEventListener('click', () => {
      this.settingsPanel.classList.add('hidden');
    });

    const speed = this.root.querySelector<HTMLInputElement>('#st-speed')!;
    const speedOut = this.root.querySelector('#st-speed-out')!;
    speed.addEventListener('input', () => (speedOut.textContent = speed.value));

    this.root.querySelector('#settings-save')!.addEventListener('click', () => {
      const settings: TutorSettings = {
        name: this.val('#st-name'),
        personality: this.val('#st-personality'),
        teaching_style: this.val('#st-style'),
        depth: this.val('#st-depth'),
        difficulty: this.val('#st-difficulty'),
        question_frequency: this.val('#st-questions'),
        response_length: this.val('#st-length'),
        custom_instructions: this.val('#st-custom'),
        voice: this.val('#st-voice'),
        speed: parseFloat(speed.value),
        quality: this.val('#st-quality') as TutorSettings['quality'],
      };
      this.onSettings?.(settings);
      this.settingsPanel.classList.add('hidden');
    });

    const fileInput = this.root.querySelector<HTMLInputElement>('#st-file')!;
    const materialsStatus = this.root.querySelector('#st-materials-status')!;
    this.root.querySelector('#st-upload')!.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        materialsStatus.textContent = 'Pick a file first.';
        return;
      }
      materialsStatus.textContent = 'Uploading…';
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/syllabus', { method: 'POST', body: form });
        const data = await res.json();
        materialsStatus.textContent = data.ok
          ? `Added “${file.name}” (${data.chunks} chunks, ${data.documents} docs total).`
          : `Upload failed: ${data.error ?? 'unknown error'}`;
        fileInput.value = '';
      } catch {
        materialsStatus.textContent = 'Upload failed (server unreachable?).';
      }
    });
    this.root.querySelector('#st-clear-materials')!.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/syllabus', { method: 'DELETE' });
        const data = await res.json();
        materialsStatus.textContent = data.ok ? 'Material cleared.' : 'Failed to clear.';
      } catch {
        materialsStatus.textContent = 'Server unreachable.';
      }
    });
  }

  private val(sel: string): string {
    return (this.root.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value.trim();
  }

  private autoGrow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(120, this.input.scrollHeight) + 'px';
  }

  populateSettings(s: TutorSettings): void {
    const set = (sel: string, v: string) => {
      const el = this.root.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      el.value = v;
    };
    set('#st-name', s.name);
    set('#st-personality', s.personality);
    set('#st-style', s.teaching_style);
    set('#st-depth', s.depth);
    set('#st-difficulty', s.difficulty);
    set('#st-questions', s.question_frequency);
    set('#st-length', s.response_length);
    set('#st-custom', s.custom_instructions);
    set('#st-voice', s.voice);
    set('#st-quality', s.quality ?? 'balanced');
    const speed = this.root.querySelector<HTMLInputElement>('#st-speed')!;
    speed.value = String(s.speed);
    this.root.querySelector('#st-speed-out')!.textContent = String(s.speed);
  }

  // ------------------------------------------------------------------ status

  setStatus(state: 'idle' | 'thinking' | 'speaking' | 'error', label?: string): void {
    const pill = this.statusPill;
    const text = this.root.querySelector('#status-text')!;
    if (state === 'idle') {
      pill.classList.add('hidden');
      pill.classList.remove('thinking', 'speaking', 'error');
      return;
    }
    pill.classList.remove('hidden', 'thinking', 'speaking', 'error');
    pill.classList.add(state);
    text.textContent =
      label ?? (state === 'thinking' ? 'Thinking…' : state === 'speaking' ? 'Speaking…' : 'Error');
  }

  appendSubtitle(text: string): void {
    this.speechText = (this.speechText + ' ' + text).trim();
    if (this.speechText.length > 900) {
      this.speechText = this.speechText.slice(-900);
    }
    this.subtitle.textContent = this.speechText;
    this.subtitle.classList.remove('hidden');
    if (this.subtitleTimer) window.clearTimeout(this.subtitleTimer);
    this.subtitleTimer = window.setTimeout(() => {
      this.subtitle.classList.add('hidden');
    }, 6000);
  }

  clearSubtitle(): void {
    this.speechText = '';
    this.subtitle.classList.add('hidden');
  }

  showError(message: string): void {
    this.errorBanner.textContent = message;
    this.errorBanner.classList.remove('info');
    this.errorBanner.classList.remove('hidden');
    window.setTimeout(() => this.errorBanner.classList.add('hidden'), 8000);
  }

  showNotice(message: string, durationMs = 12000): void {
    this.errorBanner.textContent = message;
    this.errorBanner.classList.add('info');
    this.errorBanner.classList.remove('hidden');
    window.setTimeout(() => this.errorBanner.classList.add('hidden'), durationMs);
  }

  setSpeaking(speaking: boolean): void {
    this.stopBtn.classList.toggle('visible', speaking);
  }

  setLoading(label: string, done: boolean): void {
    this.loadingLabel.textContent = label;
    if (done) {
      this.loadingScreen.classList.add('hidden');
    } else {
      this.loadingScreen.classList.remove('hidden');
    }
  }
}
