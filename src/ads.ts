import { bridge, vkReady } from './vk';

/** Просит VK заранее загрузить межстраничную рекламу, чтобы при переигровке она открылась сразу. */
export async function preloadInterstitial(): Promise<void> {
  if (!(await vkReady())) return;
  await bridge.send('VKWebAppCheckNativeAds', { ad_format: 'interstitial' }).catch(() => {});
}

/**
 * Межстраничная (interstitial) реклама VK перед переигровкой раунда.
 * Промис завершается, когда игрок закрыл рекламу или VK не смог её показать:
 * нет подходящей рекламы, лимит показов, игра открыта не во ВКонтакте. Игра продолжается в любом случае.
 */
export async function showFullscreenAd(): Promise<void> {
  if (!(await vkReady())) return;
  try {
    await bridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' });
  } catch (error) {
    console.info('Межстраничная реклама VK не показана', error);
  }
  void preloadInterstitial();
}
