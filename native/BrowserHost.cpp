#include <libretro.h>
#include <emscripten.h>

#include <algorithm>
#include <array>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

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

EM_JS(size_t, WebPostAudio, (const int16_t* data, size_t frames), {
  if (!data || !frames) return Number(frames);
  const sampleCount = Number(frames) * 2;
  const start = Number(data) >> 1;
  const copy = HEAP16.slice(start, start + sampleCount);
  self.postMessage({ type: 'audio', frames: Number(frames), sampleRate: 48000, buffer: copy.buffer }, [copy.buffer]);
  return Number(frames);
});

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
  WebPostLog(web_level, buffer);
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
    return "Software";
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
    *static_cast<retro_hw_context_type*>(data) = RETRO_HW_CONTEXT_NONE;
    return true;
  case RETRO_ENVIRONMENT_SET_HW_RENDER:
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
      WebPostStatus(message->msg);
    return true;
  }
  case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
  {
    const auto* message = static_cast<const retro_message_ext*>(data);
    if (message && message->msg)
      WebPostStatus(message->msg);
    return true;
  }
  default:
    return false;
  }
}

void BrowserVideoRefresh(const void* data, unsigned width, unsigned height, size_t pitch)
{
  if (!data || data == RETRO_HW_FRAME_BUFFER_VALID)
    return;
  WebPostVideo(data, width, height, pitch);
}

void BrowserAudioSample(int16_t left, int16_t right)
{
  const int16_t samples[2] = {left, right};
  WebPostAudio(samples, 1);
}

size_t BrowserAudioBatch(const int16_t* data, size_t frames)
{
  return WebPostAudio(data, frames);
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
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

  retro_system_info info{};
  retro_get_system_info(&info);
  if (info.library_name)
  {
    s_version = info.library_name;
    if (info.library_version)
      s_version += std::string(" ") + info.library_version;
  }

  s_initialized = true;
  WebPostStatus("Dolphin core initialized");
  return 1;
}

EMSCRIPTEN_KEEPALIVE const char* dweb_version()
{
  return s_version.c_str();
}

EMSCRIPTEN_KEEPALIVE int dweb_load_game(const char* path)
{
  if (!s_initialized || !path || !*path)
    return 0;
  if (s_game_loaded)
  {
    retro_unload_game();
    s_game_loaded = false;
  }

  retro_game_info game{};
  game.path = path;
  game.data = nullptr;
  game.size = 0;
  game.meta = nullptr;
  s_game_loaded = retro_load_game(&game);
  return s_game_loaded ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void dweb_run_frame()
{
  if (s_initialized && s_game_loaded)
    retro_run();
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
  if (s_initialized && s_game_loaded)
  {
    retro_unload_game();
    s_game_loaded = false;
  }
}

EMSCRIPTEN_KEEPALIVE void dweb_shutdown()
{
  if (!s_initialized)
    return;
  dweb_unload_game();
  retro_deinit();
  s_initialized = false;
}
}
