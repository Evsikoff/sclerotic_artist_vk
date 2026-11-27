import logoUrl from '../images/logo.png';
import { audio } from './audio';
import { QUIZ_SIZE, ROUNDS, delayClass, type RoundInfo } from './content';
import { progress } from './progress';
import { showTutorial } from './tutorial';
import { h, icon, points, seconds, setScreen, signed } from './ui';

export interface MenuChoice {
  /** 0 — обучение. */
  round: number;
  /** Переигровка пройденного раунда: перед ней показывается реклама. */
  replay: boolean;
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

export function showMenu(): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const play = (round: number, replay = false) => resolve({ round, replay });

    const render = () => {
      const next = progress.nextRound();
      const played = ROUNDS.filter((r) => progress.record(r.round));
      // Пока игрок в меню, заранее качаем голос следующего раунда.
      if (next) audio.load(ROUNDS[next - 1].dictationUrl).catch(() => {});

      const skipLesson = () => {
        progress.markTutorialDone();
        render();
      };

      const list = played.length
        ? [
            h('h3', { class: 'section-title' }, 'Пройденные раунды'),
            h('ul', { class: 'round-list' }, ...played.map((r) => roundItem(r, () => play(r.round, true)))),
          ]
        : [];

      setScreen(
        h(
          'div',
          { class: 'screen menu paper-bg' },
          h(
            'div',
            { class: 'menu-inner' },
            h('img', { class: 'menu-logo', src: logoUrl, alt: 'Художник-склеротик' }),
            h(
              'div',
              { class: 'score-pill' },
              h('span', { class: 'score-star' }, icon('star')),
              h('b', {}, signed(progress.score).replace('+', '')),
              points(progress.score),
            ),
            nextCard(next, played.length > 0, play, skipLesson),
            h(
              'div',
              { class: 'help-row' },
              next !== 0 && h('button', { class: 'help-btn', onclick: () => play(0) }, icon('pencil'), 'Обучение'),
              h('button', { class: 'help-btn', onclick: () => void showTutorial() }, icon('film'), 'Видео-урок'),
            ),
            ...list,
          ),
        ),
      );
    };

    render();
  });
}

function nextCard(next: number | null, playedAny: boolean, play: (round: number) => void, skipLesson: () => void) {
  if (next === 0) {
    return h(
      'section',
      { class: 'next-card lesson' },
      h('div', { class: 'next-kicker' }, 'Начните с обучения'),
      h('h2', {}, 'Раунд 0'),
      h('p', {}, 'Пять слов без спешки: правила, рисование и все способы ходить по ячейкам.'),
      h('button', { class: 'btn btn-yellow btn-lg', onclick: () => play(0) }, icon('play'), 'Играть'),
      h('button', { class: 'next-skip', onclick: skipLesson }, 'Я уже умею играть'),
    );
  }
  if (next === null) {
    return h(
      'section',
      { class: 'next-card' },
      h('h2', {}, 'Все раунды пройдены!'),
      h('p', {}, 'Новые раунды скоро появятся. А пока можно переиграть любой из пройденных.'),
    );
  }
  const info = ROUNDS[next - 1];
  return h(
    'section',
    { class: `next-card ${delayClass(info.delay)}` },
    h('div', { class: 'next-kicker' }, playedAny ? 'Следующий раунд' : 'Первый раунд'),
    h('h2', {}, `Раунд ${next}`),
    h('div', { class: 'delay-chip' }, icon('clock'), `Задержка ${seconds(info.delay)}`),
    h('p', {}, `Диктует ${info.narrator}`),
    h('button', { class: 'btn btn-yellow btn-lg', onclick: () => play(next) }, icon('play'), 'Играть'),
  );
}

function roundItem(r: RoundInfo, onReplay: () => void) {
  const record = progress.record(r.round)!;
  return h(
    'li',
    { class: `round-item ${delayClass(r.delay)}` },
    h('div', { class: 'round-num' }, String(r.round)),
    h('div', { class: 'round-meta' }, h('b', {}, `Раунд ${r.round}`), h('small', {}, `Задержка ${r.delay} с · ${capitalize(r.narrator)}`)),
    h(
      'div',
      { class: `round-result ${record.best < 0 ? 'neg' : 'pos'}` },
      h('b', {}, signed(record.best)),
      h('small', {}, `${record.bestCorrect} из ${QUIZ_SIZE}`),
    ),
    h(
      'button',
      { class: 'replay-btn', onclick: onReplay, 'aria-label': `Переиграть раунд ${r.round} после рекламы` },
      icon('replay'),
      h('small', {}, 'реклама'),
    ),
  );
}
