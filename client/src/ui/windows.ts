import * as THREE from 'three';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import type { World } from '../scene/world';
import type { WindowSpec, QuestionSpec } from '../net/types';

const KIND_LABEL: Record<string, string> = {
  text: 'TXT', markdown: 'MD', equation: 'EQ', graph: 'GR', question: 'Q',
  image: 'IMG', table: 'TB', code: 'CODE', whiteboard: 'WB',
};

const KIND_TITLE: Record<string, string> = {
  text: 'Note', markdown: 'Notes', equation: 'Equation', graph: 'Graph',
  question: 'Question', image: 'Image', table: 'Table', code: 'Code',
  whiteboard: 'Whiteboard',
};

let windowCounter = 0;

export class TutorWindow {
  readonly id: string;
  readonly kind: string;
  readonly element: HTMLDivElement;
  /** World-space anchor position (used for placement, drag, gaze). */
  readonly position = new THREE.Vector3();
  question: QuestionSpec | null = null;
  answered = false;

  private body: HTMLElement;
  private titleEl: HTMLElement;
  private size = { w: 1.05, h: 0.85 };
  private dragState: { px: number; py: number; pos: THREE.Vector3 } | null = null;
  private resizing = false;
  onClose: ((win: TutorWindow) => void) | null = null;
  onAnswer: ((questionId: string, text: string) => void) | null = null;
  onFocus: ((win: TutorWindow) => void) | null = null;

  constructor(private world: World, spec: WindowSpec, id?: string) {
    this.id = id ?? `win${++windowCounter}`;
    this.kind = spec.kind;

    const el = document.createElement('div');
    el.className = 'wt-window';
    el.dataset.winId = this.id;
    this.element = el;

    const titlebar = document.createElement('div');
    titlebar.className = 'wt-titlebar';

    const kind = document.createElement('span');
    kind.className = 'wt-kind';
    kind.textContent = KIND_LABEL[spec.kind] ?? 'WIN';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'wt-title';
    this.titleEl.textContent = spec.title || KIND_TITLE[spec.kind] || 'Window';

    const focusBtn = document.createElement('button');
    focusBtn.className = 'wt-btn wt-focus';
    focusBtn.title = 'Focus';
    focusBtn.textContent = '◎';
    focusBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    focusBtn.addEventListener('click', () => this.onFocus?.(this));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'wt-btn wt-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', () => this.close());

    titlebar.append(kind, this.titleEl, focusBtn, closeBtn);
    el.appendChild(titlebar);

    this.body = document.createElement('div');
    this.body.className = 'wt-body';
    el.appendChild(this.body);

    const resize = document.createElement('div');
    resize.className = 'wt-resize';
    el.appendChild(resize);

    this.renderContent(spec);

    // size hints per kind
    if (spec.kind === 'table') this.size = { w: 1.3, h: 0.95 };
    if (spec.kind === 'graph') this.size = { w: 1.55, h: 1.15 };
    if (spec.kind === 'question') this.size = { w: 0.95, h: 0.8 };
    if (spec.kind === 'whiteboard') this.size = { w: 1.25, h: 1.0 };
    if (spec.kind === 'equation') this.size = { w: 0.8, h: 0.5 };

    this.bindDrag(titlebar);
    this.bindResize(resize);
  }

  // ------------------------------------------------------------------ content

  private renderContent(spec: WindowSpec): void {
    switch (spec.kind) {
      case 'markdown': {
        const html = marked.parse(spec.content ?? '') as string;
        this.body.innerHTML = DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['h1','h2','h3','h4','h5','p','ul','ol','li','strong','em','b','i','u','code','pre','blockquote','br','hr','a','table','thead','tbody','tr','th','td','img','span','del','sub','sup'],
          ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'class'],
        });
        void this.renderDiagrams();
        break;
      }
      case 'text': {
        const div = document.createElement('div');
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = spec.content ?? '';
        this.body.appendChild(div);
        break;
      }
      case 'equation': {
        const div = document.createElement('div');
        div.className = 'wt-equation-block';
        try {
          katex.render(spec.equation ?? '', div, { displayMode: true, throwOnError: false });
        } catch {
          div.textContent = spec.equation ?? '';
        }
        this.body.appendChild(div);
        break;
      }
      case 'code': {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = spec.content ?? '';
        pre.appendChild(code);
        this.body.appendChild(pre);
        break;
      }
      case 'table': {
        const table = document.createElement('table');
        for (const [i, row] of (spec.rows ?? []).entries()) {
          const tr = document.createElement('tr');
          for (const cell of row) {
            const td = document.createElement(i === 0 ? 'th' : 'td');
            td.textContent = cell;
            tr.appendChild(td);
          }
          table.appendChild(tr);
        }
        this.body.appendChild(table);
        break;
      }
      case 'image': {
        const url = spec.image_url ?? '';
        if (/^https?:\/\/|^data:image\//i.test(url)) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = spec.content ?? '';
          this.body.appendChild(img);
        } else {
          this.body.textContent = spec.content ?? 'Image unavailable';
        }
        break;
      }
      case 'graph': {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';
        this.body.appendChild(div);
        this.body.style.padding = '6px';
        void import('./graph').then(({ renderGraph }) =>
          renderGraph(div, (spec.graph ?? {}) as Record<string, unknown> as Parameters<typeof renderGraph>[1]).catch((err) => {
            console.warn('graph render failed', err);
            div.textContent = 'Graph failed to render';
          }),
        );
        break;
      }
      case 'question': {
        this.renderQuestion(spec.question ?? { prompt: spec.content ?? '' });
        break;
      }
      case 'whiteboard': {
        this.renderWhiteboard();
        break;
      }
      default:
        this.body.textContent = spec.content ?? '';
    }
  }

  private renderQuestion(q: QuestionSpec): void {
    this.question = q;
    const root = document.createElement('div');
    root.className = 'wt-question';

    const prompt = document.createElement('div');
    prompt.className = 'wt-prompt';
    prompt.textContent = q.prompt;
    root.appendChild(prompt);

    const finish = (answer: string) => {
      if (this.answered) return;
      this.answered = true;
      root.querySelectorAll('.wt-options, .wt-answer-row').forEach((n) => n.remove());
      const done = document.createElement('div');
      done.className = 'wt-answered';
      done.textContent = 'Answer submitted — the tutor will respond.';
      root.appendChild(done);
      this.onAnswer?.(this.id, answer);
    };

    if (q.answer_type === 'choice' && q.options?.length) {
      const options = document.createElement('div');
      options.className = 'wt-options';
      for (const opt of q.options) {
        const btn = document.createElement('button');
        btn.className = 'wt-option';
        btn.textContent = opt;
        btn.addEventListener('click', () => finish(opt));
        options.appendChild(btn);
      }
      root.appendChild(options);
    } else {
      const row = document.createElement('div');
      row.className = 'wt-answer-row';
      const input = document.createElement('input');
      input.className = 'wt-answer-input';
      input.type = q.answer_type === 'numeric' ? 'number' : 'text';
      input.placeholder = 'Type your answer…';
      const submit = document.createElement('button');
      submit.className = 'wt-submit';
      submit.textContent = 'Answer';
      const doSubmit = () => {
        const v = input.value.trim();
        if (v) finish(v);
      };
      submit.addEventListener('click', doSubmit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSubmit();
      });
      row.append(input, submit);
      root.appendChild(row);
    }
    this.body.appendChild(root);
  }

  private renderWhiteboard(): void {
    const root = document.createElement('div');
    root.className = 'wt-whiteboard';
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 420;
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#00000000';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#dfe6ff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    let drawing = false;
    let last: { x: number; y: number } | null = null;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      last = pos(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing || !last) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    });
    canvas.addEventListener('pointerup', () => {
      drawing = false;
      last = null;
    });

    const clear = document.createElement('button');
    clear.className = 'wt-submit';
    clear.style.marginTop = '8px';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));
    root.appendChild(clear);
    this.body.appendChild(root);
  }

  private async renderDiagrams(): Promise<void> {
    const blocks = this.body.querySelectorAll('code.language-mermaid');
    if (!blocks.length) return;
    try {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', fontFamily: 'inherit' });
      let i = 0;
      for (const block of blocks) {
        const source = block.textContent ?? '';
        const container = document.createElement('div');
        container.className = 'wt-diagram';
        block.parentElement?.replaceWith(container);
        try {
          const { svg } = await mermaid.render(`mmd-${this.id}-${i++}`, source);
          container.innerHTML = DOMPurify.sanitize(svg);
        } catch {
          container.textContent = source;
        }
      }
    } catch (err) {
      console.warn('mermaid failed to load', err);
    }
  }

  // ------------------------------------------------------------------ interaction

  private bindDrag(titlebar: HTMLElement): void {
    titlebar.addEventListener('pointerdown', (e) => {
      this.onFocus?.(this);
      this.dragState = {
        px: e.clientX,
        py: e.clientY,
        pos: this.position.clone(),
      };
      titlebar.setPointerCapture(e.pointerId);
    });
    titlebar.addEventListener('pointermove', (e) => {
      const s = this.dragState;
      if (!s) return;
      const dx = e.clientX - s.px;
      const dy = e.clientY - s.py;
      const dist = s.pos.distanceTo(this.world.camera.position);
      const wpp = this.world.worldPerPixel(dist);
      this.world.camera.getWorldDirection(_tmpV);
      _tmpRight.set(-_tmpV.z, 0, _tmpV.x).normalize();
      _tmpUp.set(0, 1, 0);
      const p = s.pos
        .clone()
        .addScaledVector(_tmpRight, dx * wpp)
        .addScaledVector(_tmpUp, -dy * wpp);
      const len = Math.hypot(p.x, p.z);
      if (len > 0.001) {
        const clamped = Math.min(3.4, Math.max(1.15, len));
        p.x *= clamped / len;
        p.z *= clamped / len;
      }
      p.y = THREE.MathUtils.clamp(p.y, 0.65, 3.3);
      this.position.copy(p);
    });
    titlebar.addEventListener('pointerup', () => {
      this.dragState = null;
    });
  }

  private bindResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      this.resizing = true;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!this.resizing) return;
      const dist = this.position.distanceTo(this.world.camera.position);
      const wpp = this.world.worldPerPixel(dist);
      this.size.w = THREE.MathUtils.clamp(this.size.w + e.movementX * wpp, 0.45, 2.4);
      this.size.h = THREE.MathUtils.clamp(this.size.h + e.movementY * wpp, 0.3, 1.9);
    });
    handle.addEventListener('pointerup', () => {
      this.resizing = false;
    });
  }

  close(): void {
    this.onClose?.(this);
  }

  setFocused(focused: boolean): void {
    this.element.classList.toggle('focused', focused);
  }

  /**
   * Called each frame: project the anchor to screen space with the same
   * camera math as the WebGL scene and size the element accordingly.
   */
  update(): void {
    const world = this.world;
    const proj = world.project(this.position, _scratch);
    if (!proj.visible) {
      this.element.style.visibility = 'hidden';
      return;
    }
    this.element.style.visibility = 'visible';

    const cam = world.camera;
    const camToWin = _tmpV.copy(this.position).sub(cam.position);
    const depth = camToWin.dot(cam.getWorldDirection(_tmpRight));
    const K = world.viewport.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    const pxPerWorld = K / Math.max(depth, 0.35);
    const w = this.size.w * pxPerWorld;
    const h = this.size.h * pxPerWorld;

    this.element.style.width = `${w}px`;
    this.element.style.height = `${h}px`;
    this.element.style.transform = `translate(${proj.x - w / 2}px, ${proj.y - h / 2}px)`;
    this.element.style.zIndex = String(Math.round(1000 - depth * 100));
  }
}

const _tmpV = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _scratch = { x: 0, y: 0, depth: 0, visible: false };

// ---------------------------------------------------------------------------

export class WindowManager {
  readonly windows = new Map<string, TutorWindow>();
  private focusedId: string | null = null;
  private layer: HTMLElement;
  onAnswer: ((questionId: string, text: string) => void) | null = null;

  constructor(private world: World) {
    this.layer = document.createElement('div');
    this.layer.className = 'windows-layer';
    world.viewport.appendChild(this.layer);
  }

  createFromSpec(spec: WindowSpec, id?: string): TutorWindow {
    const win = new TutorWindow(this.world, spec, id);
    this.placeWindow(win, spec.position ?? 'auto');
    this.layer.appendChild(win.element);
    this.windows.set(win.id, win);
    win.onClose = (w) => this.close(w.id);
    win.onFocus = (w) => this.focus(w.id);
    win.onAnswer = (qid, text) => this.onAnswer?.(qid, text);
    requestAnimationFrame(() => win.element.classList.add('visible'));
    this.focus(win.id);

    // keep the room readable: retire the oldest non-question window past 7
    const closable = [...this.windows.values()].filter((w) => w.kind !== 'question');
    if (closable.length > 7) {
      this.close(closable[0].id);
    }
    return win;
  }

  private placeWindow(win: TutorWindow, position: string): void {
    const side = position === 'center' ? 'center' : position === 'right' ? 'right' : position === 'left' ? 'left' : this.autoSide();
    // compact: reuse the first free slot index on this side
    let idx = 0;
    for (const w of this.windows.values()) {
      const k = (w as TutorWindow & { slot?: { side: string; idx: number } }).slot;
      if (k && k.side === side && k.idx === idx) {
        idx++;
      }
    }
    (win as TutorWindow & { slot?: { side: string; idx: number } }).slot = { side, idx };

    // Slots around the tutor, sized to fit the default camera framing.
    // The character stands at the origin facing +Z (the camera).
    const slots: Record<string, [number, number, number][]> = {
      left: [
        [1.58, 1.48, 0.05],
        [1.22, 2.02, -0.22],
        [1.74, 1.02, 0.3],
      ],
      right: [
        [-1.58, 1.48, 0.05],
        [-1.22, 2.02, -0.22],
        [-1.74, 1.02, 0.3],
      ],
      center: [
        [-1.32, 1.95, 0.55],
        [1.32, 1.95, 0.55],
      ],
    };
    const list = slots[side] ?? slots.center;
    const [x, y, z] = list[idx % list.length];
    win.position.set(x, y, z);
  }

  private autoSide(): string {
    const left = [...this.windows.values()].filter((w) => {
      const k = (w as TutorWindow & { slot?: { side: string } }).slot;
      return k?.side === 'left';
    }).length;
    const right = this.windows.size - left;
    return left <= right ? 'left' : 'right';
  }

  close(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    win.element.remove();
    this.windows.delete(id);
    if (this.focusedId === id) this.focusedId = null;
  }

  closeAll(): void {
    for (const id of [...this.windows.keys()]) this.close(id);
  }

  focus(id: string): void {
    this.focusedId = id;
    for (const [wid, w] of this.windows) w.setFocused(wid === id);
  }

  get(id: string): TutorWindow | undefined {
    return this.windows.get(id);
  }

  get lastFocused(): TutorWindow | null {
    if (this.focusedId && this.windows.has(this.focusedId)) {
      return this.windows.get(this.focusedId)!;
    }
    const last = [...this.windows.values()].at(-1);
    return last ?? null;
  }

  getPosition(id: string, out: THREE.Vector3): boolean {
    const win = this.windows.get(id);
    if (!win) return false;
    out.copy(win.position);
    return true;
  }

  update(): void {
    for (const win of this.windows.values()) win.update();
  }
}
