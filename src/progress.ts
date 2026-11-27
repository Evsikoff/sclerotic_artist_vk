import { ROUNDS } from './content';

const KEY = 'sclerotic-artist:progress';

export interface RoundRecord {
  /** Лучший результат раунда в баллах и сколько при нём было верных ответов. */
  best: number;
  bestCorrect: number;
  plays: number;
}

interface Saved {
  /** Сумма баллов за все сыгранные раунды, включая переигровки. */
  score: number;
  rounds: Record<number, RoundRecord>;
  /** Нулевой раунд — обучение — пройден или пропущен. */
  tutorialDone: boolean;
}

function load(): Saved {
  const empty: Saved = { score: 0, rounds: {}, tutorialDone: false };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

const state = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Хранилище недоступно (приватный режим): прогресс живёт до закрытия вкладки.
  }
}

export const progress = {
  get score() {
    return state.score;
  },

  /** Обучение нужно тем, кто его не проходил и ещё не сыграл ни одного раунда. */
  get tutorialDone() {
    return state.tutorialDone || Object.keys(state.rounds).length > 0;
  },

  record(round: number): RoundRecord | null {
    return state.rounds[round] ?? null;
  },

  /** Раунды открываются по порядку: сначала обучение (раунд 0), потом первый ещё не сыгранный. */
  nextRound(): number | null {
    if (!this.tutorialDone) return 0;
    return ROUNDS.find((r) => !state.rounds[r.round])?.round ?? null;
  },

  finishRound(round: number, points: number, correct: number) {
    state.score += points;
    const prev = state.rounds[round];
    const better = !prev || points > prev.best;
    state.rounds[round] = {
      best: better ? points : prev.best,
      bestCorrect: better ? correct : prev.bestCorrect,
      plays: (prev?.plays ?? 0) + 1,
    };
    save();
  },

  markTutorialDone() {
    state.tutorialDone = true;
    save();
  },
};
