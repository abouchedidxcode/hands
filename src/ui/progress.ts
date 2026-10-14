export interface Progress {
  unlocked: number;
  stars: Record<number, number>;
  tutorialDone: boolean;
}

const KEY = 'godhand.progress.v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Progress;
      return { unlocked: Math.max(1, p.unlocked | 0), stars: p.stars ?? {}, tutorialDone: !!p.tutorialDone };
    }
  } catch { /* storage unavailable */ }
  return { unlocked: 1, stars: {}, tutorialDone: false };
}

export function saveProgress(p: Progress) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
