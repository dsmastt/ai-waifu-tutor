import { wsUrl } from '../config';
import type { ServerEvent } from './types';

type Handler = (event: ServerEvent) => void;

export class TutorClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500;
  onStatus: ((connected: boolean) => void) | null = null;

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.onStatus?.(true);
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as ServerEvent;
        for (const h of this.handlers) h(event);
      } catch {
        /* malformed frame: ignore */
      }
    };

    ws.onclose = () => {
      this.onStatus?.(false);
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  sendUserMessage(text: string): void {
    this.send({ t: 'user_message', text });
  }

  sendAnswer(questionId: string, text: string): void {
    this.send({ t: 'answer', question_id: questionId, text });
  }

  sendInterrupt(): void {
    this.send({ t: 'interrupt' });
  }

  sendSettings(settings: Record<string, unknown>): void {
    this.send({ t: 'settings_update', settings });
  }
}
