const SUPPORTED = new Set(['iso', 'gcm', 'dol', 'elf', 'wad']);
export function classifyGameFile(fileName, size = 0) {
  const safe = String(fileName ?? '');
  const ext = safe.includes('.') ? safe.split('.').pop().toLowerCase() : '';
  const supported = SUPPORTED.has(ext);
  return {
    name: safe,
    extension: ext,
    bytes: Number(size) || 0,
    system: !supported ? 'Unknown' : ext === 'wad' ? 'Wii channel (WAD)'
      : ext === 'dol' || ext === 'elf' ? 'GameCube homebrew' : 'GameCube',
    supported,
    reason: supported ? '' : ext === 'rvz'
      ? 'RVZ support will be enabled after the native browser core is validated.'
      : 'This build accepts GameCube ISO/GCM, homebrew DOL/ELF, and bootable Wii WAD files.',
  };
}
