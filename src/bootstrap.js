async function prepareHosting() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  const reloadKey = `wiiclipse-isolation:${location.pathname}`;
  try {
    let installTimer;
    try {
      await Promise.race([
        (async () => {
          await navigator.serviceWorker.register(new URL('./sw.js', location.href), { updateViaCache: 'none' });
          await navigator.serviceWorker.ready;
        })(),
        new Promise((_, reject) => {
          installTimer = setTimeout(() => reject(new Error('Offline setup timed out')), 10000);
        }),
      ]);
    } finally { clearTimeout(installTimer); }
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          reject(new Error('Service worker activation timed out'));
        }, 10000);
        function changed() {
          if (!navigator.serviceWorker.controller) return;
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          resolve();
        }
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        changed();
      });
    }
    if (!window.crossOriginIsolated && !sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, '1');
      location.reload();
      return true;
    }
    if (window.crossOriginIsolated) sessionStorage.removeItem(reloadKey);
  } catch (error) {
    console.warn('Offline setup unavailable:', error.message);
  }
  return false;
}

if (!await prepareHosting()) {
  await import('./app.js');
}
