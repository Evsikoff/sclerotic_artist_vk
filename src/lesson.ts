import script from '../voiceover/tutorial/script.json';
import { isCorrect } from './answer';
import { audio, type Voice } from './audio';
import { Board, CELLS, PALETTES, renderThumb } from './board';
import { delayClass, type Delay } from './content';
import { askCell, buildHud, nextCellFrom, showAnswerFeedback, updateToolButtons, type Hud } from './hud';
import { progress } from './progress';
import type { RoundExit } from './round';
import { h, icon, points, seconds, setScreen, signed } from './ui';

/**
 * Нулевой раунд — интерактивное обучение. Пять слов, и никто не торопит: каждый шаг ждёт игрока.
 * Ведущий (голос из обучающего ролика) объясняет правила и все способы ходить по ячейкам,
 * голос раунда диктует слова так же, как в настоящей игре: номер, секунда тишины, слово.
 * Тексты подсказок — в voiceover/tutorial/script.json, озвучка — рядом в MP3 (generate_tutorial.py).
 * Если озвучки нет или она не загрузилась, обучение идёт по тексту.
 */

type LineId = keyof typeof script.lines;

const WORDS: string[] = script.words;
const LINES: Record<LineId, string> = script.lines;
const QUIZ_CELLS = 3;
const NUMBER_PAUSE_MS = 1000;
const QUIZ_FEEDBACK_MS = { ok: 1300, bad: 2600 };
/** Раунды по задержке — для рассказа о ней в конце обучения. */
const DELAY_TIERS: { delay: Delay; rounds: string }[] = [
  { delay: 3, rounds: 'раунды 1–6' },
  { delay: 2, rounds: 'раунды 7–10' },
  { delay: 1, rounds: 'раунды 11–16' },
];

const clip = (path: string) => `${import.meta.env.BASE_URL}voiceover/tutorial/${path}`;
const nn = (cell: number) => String(cell + 1).padStart(2, '0');
const lineUrl = (id: LineId) => clip(`lines/${id}.mp3`);
const numberUrl = (cell: number) => clip(`numbers/${nn(cell)}.mp3`);
const wordUrl = (cell: number) => clip(`words/${nn(cell)}.mp3`);

class Aborted extends Error {}

export function playLesson(): Promise<RoundExit> {
  return new LessonSession().run();
}

class LessonSession {
  private readonly ui: Hud;
  private readonly board: Board;
  private readonly root: HTMLElement;
  private readonly coach: HTMLElement;
  private readonly coachText: HTMLElement;
  private readonly coachButton: HTMLButtonElement;
  private readonly voices = new Set<Voice>();
  private readonly buffers = new Map<string, AudioBuffer | null>();
  /** Условия, которых ждут шаги: проверяются при каждом изменении поля. */
  private readonly watchers = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver;
  private readonly cancelled: Promise<never>;
  private cancel: () => void = () => {};
  private narrator: Voice | null = null;
  private line: LineId | null = null;
  private targets: HTMLElement[] = [];
  private exitDialog: HTMLElement | null = null;
  private raf = 0;
  /** Ячейка, которую диктуют (горит), и ячейка, о которой голос договорил последней. */
  private lit: number | null = null;
  private spoken: number | null = null;
  private quizCell = 0;
  private numberVoice: Voice | null = null;
  private finished = false;

  constructor() {
    this.cancelled = new Promise<never>((_, reject) => (this.cancel = () => reject(new Aborted())));
    this.cancelled.catch(() => {});
    this.ui = buildHud('Раунд 0 · обучение', {
      menu: () => this.confirmExit(),
      done: () => {
        this.finished = true;
        this.poke();
      },
      undo: () => this.board.undo(),
      zoomOut: () => this.board.focus(null),
      spoken: () => this.spoken !== null && this.board.focus(this.spoken),
      next: () => this.board.focus(nextCellFrom(this.board.focused, this.lit, CELLS)),
      repeat: () => this.sayNumber(this.quizCell),
    });
    this.ui.menu.replaceChildren(icon('close'));
    this.ui.menu.setAttribute('aria-label', 'Выйти из обучения');
    this.ui.status.textContent = 'Знакомство';

    this.coachText = h('p', { class: 'coach-text' });
    this.coachButton = h('button', { class: 'btn btn-small coach-btn', hidden: true });
    const replay = h(
      'button',
      { class: 'coach-voice', 'aria-label': 'Повторить подсказку', onclick: () => this.line && void this.say(this.line) },
      icon('speaker'),
    );
    this.coach = h('div', { class: 'coach', hidden: true }, replay, this.coachText, this.coachButton);
    this.ui.top.append(this.coach);

    this.board = new Board(this.ui.canvas, PALETTES[2]);
    this.board.onChange = () => {
      this.updateTools();
      this.poke();
    };
    const { canvas, top, tools, quiz } = this.ui;
    this.root = h('div', { class: 'screen round lesson' }, canvas, top, tools, quiz);
    this.resizeObserver = new ResizeObserver(() => this.syncInsets());
    for (const el of [top, tools, quiz]) this.resizeObserver.observe(el);
  }

  async run(): Promise<RoundExit> {
    setScreen(this.root);
    audio.playMusic('quiet');
    window.addEventListener('keydown', this.onKey);
    this.raf = requestAnimationFrame(this.tick);
    if (import.meta.env.DEV) Object.assign(window, { __lesson: this });
    try {
      await this.intro();
      await this.drawing();
      const correct = await this.quiz();
      await this.aboutDelay();
      return await this.finish(correct);
    } catch (e) {
      if (e instanceof Aborted) return 'menu';
      throw e;
    } finally {
      this.dispose();
    }
  }

  // ——— Шаги ———

  private async intro() {
    const card = h('div', { class: 'ready lesson-card' }, h('span', { class: 'spinner' }), h('p', {}, 'Загружаем голос…'));
    this.root.append(card);
    await this.guard(this.loadVoice());
    const start = h('button', { class: 'btn btn-yellow btn-lg' }, icon('play'), 'Начать');
    card.replaceChildren(
      h('div', { class: 'ready-kicker' }, 'Раунд 0'),
      h('div', { class: 'ready-title' }, 'Обучение'),
      h('p', {}, LINES.welcome),
      start,
    );
    this.line = 'welcome';
    void this.say('welcome');
    await this.guard(new Promise<void>((resolve) => (start.onclick = () => resolve())));
    card.remove();

    this.hint('board');
    await this.button('Дальше');
    this.ui.tools.hidden = false;
    this.board.interactive = true;
    this.updateTools();
  }

  private async drawing() {
    // 1. Коснуться ячейки на общем виде — она приблизится. Нарисовать.
    await this.dictate(0, 'listen');
    await this.moveTo(0, 'tap_cell');
    await this.drawIn(0, 'draw');

    // 2. Стрелка ведёт к следующей ячейке. «Отменить» убирает последнюю линию.
    await this.dictate(1);
    await this.moveTo(1, 'next', [this.ui.next]);
    await this.drawIn(1, 'undo', [this.ui.undo]);

    // 3. Соседние ячейки видны по краям: касание переносит в них.
    await this.dictate(2);
    await this.moveTo(2, 'neighbor');
    await this.drawIn(2, 'draw_more');

    // 4. «Отдалить» показывает всё поле, оттуда — касанием в нужную ячейку.
    if (this.board.focused !== null) {
      this.hint('zoom_out', [this.ui.zoom]);
      await this.until(() => this.board.focused === null);
    }
    await this.dictate(3);
    await this.moveTo(3, 'tap_lit');
    await this.drawIn(3, 'draw_more');
    if (matchMedia('(pointer: fine)').matches) {
      this.hint('keys');
      await this.button('Понятно');
    }

    // 5. Голос не ждёт: кнопка с динамиком возвращает к ячейке, о которой он договорил.
    await this.guard(Promise.all([this.hint('no_wait'), this.wait(1500)]));
    await this.dictate(4);
    await this.moveTo(4, 'speaker', [this.ui.spoken]);
    await this.drawIn(4, 'draw_more');

    // После списка — тридцать секунд и «Готово».
    this.setLit(null);
    this.ui.status.textContent = 'Ещё 30 секунд';
    this.ui.done.hidden = false;
    this.hint('final', [this.ui.done]);
    await this.until(() => this.finished);

    this.setTargets([]);
    this.board.interactive = false;
    this.ui.done.hidden = true;
    this.ui.tools.hidden = true;
    this.coach.hidden = true;
    this.line = null;
  }

  private async quiz(): Promise<number> {
    this.board.focus(null);
    this.ui.status.textContent = 'Проверка памяти';
    this.ui.bar.style.width = '0%';
    const start = h('button', { class: 'btn btn-yellow btn-lg' }, 'Начать');
    const card = h(
      'div',
      { class: 'ready lesson-card alert' },
      h('div', { class: 'ready-title' }, 'Рисунок готов!'),
      h('p', {}, LINES.quiz),
      start,
    );
    this.root.append(card);
    void this.say('quiz');
    await this.guard(new Promise<void>((resolve) => (start.onclick = () => resolve())));
    this.stopNarrator();
    card.remove();

    const cells = shuffle(WORDS.map((_, i) => i)).slice(0, QUIZ_CELLS);
    const explained = new Set<'right' | 'wrong'>();
    let score = 0;
    let correct = 0;
    this.ui.quiz.hidden = false;
    for (const [i, cell] of cells.entries()) {
      this.ui.caption.textContent = `Вопрос ${i + 1} из ${cells.length}`;
      this.ui.status.textContent = `Счёт: ${signed(score)}`;
      this.ui.bar.style.width = `${(i / cells.length) * 100}%`;
      this.quizCell = cell;
      this.board.focus(cell);
      const reply = askCell(this.ui, cell);
      this.sayNumber(cell);
      const answer = await this.guard(reply);
      const ok = answer !== null && isCorrect(answer, WORDS[cell]);
      score += ok ? 1 : -1;
      correct += ok ? 1 : 0;
      audio.sfx(ok ? 'correct' : 'wrong');
      showAnswerFeedback(this.ui, ok, WORDS[cell]);
      this.ui.status.textContent = `Счёт: ${signed(score)}`;
      // Первый верный и первый неверный ответ ведущий поясняет: так становится понятен счёт.
      const kind = ok ? 'right' : 'wrong';
      const shown = this.wait(ok ? QUIZ_FEEDBACK_MS.ok : QUIZ_FEEDBACK_MS.bad);
      const pause = explained.has(kind) ? shown : Promise.all([shown, this.say(kind)]).then(() => {});
      explained.add(kind);
      await this.waitOrTap(pause, this.ui.quiz);
    }
    this.stopNarrator();
    this.ui.bar.style.width = '100%';
    this.ui.input.blur();
    this.ui.quiz.hidden = true;
    return correct;
  }

  private async aboutDelay() {
    const next = h('button', { class: 'btn btn-yellow btn-lg' }, 'Дальше');
    const card = h(
      'div',
      { class: 'ready lesson-card' },
      h('div', { class: 'ready-title' }, 'Задержка'),
      h('p', {}, LINES.delay),
      h(
        'div',
        { class: 'delay-tiers' },
        ...DELAY_TIERS.map((t) =>
          h(
            'div',
            { class: `delay-tier ${delayClass(t.delay)}`, 'aria-label': `Задержка ${seconds(t.delay)}, ${t.rounds}` },
            icon('clock'),
            h('b', {}, `${t.delay} с`),
            h('small', {}, t.rounds),
          ),
        ),
      ),
      next,
    );
    this.root.append(card);
    void this.say('delay');
    await this.guard(new Promise<void>((resolve) => (next.onclick = () => resolve())));
    this.stopNarrator();
    card.remove();
  }

  private finish(correct: number): Promise<RoundExit> {
    progress.markTutorialDone();
    const next = progress.nextRound();
    audio.playMusic();
    void this.say('finish');
    const score = correct - (QUIZ_CELLS - correct);
    return this.guard(
      new Promise<RoundExit>((resolve) => {
        const items = WORDS.map((word, cell) =>
          h(
            'figure',
            { class: 'res-item' },
            h('div', { class: 'res-thumb' }, renderThumb(this.board.strokes[cell], cell + 1, this.board.colors)),
            h('figcaption', {}, h('b', {}, word)),
          ),
        );
        this.root.append(
          h(
            'div',
            { class: 'results lesson-results paper-bg' },
            h('h1', {}, 'Обучение пройдено!'),
            h('p', { class: 'results-summary' }, `Верно ${correct} из ${QUIZ_CELLS}: в игре это было бы ${signed(score)} ${points(score)}.`),
            h('p', { class: 'results-summary' }, 'Рисуйте понятно — и память не подведёт.'),
            h('div', { class: 'results-grid lesson-grid' }, ...items),
            h(
              'div',
              { class: 'results-actions' },
              h('button', { class: next !== null ? 'btn btn-light' : 'btn btn-lg', onclick: () => resolve('menu') }, 'На главную'),
              next !== null && h('button', { class: 'btn btn-lg', onclick: () => resolve(next) }, `Раунд ${next}`, icon('play')),
            ),
          ),
        );
      }),
    );
  }

  // ——— Строительные блоки шагов ———

  /** Голос раунда диктует ячейку: номер, секунда тишины, слово. Ячейка горит, пока не назовут следующую. */
  private async dictate(cell: number, before?: LineId) {
    if (before) {
      await this.guard(Promise.all([this.hint(before), this.wait(700)]));
    } else {
      this.stopNarrator();
      this.showCoach('Слушайте…', true);
    }
    this.setLit(cell);
    await this.guard(this.voice(numberUrl(cell)));
    await this.wait(NUMBER_PAUSE_MS);
    await this.guard(this.voice(wordUrl(cell)));
    // В обучении слово остаётся и надписью: его видно, даже если голос не расслышали или он не загрузился.
    this.ui.status.textContent = `№${cell + 1} — «${WORDS[cell]}»`;
    this.spoken = cell;
    this.updateTools();
    await this.wait(300);
  }

  /** Ждёт, пока игрок придёт в ячейку. Если он ушёл в другую — подсказывает, как вернуться. */
  private async moveTo(cell: number, id: LineId, targets: HTMLElement[] = []) {
    if (this.board.focused === cell) return;
    const start = this.board.focused;
    let shown: LineId = id;
    this.hint(id, targets);
    await this.until(() => {
      const focused = this.board.focused;
      if (focused === cell) return true;
      const wanted: LineId = focused !== null && focused !== start ? 'wrong_cell' : shown === 'wrong_cell' ? 'tap_lit' : shown;
      if (wanted !== shown) {
        shown = wanted;
        this.hint(wanted, wanted === 'wrong_cell' ? [this.ui.zoom] : []);
      }
      return false;
    });
  }

  /** Ждёт рисунка в ячейке и нажатия «Дальше»: кнопка оживает после первой линии. */
  private async drawIn(cell: number, id: LineId, targets: HTMLElement[] = []) {
    this.hint(id, targets);
    await this.button('Дальше', () => this.board.strokes[cell].length > 0);
    this.ui.bar.style.width = `${((cell + 1) / WORDS.length) * 100}%`;
  }

  /** Показывает подсказку и читает её вслух; промис — конец чтения. */
  private hint(id: LineId, targets: HTMLElement[] = []): Promise<void> {
    this.line = id;
    this.showCoach(LINES[id], false);
    this.setTargets(targets);
    return this.say(id);
  }

  private showCoach(text: string, muted: boolean) {
    this.coachButton.hidden = true;
    this.coachButton.onclick = null;
    this.coachText.textContent = text;
    this.coach.classList.toggle('muted', muted);
    this.coach.hidden = false;
    // Новая подсказка заметно «выскакивает», даже если карточка уже была на экране.
    this.coach.classList.remove('pop');
    void this.coach.offsetWidth;
    this.coach.classList.add('pop');
    if (muted) {
      this.line = null;
      this.setTargets([]);
    }
  }

  private button(label: string, enabled: () => boolean = () => true): Promise<void> {
    const btn = this.coachButton;
    btn.textContent = label;
    btn.hidden = false;
    const refresh = () => (btn.disabled = !enabled());
    refresh();
    this.watchers.add(refresh);
    return this.guard(
      new Promise<void>((resolve) => {
        btn.onclick = () => {
          if (!enabled()) return;
          btn.onclick = null;
          btn.hidden = true;
          this.watchers.delete(refresh);
          resolve();
        };
      }),
    );
  }

  /** Ждёт, пока условие выполнится: проверяет его сразу и после каждого действия игрока. */
  private until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return this.guard(
      new Promise<void>((resolve) => {
        const check = () => {
          if (!done()) return;
          this.watchers.delete(check);
          resolve();
        };
        this.watchers.add(check);
      }),
    );
  }

  private poke() {
    for (const watcher of [...this.watchers]) watcher();
  }

  private setTargets(targets: HTMLElement[]) {
    for (const el of this.targets) el.classList.remove('coach-target');
    this.targets = targets;
    for (const el of targets) el.classList.add('coach-target');
  }

  private setLit(cell: number | null) {
    this.lit = cell;
    this.board.highlight = cell;
    if (cell !== null) this.ui.status.textContent = `Ячейка №${cell + 1}`;
    this.updateTools();
  }

  private updateTools() {
    const focused = this.board.focused;
    updateToolButtons(this.ui, {
      canUndo: this.board.canUndo(),
      focused,
      spoken: this.spoken,
      next: nextCellFrom(focused, this.lit, CELLS),
      rowEnd: false,
    });
  }

  private syncInsets() {
    const bottom = Math.max(this.ui.tools.offsetHeight, this.ui.quiz.offsetHeight);
    this.board.setInsets(this.ui.top.offsetHeight, bottom);
  }

  // ——— Звук ———

  private loadVoice(): Promise<void> {
    const urls = [
      ...(Object.keys(LINES) as LineId[]).map(lineUrl),
      ...WORDS.flatMap((_, cell) => [numberUrl(cell), wordUrl(cell)]),
    ];
    // Озвучки может не быть: тогда обучение идёт по тексту. Ждём не дольше 10 секунд.
    const all = Promise.all(
      urls.map((url) =>
        audio.load(url).then(
          (buffer) => void this.buffers.set(url, buffer),
          () => void this.buffers.set(url, null),
        ),
      ),
    ).then(() => {});
    return Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, 10000))]);
  }

  private voice(url: string): Promise<void> {
    const buffer = this.buffers.get(url);
    if (!buffer) return this.wait(600);
    const voice = audio.play(buffer);
    this.voices.add(voice);
    void voice.ended.then(() => this.voices.delete(voice));
    return voice.ended;
  }

  /** Ведущий читает подсказку; прежняя подсказка обрывается. */
  private say(id: LineId): Promise<void> {
    this.stopNarrator();
    const buffer = this.buffers.get(lineUrl(id));
    if (!buffer) return Promise.resolve();
    const voice = audio.play(buffer);
    this.narrator = voice;
    this.voices.add(voice);
    void voice.ended.then(() => this.voices.delete(voice));
    return voice.ended;
  }

  private stopNarrator() {
    this.narrator?.stop();
    this.narrator = null;
  }

  private sayNumber(cell: number) {
    this.numberVoice?.stop();
    const buffer = this.buffers.get(numberUrl(cell));
    if (!buffer) return;
    this.numberVoice = audio.play(buffer);
    this.voices.add(this.numberVoice);
  }

  // ——— Кадр, ввод, выход ———

  private tick = (t: number) => {
    this.raf = requestAnimationFrame(this.tick);
    this.board.render(t);
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.exitDialog || !this.board.interactive) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) this.board.step(...moves[e.key]);
    else if (e.key === 'Escape') this.board.focus(null);
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') this.board.undo();
    else return;
    e.preventDefault();
  };

  private confirmExit() {
    if (this.exitDialog) return;
    const close = () => {
      this.exitDialog?.remove();
      this.exitDialog = null;
    };
    this.exitDialog = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'dialog' },
        h('h2', {}, 'Выйти?'),
        h('p', {}, 'Обучение можно пройти позже: кнопка «Обучение» на главном экране.'),
        h('button', { class: 'btn', onclick: close }, 'Продолжить обучение'),
        h('button', { class: 'btn btn-light', onclick: () => this.cancel() }, 'Выйти в меню'),
      ),
    );
    this.root.append(this.exitDialog);
  }

  private guard<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.cancelled]);
  }

  private wait(ms: number): Promise<void> {
    return this.guard(new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Ждёт паузу, но касание элемента (или Enter в поле ответа) её пропускает. */
  private waitOrTap(pause: Promise<void>, el: HTMLElement): Promise<void> {
    const events = ['pointerdown', 'submit'];
    let finish = () => {};
    const tapped = new Promise<void>((resolve) => (finish = resolve));
    // Слушаем не сразу: нажатие, которое сюда привело, ещё может всплывать.
    const arm = setTimeout(() => events.forEach((type) => el.addEventListener(type, finish)), 200);
    return this.guard(Promise.race([pause, tapped])).finally(() => {
      clearTimeout(arm);
      for (const type of events) el.removeEventListener(type, finish);
    });
  }

  private dispose() {
    cancelAnimationFrame(this.raf);
    for (const voice of this.voices) voice.stop();
    this.watchers.clear();
    window.removeEventListener('keydown', this.onKey);
    this.resizeObserver.disconnect();
    this.board.destroy();
    if (import.meta.env.DEV) Object.assign(window, { __lesson: undefined });
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
