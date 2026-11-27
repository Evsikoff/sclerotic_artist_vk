import { h, icon } from './ui';

/** Панели поверх поля, общие для раунда и обучения: шапка, инструменты, опрос. */

function toolButton(name: Parameters<typeof icon>[0], label: string, onclick: () => void) {
  return h('button', { class: 'tool', onclick }, icon(name), h('span', {}, label));
}

export interface HudActions {
  menu(): void;
  done(): void;
  undo(): void;
  zoomOut(): void;
  spoken(): void;
  next(): void;
  repeat(): void;
}

export type Hud = ReturnType<typeof buildHud>;

export function buildHud(title: string, act: HudActions) {
  const canvas = h('canvas', { class: 'board' });
  const caption = h('div', { class: 'hud-caption' }, title);
  const status = h('div', { class: 'hud-status' }, 'Приготовьтесь');
  const done = h('button', { class: 'btn btn-green btn-small', hidden: true, onclick: act.done }, icon('check'), 'Готово');
  const bar = h('i');
  const progressBar = h('div', { class: 'hud-progress' }, bar);
  const menu = h('button', { class: 'icon-btn', 'aria-label': 'Пауза', onclick: act.menu }, icon('pause'));
  const soundHint = h('div', { class: 'sound-hint', hidden: true }, icon('speaker'), 'Коснитесь экрана, чтобы вернуть звук');
  const top = h('header', { class: 'hud-top' }, menu, h('div', { class: 'hud-center' }, caption, status), done, progressBar, soundHint);

  const undo = toolButton('undo', 'Отменить', act.undo);
  const zoom = toolButton('grid', 'Отдалить', act.zoomOut);
  const spoken = toolButton('speaker', '', act.spoken);
  spoken.title = 'К ячейке, о которой голос говорил последней';
  const next = toolButton('arrow', '', act.next);
  const tools = h('footer', { class: 'hud-bottom', hidden: true }, undo, zoom, spoken, next);

  const question = h('div', { class: 'quiz-question' });
  const input = h('input', {
    class: 'quiz-input',
    type: 'text',
    placeholder: 'Ваш ответ',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'send',
    maxlength: 60,
  });
  // Форма никогда не отправляется по-настоящему: ответ принимает ask().
  const form = h(
    'form',
    { class: 'quiz-form', onsubmit: (e: Event) => e.preventDefault() },
    input,
    h('button', { class: 'btn', type: 'submit' }, 'Ответить'),
  );
  const dunno = h('button', { class: 'link-btn', type: 'button' }, 'Не помню');
  const feedback = h('div', { class: 'quiz-feedback', hidden: true });
  const quiz = h(
    'div',
    { class: 'quiz-panel', hidden: true },
    h(
      'div',
      { class: 'quiz-head' },
      question,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Повторить номер', onclick: act.repeat }, icon('speaker')),
    ),
    form,
    dunno,
    feedback,
  );

  return { canvas, caption, status, done, bar, progressBar, menu, soundHint, top, undo, zoom, spoken, next, tools, quiz, question, input, form, dunno, feedback };
}

/** Показывает вопрос «Что было в ячейке №…?» и ждёт ответа; null — «Не помню». */
export function askCell(ui: Hud, cell: number): Promise<string | null> {
  const { question, input, form, dunno, feedback } = ui;
  question.replaceChildren('Что было в ячейке ', h('b', {}, `№${cell + 1}`), '?');
  input.value = '';
  input.readOnly = false;
  dunno.hidden = false;
  feedback.hidden = true;
  input.focus({ preventScroll: true });
  return new Promise((resolve) => {
    const settle = (answer: string | null) => {
      form.onsubmit = null;
      dunno.onclick = null;
      // Поле остаётся в фокусе, чтобы клавиатура телефона не прыгала между вопросами.
      input.readOnly = true;
      resolve(answer);
    };
    form.onsubmit = () => {
      const text = input.value.trim();
      if (text) settle(text);
      else input.focus();
    };
    dunno.onclick = () => settle(null);
  });
}

export function showAnswerFeedback(ui: Hud, ok: boolean, word: string) {
  const { dunno, feedback } = ui;
  dunno.hidden = true;
  feedback.hidden = false;
  feedback.className = `quiz-feedback ${ok ? 'ok' : 'bad'}`;
  feedback.textContent = ok ? 'Верно! +1' : `Правильный ответ: «${word}». −1`;
}

/** Ячейка по стрелке: следующая, а с общего вида — та, что сейчас горит. */
export function nextCellFrom(focused: number | null, lit: number | null, cells: number): number {
  return focused === null ? (lit ?? 0) : (focused + 1) % cells;
}

/** Обновляет инструменты под поле: что можно отменить, куда ведут динамик и стрелка. */
export function updateToolButtons(ui: Hud, state: { canUndo: boolean; focused: number | null; spoken: number | null; next: number; rowEnd: boolean }) {
  const { undo, zoom, spoken, next } = ui;
  undo.disabled = !state.canUndo;
  zoom.disabled = state.focused === null;
  spoken.disabled = state.spoken === null || state.spoken === state.focused;
  spoken.querySelector('span')!.textContent = state.spoken === null ? '№—' : `№${state.spoken + 1}`;
  next.querySelector('span')!.textContent = `№${state.next + 1}`;
  // С правого края следующая ячейка — в начале нового ряда, рядом её не видно: подсказываем кнопку.
  next.classList.toggle('hint', state.rowEnd);
}
