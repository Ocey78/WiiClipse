#include <cassert>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "../BrowserHost.cpp"

namespace
{
bool accepted = false;
bool started = false;
bool controllers_ready = false;
bool controller_selected = false;
int starts = 0;
int unloads = 0;
int frames = 0;
std::vector<std::string> logs;

void WebPostStatus(const char*) {}
void WebPostLog(int, const char* text) { logs.emplace_back(text); }
void WebPostVideo(const void*, unsigned, unsigned, size_t) {}
size_t WebPostAudio(const int16_t*, size_t count) { return count; }
}

extern "C"
{
void retro_set_environment(retro_environment_t) {}
void retro_set_video_refresh(retro_video_refresh_t) {}
void retro_set_audio_sample(retro_audio_sample_t) {}
void retro_set_audio_sample_batch(retro_audio_sample_batch_t) {}
void retro_set_input_poll(retro_input_poll_t) {}
void retro_set_input_state(retro_input_state_t) {}
void retro_init() {}
void retro_deinit() {}
void retro_set_controller_port_device(unsigned port, unsigned device)
{
  assert(controllers_ready);
  assert(port == 0 && device == RETRO_DEVICE_JOYPAD);
  controller_selected = true;
}
void retro_get_system_info(retro_system_info* info) { info->library_name = "fixture"; }
bool retro_load_game(const retro_game_info*)
{
  controllers_ready = accepted;
  controller_selected = false;
  return accepted;
}
bool dolphin_browser_start_game()
{
  assert(controller_selected);
  ++starts;
  return started;
}
void retro_unload_game()
{
  ++unloads;
  controllers_ready = false;
  controller_selected = false;
}
void retro_run() { ++frames; }
}

int main()
{
  assert(dweb_init() == 1);
  assert(!controller_selected);
  assert(dweb_load_game("/bad.dol") == 0);
  assert(starts == 0 && unloads == 0);

  accepted = true;
  assert(dweb_load_game("/failed.dol") == 0);
  assert(starts == 1 && unloads == 1);
  dweb_run_frame();
  assert(frames == 0);

  started = true;
  assert(dweb_load_game("/good.dol") == 1);
  assert(starts == 2 && frames == 0);
  dweb_run_frame();
  assert(frames == 1);
  assert(dweb_load_game("/second.dol") == 1);
  assert(starts == 3 && unloads == 2);
  dweb_unload_game();
  assert(unloads == 3);

  dweb_set_axis(4, 0.5f);
  dweb_set_axis(5, 1.0f);
  assert(BrowserInputState(0, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON,
                           RETRO_DEVICE_ID_JOYPAD_L2) == 16383);
  assert(BrowserInputState(0, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON,
                           RETRO_DEVICE_ID_JOYPAD_R2) == 32767);
  dweb_set_axis(4, -1.0f);
  assert(BrowserInputState(0, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON,
                           RETRO_DEVICE_ID_JOYPAD_L2) == 0);
  assert(BrowserInputState(1, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON,
                           RETRO_DEVICE_ID_JOYPAD_R2) == 0);
  assert(BrowserInputState(0, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON,
                           RETRO_DEVICE_ID_JOYPAD_A) == 0);
  dweb_unload_game();
  assert(unloads == 3);

  const auto before = logs.size();
  std::thread background([] { BrowserLog(RETRO_LOG_INFO, "%s", "copied background message"); });
  background.join();
  assert(logs.size() == before);
  dweb_run_frame();
  assert(logs.size() == before + 1 && logs.back() == "copied background message");
  for (int i = 0; i < 1000; ++i)
    BrowserLog(RETRO_LOG_INFO, "bounded message %d", i);
  const auto before_drain = logs.size();
  dweb_run_frame();
  assert(logs.size() - before_drain <= 128);
  assert(logs.back() == "bounded message 999");
  dweb_shutdown();
  std::puts("Browser host contract: startup result, retry, unload, and queued logs passed (stub core).");
}
