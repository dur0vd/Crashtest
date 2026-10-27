import { Capacitor, registerPlugin } from '@capacitor/core';

interface ReportSharePlugin {
  share(options: { html: string }): Promise<void>;
}

const nativeShare = registerPlugin<ReportSharePlugin>('ReportShare');

/** На телефоне файл передаётся штатной панели «Поделиться» через Capacitor. */
export async function shareReport(html: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    await nativeShare.share({ html });
    return true;
  }
  const file = new File([html], 'crashtest-report.html', { type: 'text/html' });
  if (navigator.userActivation?.isActive && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Разбор Crashtest' });
    return true;
  }
  return false;
}
