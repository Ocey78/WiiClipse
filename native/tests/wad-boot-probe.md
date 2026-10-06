# Original Wii WAD boot probe

`wad-boot-probe.mjs` generates a deterministic 1,920-byte test channel containing
one original PowerPC DOL. There is no firmware, SDK, commercial title, copied ticket,
certificate chain, or banner. The generator and program use GPL-2.0-or-later.

Generate it with:

```bash
node native/tests/wad-boot-probe.mjs <output.wad>
```

Or import `createWadBootProbe()` in a Node browser test. It returns:

```js
{ bytes, fileName, titleId, width, height, samples }
```

`bytes` is a Buffer, `fileName` is `wiiclipse-wad-boot-probe.wad`, and the synthetic
channel title ID is `0001000157435045` (`WCPE`). The expected video is 640 × 240 with
white, blue, green, and red stripes. Each sample is `{ x, y, r, g, b }` at a stripe's
center. This order differs from the GameCube probe so its earlier video cannot
satisfy the WAD assertion. Compare the actual worker video buffer using its reported
pitch and XRGB8888 byte order, allowing the same conversion tolerance as the DOL test.

The payload deliberately targets the pinned Dolphin HLE NAND-title boot path.
`createWiiBootDol()` shares the original framebuffer-writing code in `boot-probe.mjs`
but uses text address `0x3400`, XFB address `0x00100000`, and VI address `0x0c002000`.
These are physical addresses: `IOS.cpp::ReleasePPC` starts NAND titles at `0x3400`
with address translation disabled. This payload does not rely on the direct
GameCube DOL bootstrap's BAT mappings. `CBoot::BootUp` presets VI horizontal timing;
the program writes the complete framebuffer, vertical timing, stride, display mode,
and both XFB pointers itself before looping.

The package has a 32-byte WAD header, a 676-byte version-0 ticket, a 520-byte TMD,
and one encrypted content, with each section aligned to 64 bytes. Its TMD requests
IOS36, which Dolphin implements in HLE; no IOS binary is included. The title key is
an original fixed test value. AES-128-CBC encrypts the title key with the retail
common-key constant already in pinned Dolphin `Core/IOS/IOSC.cpp`; the IV is the
big-endian title ID followed by eight zero bytes. Content encryption uses the
two-byte content index followed by fourteen zeros, no PKCS#7 padding, and zero
padding to 64 bytes. The TMD's SHA-1 covers only the unpadded DOL.

The ticket and TMD have descriptive synthetic issuers and zero signatures. This
exercises Dolphin's existing `WiiUtils::InstallWAD(... VerifySignature::No)` path;
the generator does not modify the core or disable any additional checks. Dolphin
still verifies the decrypted content hash. This unsigned package is an emulator
test fixture, not a claim of official signing or physical-console compatibility.

Relevant source at pinned commit `f8603f14e7f5a090e6693857d625a55ea9330534`:

- `Source/Core/DiscIO/Volume.cpp` and `VolumeWad.cpp`: WAD magic, section alignment, content decryption/hash.
- `Source/Core/Core/IOS/ES/Formats.h` and `Formats.cpp`: ticket/TMD layouts and title-key decryption.
- `Source/Core/Core/WiiUtils.cpp`: temporary WAD import with signature verification disabled.
- `Source/Core/Core/Boot/Boot_WiiWAD.cpp`: install and launch the NAND title.
- `Source/Core/Core/IOS/IOS.cpp`: HLE bootstrap and physical PPC entry at `0x3400`.

`tests/wad-boot-probe.test.js` independently parses the package, decrypts its title
key/content, checks SHA-1 and padding, and verifies physical-address PPC instructions.
Those checks establish package structure only. Actual WAD boot requires installing
this fixture into a fresh test browser's emulated NAND, starting it in the compiled
core, and matching its video samples. A selected filename, ready state, or successful
DOL boot is insufficient. This test does not establish broader WAD compatibility,
audio, controller input, or successful execution until that browser check passes.
