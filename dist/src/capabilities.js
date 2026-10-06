export function detectCapabilities(env = globalThis) {
  let webgl2 = false;
  try {
    const canvas = env.document?.createElement?.('canvas');
    webgl2 = !!canvas?.getContext?.('webgl2');
  } catch {}
  const nav = env.navigator ?? {};
  return {
    webgl2,
    webgpu: !!nav.gpu,
    gamepad: typeof nav.getGamepads === 'function',
    serviceWorker: !!nav.serviceWorker,
  };
}
