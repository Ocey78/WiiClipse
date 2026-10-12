# WiiClipse balanced overhaul

The user requested substantial improvements to the emulator and publication on the GitHub site for Ocey78/WiiClipse, and selected a balanced overhaul of usability, reliability, and performance.

Deliver the user's requested simple interface: plain WiiClipse heading, file picker, player, and essential controls, with no slogans, sidebar, or promotional copy. Keep help and browser details collapsed, and hide touch controls by default for mouse users. Provide local file drop/picker, clear readiness/error states, real performance statistics, accessible keyboard help, and complete GameCube touch controls. Keep the existing native core and compatibility claims grounded in actual boot probes. Game files stay local.

Add keyboard input and combine independent input sources without stuck buttons or gamepad drift. Release input when focus is lost and choose connected gamepads even when slot zero is empty. Preserve the one-frame-in-flight scheduler.

Make pause/resume, stop, volume/mute, and save synchronization visible and dependable. Manual pause must survive hiding/showing the page. Serialize filesystem lifecycle operations and surface persistence errors. Preserve supported file formats and the pinned, checksum-verified native release.

Verify with unit regressions, browser interaction checks, and the real native DOL/WAD boot probes. Publish through the repository's GitHub Pages workflow and verify deployment. Do not claim commercial-game compatibility or an emulation speedup without measurements.

The local preview must serve the same built artifact as GitHub Pages, so relative stylesheet, script, manifest, service-worker, and native-core URLs resolve correctly at the site root. Test this server independently as well as the deployed project path.
