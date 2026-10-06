#pragma once

// Host-side unit tests supply the JS-boundary functions, without a WASM runtime.
#define EMSCRIPTEN_KEEPALIVE
#define EM_JS(result, name, arguments, ...) result name arguments
