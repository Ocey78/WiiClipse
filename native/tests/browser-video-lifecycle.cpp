// Run actual extracted lifecycle code with observable video and FIFO fixtures.
#include <cstdio>
#include <cstdlib>
#include "DolphinLibretro/VideoContexts/ContextStatus.h"

ContextStatus g_context_status;
struct WindowSystemInfo {};
struct VideoBackend
{
  bool succeeds = true;
  bool resources_live = false;
  unsigned initializations = 0;
  unsigned shutdowns = 0;
  bool Initialize(const WindowSystemInfo&)
  {
    ++initializations;
    if (resources_live) std::abort();
    resources_live = succeeds;
    return succeeds;
  }
  void Shutdown()
  {
    if (!resources_live) std::abort();
    resources_live = false;
    ++shutdowns;
  }
};
VideoBackend backend;
VideoBackend* g_video_backend = &backend;
namespace Core
{
struct Fifo
{
  unsigned shutdowns = 0;
  void Shutdown() { ++shutdowns; }
};
class System
{
public:
  static System& GetInstance() { static System system; return system; }
  bool IsDualCoreMode() const { return false; }
  Fifo& GetFifo() { return fifo; }
  Fifo fifo;
};
bool IsRunning(System&) { return true; }
void Stop(System&) {}
void Shutdown(System&) {}
void SingleCorePostRunShutdown() {}
void UndeclareAsCPUThread() {}
void UndeclareAsGPUThread() {}
}
namespace Libretro
{
bool g_emuthread_launched = true;
namespace Input { void Shutdown() {} }
namespace Log { void Shutdown() {} }
}
namespace UICommon
{
void ShutdownControllers() {}
void Shutdown() {}
}
namespace Common { void SetCurrentThreadName(const char*) {} }
void DeclareAsGPUThread() {}
class AsyncRequests
{
public:
  static AsyncRequests* GetInstance() { static AsyncRequests requests; return &requests; }
  void SetPassthrough(bool enabled) { if (!enabled) std::abort(); }
};

#include "video-lifecycle-reference.h"

void Check(bool condition, const char* message)
{
  if (!condition) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}

int main()
{
  auto& system = Core::System::GetInstance();
  const WindowSystemInfo wsi;
  for (unsigned title = 0; title < 3; ++title)
  {
    g_context_status.MarkReset();
    Check(InitializeVideo(system, wsi), "Successful backend initialization was rejected");
    Check(g_context_status.IsInitialized(), "Successful browser video setup was never marked initialized");
    retro_unload_game();
    Check(!backend.resources_live, "Native graphics resources survived title unload");
    Check(backend.shutdowns == title + 1, "Backend shutdown did not happen once per loaded title");
    Check(system.fifo.shutdowns == title + 1, "FIFO shutdown did not happen once per loaded title");
    Check(!g_context_status.IsInitialized(), "Unload did not clear the initialization marker");
    Check(!Libretro::g_emuthread_launched, "Unload did not reset the emulation thread flag");
  }
  backend.succeeds = false;
  g_context_status.MarkReset();
  Check(!InitializeVideo(system, wsi), "Failed backend initialization was accepted");
  Check(!g_context_status.IsInitialized(), "Failed backend initialization was marked initialized");
  retro_unload_game();
  Check(backend.shutdowns == 3 && system.fifo.shutdowns == 3,
        "Early initialization failure triggered teardown of uninitialized resources");
  std::puts("Video lifecycle: three successful title unloads and early-init failure passed");
}
