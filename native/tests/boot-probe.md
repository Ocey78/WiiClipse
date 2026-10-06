# Original GameCube boot probe

`boot-probe.mjs` generates a small, original DOL executable. It contains only PowerPC
instructions and a DOL header: no console firmware, SDK, game data, or framebuffer image.
It uses the repository's GPL-2.0-or-later license. No assembler or PowerPC toolchain is needed.

Generate a file with `node native/tests/boot-probe.mjs <output.dol>`, or import
`createBootProbe()` from a Node browser test. Its return value is:

```js
{ bytes, fileName, width, height, samples }
```

`bytes` is a Buffer; `fileName` is `wiiclipse-boot-probe.dol`; the expected frame is
640 × 240. Samples contain `{ x, y, r, g, b }` at the center of red, green, blue,
and white vertical stripes. Allow small RGB conversion differences (for example,
12 per channel). Use the actual native worker's video buffer, including its pitch
and XRGB8888 byte order, for the assertion. A ready signal or successful file selection
alone does not pass this probe.

The PowerPC program fills the complete YUYV framebuffer through uncached address
`0xc0100000`, then configures VI timing and both XFB pointers at `0xcc002000`.
Both fields display the same image. Its final branch loops while emulated VI timing
continues. The expected colors cannot appear without executing the program's stores
and the VI setup instructions.

This deliberately targets Dolphin's direct GameCube executable boot path at the
repository's pinned revision. `CBoot::SetupBAT` supplies cached/uncached RAM and
MMIO mappings; `VideoInterfaceManager::Preset` supplies horizontal timing. The
probe supplies 240 active lines and NTSC 525-half-line vertical timing explicitly.
It does not claim to boot on a physical GameCube without equivalent initial setup.

`tests/boot-probe.test.js` checks the DOL layout, GameCube identification, and known
PPC branch/store encodings. These are structural checks. Real interpreter and video
verification requires loading this DOL in the compiled native browser core and
matching the emitted color samples. The probe does not test audio, WAD launching,
controllers, or compatibility with commercial games.

The shared module also exposes `createWiiBootDol()` for the original
[`wad-boot-probe.mjs`](wad-boot-probe.md) package generator. That variant uses
physical addresses for Wii NAND boot and reverses the stripe order. It must be
tested through its WAD package, not selected as a standalone GameCube DOL.
