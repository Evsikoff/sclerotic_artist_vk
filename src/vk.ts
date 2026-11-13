import bridge from '@vkontakte/vk-bridge';

/**
 * Игра открыта внутри ВКонтакте: в iframe или WebView, с параметрами запуска VK в адресе.
 * Вне VK запросы bridge остаются без ответа, поэтому там их не отправляем вовсе.
 */
export const inVK = bridge.isEmbedded() && new URLSearchParams(location.search).has('vk_app_id');

let ready: Promise<boolean> = Promise.resolve(false);

/**
 * Сообщает VK, что игра загрузилась: клиент убирает заставку и разрешает остальные методы.
 * Вызывается один раз при запуске, как можно раньше.
 */
export function initVK(): Promise<boolean> {
  if (inVK) {
    ready = bridge.send('VKWebAppInit').then(
      () => true,
      (error) => {
        console.warn('VKWebAppInit не прошёл', error);
        return false;
      },
    );
  }
  return ready;
}

/** Завершился ли VKWebAppInit успешно. Вне VK сразу false. */
export const vkReady = () => ready;

export { bridge };
