export type WindowKind =
  | 'text' | 'markdown' | 'equation' | 'graph' | 'question'
  | 'image' | 'table' | 'code' | 'whiteboard';

export interface QuestionSpec {
  prompt: string;
  answer_type?: 'text' | 'choice' | 'numeric';
  options?: string[] | null;
  correct?: string | null;
}

export interface WindowSpec {
  kind: WindowKind;
  title?: string | null;
  content?: string | null;
  equation?: string | null;
  graph?: Record<string, unknown> | null;
  question?: QuestionSpec | null;
  image_url?: string | null;
  rows?: string[][] | null;
  position?: 'left' | 'right' | 'center' | 'auto' | null;
}

export type Action =
  | { type: 'create_window'; win: WindowSpec; id?: string | null }
  | { type: 'close_window'; id: string }
  | { type: 'look_at'; target: string }
  | { type: 'gesture'; name: string; target?: string | null }
  | { type: 'expression'; name: string; intensity?: number }
  | { type: 'focus_window'; id: string }
  | { type: 'ask_question'; prompt: string; answer_type?: string; options?: string[] | null; correct?: string | null };

export interface VisemeEvent {
  v: string;
  start: number;
  end: number;
}

export type ServerEvent =
  | { t: 'hello'; provider: string }
  | { t: 'status'; state: string }
  | { t: 'speech_delta'; text: string }
  | { t: 'action'; a: Action }
  | { t: 'audio'; format: string; chunk: string }
  | { t: 'visemes'; events: VisemeEvent[] }
  | { t: 'utterance_end' }
  | { t: 'turn_end' }
  | { t: 'interrupted' }
  | { t: 'settings_ok' }
  | { t: 'error'; message: string };
