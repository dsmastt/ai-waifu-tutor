export const MODEL_PATH = '/models/nikechan_v2.vrm';

export function wsUrl(): string {
  const param = new URLSearchParams(location.search).get('ws');
  if (param) return param;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export interface TutorSettings {
  name: string;
  personality: string;
  teaching_style: string;
  depth: string;
  difficulty: string;
  question_frequency: string;
  response_length: string;
  custom_instructions: string;
  voice: string;
  speed: number;
  quality: 'low' | 'balanced' | 'high';
}

export const DEFAULT_SETTINGS: TutorSettings = {
  name: 'Aoi',
  personality: 'warm, patient, and a little playful',
  teaching_style: 'socratic, example-driven',
  depth: 'moderate',
  difficulty: 'adaptive',
  question_frequency: 'often',
  response_length: 'medium',
  custom_instructions: '',
  voice: 'af_bella',
  speed: 1.0,
  quality: 'balanced',
};

export const VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore',
  'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'am_onyx',
];

const STORAGE_KEY = 'waifu-tutor.settings';

export function loadSettings(): TutorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: TutorSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
