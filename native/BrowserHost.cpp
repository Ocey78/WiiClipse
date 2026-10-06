#include <libretro.h>
#include <emscripten.h>
#ifdef __EMSCRIPTEN__
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#endif

#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>

extern "C" bool dolphin_browser_start_game();
namespace Libretro
{
extern double g_core_refresh_rate;
namespace Audio { unsigned int GetActiveSampleRate(); }
}

namespace
{
constexpr const char* kSystemDirectory = "/dolphin/system";
constexpr const char* kSaveDirectory = "/dolphin/save";
constexpr const char* kAssetsDirectory = "/dolphin/assets";

std::array<int16_t, 32> s_buttons{};
std::array<float, 8> s_axes{};
bool s_initialized = false;
bool s_game_loaded = false;
std::string s_version = "dolphin-web";
constexpr size_t kAudioBatchFrames = 2048;
std::array<int16_t, kAudioBatchFrames * 2> s_audio_samples{};
size_t s_audio_frames = 0;
unsigned s_audio_rate = 0;
retro_hw_render_callback s_hw_render{};
int s_graphics_context = 0;

#ifdef __EMSCRIPTEN__
EM_JS(int, WebRegisterGraphicsCanvas, (), {
  if (Module['dwebRenderer'] === 'software' || typeof OffscreenCanvas === 'undefined') return 0;
  // Allocate once before backend initialization. Dolphin's native 1x output
  // occupies the lower-left 640 by 480/528/576 extent of this canvas.
  specialHTMLTargets['!dolphin'] = new OffscreenCanvas(640, 576);
  return 1;
});

EM_JS(void, WebReleaseGraphicsCanvas, (), {
  delete specialHTMLTargets['!dolphin'];
});
#endif

EM_JS(void, WebPostHardwareVideo, (unsigned width, unsigned height), {
  const gl = GL.currentContext && GL.currentContext.GLctx;
  if (!gl || !width || !height || width > 640 || height > 576) return;
  if (Module['dwebVideo'] !== 'pixels' && typeof gl.canvas?.transferToImageBitmap === 'function') {
    // Transfer the GPU image directly. Reading it back into WASM/JS and then
    // uploading it again stalls Firefox's graphics pipeline every frame.
    const bitmap = gl.canvas.transferToImageBitmap();
    self.postMessage({ type: 'video', bitmap, width, height,
      sourceHeight: gl.canvas.height, pixelFormat: 'RGBA8888' }, [bitmap]);
    return;
  }
  // Dolphin owns GL state: save and restore every binding/pixel-store value
  // touched by the host's presentation readback.
  const framebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const packBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const alignment = gl.getParameter(gl.PACK_ALIGNMENT);
  const rowLength = gl.getParameter(gl.PACK_ROW_LENGTH);
  const skipRows = gl.getParameter(gl.PACK_SKIP_ROWS);
  const skipPixels = gl.getParameter(gl.PACK_SKIP_PIXELS);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
  gl.pixelStorei(gl.PACK_ALIGNMENT, alignment);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, rowLength);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, skipRows);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, skipPixels);
  const rowBytes = width * 4;
  const row = new Uint8Array(rowBytes);
  for (let y = 0; y < (height >> 1); ++y) {
    const top = y * rowBytes;
    const bottom = (height - 1 - y) * rowBytes;
    row.set(pixels.subarray(top, top + rowBytes));
    pixels.copyWithin(top, bottom, bottom + rowBytes);
    pixels.set(row, bottom);
  }
  self.postMessage({ type: 'video', width, height, pitch: rowBytes,
    pixelFormat: 'RGBA8888', buffer: pixels.buffer }, [pixels.buffer]);
});

void DestroyGraphicsContext()
{
#ifdef __EMSCRIPTEN__
  if (s_graphics_context)
  {
    if (s_hw_render.context_destroy)
      s_hw_render.context_destroy();
    emscripten_webgl_destroy_context(s_graphics_context);
    WebReleaseGraphicsCanvas();
  }
#endif
  s_graphics_context = 0;
  s_hw_render = {};
}

bool SetHardwareRender(retro_hw_render_callback* callback)
{
#ifdef __EMSCRIPTEN__
  if (!callback || s_graphics_context ||
      (callback->context_type != RETRO_HW_CONTEXT_OPENGLES3 &&
       !(callback->context_type == RETRO_HW_CONTEXT_OPENGLES_VERSION &&
         callback->version_major == 3 && callback->version_minor == 0)))
    return false;
  if (!WebRegisterGraphicsCanvas())
    return false;
  EmscriptenWebGLContextAttributes attributes;
  emscripten_webgl_init_context_attributes(&attributes);
  attributes.majorVersion = 2;
  attributes.minorVersion = 0;
  attributes.alpha = false;
  attributes.depth = callback->depth;
  attributes.stencil = callback->stencil;
  attributes.antialias = false;
  attributes.preserveDrawingBuffer = true;
  attributes.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
  attributes.proxyContextToMainThread = EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW;
  s_graphics_context = emscripten_webgl_create_context("!dolphin", &attributes);
  if (!s_graphics_context ||
      emscripten_webgl_make_context_current(s_graphics_context) != EMSCRIPTEN_RESULT_SUCCESS ||
      !emscripten_webgl_enable_extension(s_graphics_context, "EXT_color_buffer_float"))
  {
    DestroyGraphicsContext();
    WebReleaseGraphicsCanvas();
    return false;
  }
  callback->get_current_framebuffer = []() -> uintptr_t { return 0; };
  callback->get_proc_address = [](const char* name) -> retro_proc_address_t {
    return reinterpret_cast<retro_proc_address_t>(emscripten_webgl_get_proc_address(name));
  };
  s_hw_render = *callback;
  return true;
#else
  return false;
#endif
}

EM_JS(void, WebPostStatus, (const char* text), {
  self.postMessage({ type: 'status', message: UTF8ToString(text) });
});

EM_JS(void, WebPostLog, (int level, const char* text), {
  const levels = ['debug', 'info', 'warn', 'error'];
  self.postMessage({ type: 'log', level: levels[level] || 'info', message: UTF8ToString(text) });
});

EM_JS(void, WebPostVideo, (const void* data, unsigned width, unsigned height, size_t pitch), {
  if (!data || !width || !height || data === 0xffffffff) return;
  const byteLength = Number(pitch) * Number(height);
  const copy = HEAPU8.slice(Number(data), Number(data) + byteLength);
  self.postMessage({ type: 'video', width, height, pitch: Number(pitch), buffer: copy.buffer }, [copy.buffer]);
});

EM_JS(void, WebPostRGBA, (const void* data, unsigned width, unsigned height, size_t pitch), {
  if (!data || !width || !height || Number(pitch) < Number(width) * 4) return;
  const rowBytes = Number(width) * 4;
  let copy;
  if (Number(pitch) === rowBytes) {
    copy = HEAPU8.slice(Number(data), Number(data) + rowBytes * Number(height));
  } else {
    copy = new Uint8Array(rowBytes * Number(height));
    for (let y = 0; y < Number(height); ++y) {
      const row = Number(data) + y * Number(pitch);
      copy.set(HEAPU8.subarray(row, row + rowBytes), y * rowBytes);
    }
  }
  self.postMessage({ type: 'video', width, height, pitch: rowBytes,
    pixelFormat: 'RGBA8888', buffer: copy.buffer }, [copy.buffer]);
});

EM_JS(size_t, WebPostAudio, (const int16_t* data, size_t frames, unsigned sample_rate), {
  if (!data || !frames) return Number(frames);
  const sampleCount = Number(frames) * 2;
  const start = Number(data) >> 1;
  const copy = HEAP16.slice(start, start + sampleCount);
  self.postMessage({ type: 'audio', frames: Number(frames), sampleRate: Number(sample_rate), buffer: copy.buffer }, [copy.buffer]);
  return Number(frames);
});

struct PendingWebMessage
{
  bool status;
  int level;
  std::string text;
};
std::mutex s_message_mutex;
std::deque<PendingWebMessage> s_messages;

void QueueWebMessage(bool status, int level, const char* text)
{
  // Native helper threads have their own Emscripten worker message protocol.
  // Copy their messages and emit them only from the main runtime worker.
  std::lock_guard<std::mutex> lock(s_message_mutex);
  if (s_messages.size() == 128)
    s_messages.pop_front();
  s_messages.push_back({status, level, text ? text : ""});
}

void DrainWebMessages()
{
  std::deque<PendingWebMessage> messages;
  {
    std::lock_guard<std::mutex> lock(s_message_mutex);
    messages.swap(s_messages);
  }
  for (const auto& message : messages)
  {
    if (message.status)
      WebPostStatus(message.text.c_str());
    else
      WebPostLog(message.level, message.text.c_str());
  }
}

void BrowserLog(enum retro_log_level level, const char* format, ...)
{
  char buffer[4096]{};
  va_list args;
  va_start(args, format);
  std::vsnprintf(buffer, sizeof(buffer), format, args);
  va_end(args);

  int web_level = 1;
  if (level == RETRO_LOG_DEBUG)
    web_level = 0;
  else if (level == RETRO_LOG_WARN)
    web_level = 2;
  else if (level == RETRO_LOG_ERROR)
    web_level = 3;
  QueueWebMessage(false, web_level, buffer);
}

const char* GetBrowserOption(const char* key)
{
  if (!key)
    return nullptr;

  // No executable-memory/JIT assumptions in Safari. Generic Dolphin maps 5 to Cached Interpreter.
  if (std::strcmp(key, "dolphin_cpu_core") == 0)
    return "5";
  if (std::strcmp(key, "dolphin_main_cpu_thread") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_fastmem") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_fastmem_arena") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_dsp_jit") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_dsp_hle") == 0)
    return "enabled";
  if (std::strcmp(key, "dolphin_renderer") == 0)
    return "Hardware";
  if (std::strcmp(key, "dolphin_main_load_game_into_memory") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_precision_frame_timing") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_emulation_speed") == 0)
    return "1.0";
  if (std::strcmp(key, "dolphin_cpu_clock_rate") == 0)
    return "1.00";
  if (std::strcmp(key, "dolphin_efb_scale") == 0)
    return "1";
  if (std::strcmp(key, "dolphin_shader_compilation_mode") == 0)
    return "0";
  if (std::strcmp(key, "dolphin_wait_for_shaders") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_libretro_vfs") == 0)
    return "disabled";
  if (std::strcmp(key, "dolphin_osd_enabled") == 0)
    return "enabled";
  if (std::strcmp(key, "dolphin_log_level") == 0)
    return "2";
  return nullptr;
}

bool BrowserEnvironment(unsigned command, void* data)
{
  switch (command)
  {
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    *static_cast<const char**>(data) = kSystemDirectory;
    return true;
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
    *static_cast<const char**>(data) = kSaveDirectory;
    return true;
  case RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY:
    *static_cast<const char**>(data) = kAssetsDirectory;
    return true;
  case RETRO_ENVIRONMENT_GET_VARIABLE:
  {
    auto* variable = static_cast<retro_variable*>(data);
    variable->value = GetBrowserOption(variable->key);
    return variable->value != nullptr;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
    *static_cast<bool*>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
    return *static_cast<retro_pixel_format*>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
  case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
    *static_cast<unsigned*>(data) = 2;
    return true;
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
  case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
  case RETRO_ENVIRONMENT_SET_VARIABLES:
    return true;
  case RETRO_ENVIRONMENT_GET_LANGUAGE:
    *static_cast<unsigned*>(data) = RETRO_LANGUAGE_ENGLISH;
    return true;
  case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
    *static_cast<unsigned*>(data) = 1;
    return true;
  case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
    static_cast<retro_log_callback*>(data)->log = BrowserLog;
    return true;
  case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
    return true;
  case RETRO_ENVIRONMENT_GET_CAN_DUPE:
    *static_cast<bool*>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_GET_INPUT_MAX_USERS:
    *static_cast<unsigned*>(data) = 1;
    return true;
  case RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE:
    *static_cast<float*>(data) = 60.0f;
    return true;
  case RETRO_ENVIRONMENT_GET_JIT_CAPABLE:
    *static_cast<bool*>(data) = false;
    return true;
  case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
    *static_cast<retro_hw_context_type*>(data) = RETRO_HW_CONTEXT_OPENGLES3;
    return true;
  case RETRO_ENVIRONMENT_SET_HW_RENDER:
    return SetHardwareRender(static_cast<retro_hw_render_callback*>(data));
  case RETRO_ENVIRONMENT_SET_HW_SHARED_CONTEXT:
    return false;
  case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
  case RETRO_ENVIRONMENT_SET_GEOMETRY:
  case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
  case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
  case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
  case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
  case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
  case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    return true;
  case RETRO_ENVIRONMENT_SET_MESSAGE:
  {
    const auto* message = static_cast<const retro_message*>(data);
    if (message && message->msg)
      QueueWebMessage(true, 1, message->msg);
    return true;
  }
  case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
  {
    const auto* message = static_cast<const retro_message_ext*>(data);
    if (message && message->msg)
      QueueWebMessage(true, 1, message->msg);
    return true;
  }
  default:
    return false;
  }
}

void BrowserVideoRefresh(const void* data, unsigned width, unsigned height, size_t pitch)
{
  if (!data)
    return;
  if (data == RETRO_HW_FRAME_BUFFER_VALID)
  {
    if (s_graphics_context)
      WebPostHardwareVideo(width, height);
    return;
  }
  WebPostVideo(data, width, height, pitch);
}

void FlushAudio()
{
  if (s_audio_frames)
    WebPostAudio(s_audio_samples.data(), s_audio_frames, s_audio_rate);
  s_audio_frames = 0;
}

size_t BrowserAudioBatch(const int16_t* data, size_t frames)
{
  const unsigned rate = Libretro::Audio::GetActiveSampleRate();
  if (s_audio_frames && rate != s_audio_rate)
    FlushAudio();
  s_audio_rate = rate;
  size_t remaining = frames;
  while (remaining)
  {
    const size_t count = std::min(remaining, kAudioBatchFrames - s_audio_frames);
    std::copy_n(data, count * 2, s_audio_samples.data() + s_audio_frames * 2);
    data += count * 2;
    remaining -= count;
    s_audio_frames += count;
    if (s_audio_frames == kAudioBatchFrames)
      FlushAudio();
  }
  return frames;
}

void BrowserAudioSample(int16_t left, int16_t right)
{
  const int16_t samples[2] = {left, right};
  BrowserAudioBatch(samples, 1);
}

void BrowserInputPoll()
{
}

int16_t AxisToRetro(float value)
{
  value = std::clamp(value, -1.0f, 1.0f);
  return static_cast<int16_t>(value < 0.0f ? value * 32768.0f : value * 32767.0f);
}

int16_t BrowserInputState(unsigned port, unsigned device, unsigned index, unsigned id)
{
  if (port != 0)
    return 0;

  if (device == RETRO_DEVICE_JOYPAD)
  {
    if (id == RETRO_DEVICE_ID_JOYPAD_L2 && s_axes[4] > 0.0f)
      return AxisToRetro(s_axes[4]);
    if (id == RETRO_DEVICE_ID_JOYPAD_R2 && s_axes[5] > 0.0f)
      return AxisToRetro(s_axes[5]);
    return id < s_buttons.size() ? s_buttons[id] : 0;
  }

  if (device == RETRO_DEVICE_ANALOG)
  {
    if (index == RETRO_DEVICE_INDEX_ANALOG_BUTTON)
    {
      if (id == RETRO_DEVICE_ID_JOYPAD_L2)
        return AxisToRetro(std::max(0.0f, s_axes[4]));
      if (id == RETRO_DEVICE_ID_JOYPAD_R2)
        return AxisToRetro(std::max(0.0f, s_axes[5]));
      return 0;
    }
    if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT)
      return id == RETRO_DEVICE_ID_ANALOG_X ? AxisToRetro(s_axes[0]) : AxisToRetro(s_axes[1]);
    if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT)
      return id == RETRO_DEVICE_ID_ANALOG_X ? AxisToRetro(s_axes[2]) : AxisToRetro(s_axes[3]);
  }

  return 0;
}
}  // namespace

extern "C"
{
void dolphin_browser_present_rgba(const void* data, unsigned width, unsigned height, size_t pitch)
{
  WebPostRGBA(data, width, height, pitch);
}

EMSCRIPTEN_KEEPALIVE int dweb_init()
{
  if (s_initialized)
    return 1;

  retro_set_environment(BrowserEnvironment);
  retro_set_video_refresh(BrowserVideoRefresh);
  retro_set_audio_sample(BrowserAudioSample);
  retro_set_audio_sample_batch(BrowserAudioBatch);
  retro_set_input_poll(BrowserInputPoll);
  retro_set_input_state(BrowserInputState);
  retro_init();

  retro_system_info info{};
  retro_get_system_info(&info);
  if (info.library_name)
  {
    s_version = info.library_name;
    if (info.library_version)
      s_version += std::string(" ") + info.library_version;
  }

  s_initialized = true;
  QueueWebMessage(true, 1, "Dolphin core initialized");
  DrainWebMessages();
  return 1;
}

EMSCRIPTEN_KEEPALIVE const char* dweb_version()
{
  return s_version.c_str();
}

EMSCRIPTEN_KEEPALIVE double dweb_get_frame_rate()
{
  return Libretro::g_core_refresh_rate > 1.0 ? Libretro::g_core_refresh_rate : 60.0;
}

EMSCRIPTEN_KEEPALIVE int dweb_load_game(const char* path)
{
  if (!s_initialized || !path || !*path)
    return 0;
  s_audio_frames = 0;
  if (s_game_loaded)
  {
    retro_unload_game();
    s_game_loaded = false;
    DestroyGraphicsContext();
  }

  retro_game_info game{};
  game.path = path;
  game.data = nullptr;
  game.size = 0;
  game.meta = nullptr;
  if (!retro_load_game(&game))
  {
    DestroyGraphicsContext();
    DrainWebMessages();
    return 0;
  }
  // Dolphin creates the controller objects during retro_load_game, not retro_init.
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  if (s_graphics_context && s_hw_render.context_reset)
    s_hw_render.context_reset();
  // retro_load_game only schedules initialization. Complete it without running
  // a guest frame before acknowledging the browser's boot request.
  if (!dolphin_browser_start_game())
  {
    retro_unload_game();
    DestroyGraphicsContext();
    DrainWebMessages();
    return 0;
  }
  s_game_loaded = true;
  DrainWebMessages();
  return 1;
}

EMSCRIPTEN_KEEPALIVE void dweb_run_frame()
{
  if (s_initialized && s_game_loaded)
    retro_run();
  FlushAudio();
  DrainWebMessages();
}

EMSCRIPTEN_KEEPALIVE void dweb_set_button(int id, int pressed)
{
  if (id >= 0 && static_cast<size_t>(id) < s_buttons.size())
    s_buttons[static_cast<size_t>(id)] = pressed ? 32767 : 0;
}

EMSCRIPTEN_KEEPALIVE void dweb_set_axis(int id, float value)
{
  if (id >= 0 && static_cast<size_t>(id) < s_axes.size())
    s_axes[static_cast<size_t>(id)] = std::clamp(value, -1.0f, 1.0f);
}

EMSCRIPTEN_KEEPALIVE void dweb_unload_game()
{
  s_audio_frames = 0;
  if (s_initialized && s_game_loaded)
  {
    retro_unload_game();
    s_game_loaded = false;
  }
  DestroyGraphicsContext();
  DrainWebMessages();
}

EMSCRIPTEN_KEEPALIVE void dweb_shutdown()
{
  if (!s_initialized)
    return;
  dweb_unload_game();
  retro_deinit();
  s_initialized = false;
  DrainWebMessages();
}
}
