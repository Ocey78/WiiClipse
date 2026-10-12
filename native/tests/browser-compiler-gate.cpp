// C++20; exercises the actual experimental gate registry with no JavaScript runtime.
#include <cassert>
#include <array>
#include <cstdio>
#include <vector>
#include "Core/PowerPC/CachedInterpreter/BrowserCompilerGate.h"
static s32 Compiled(PowerPC::PowerPCState&,const void*) { return 0; }
int main()
{
  BrowserCompiler::Registry registry;
  BrowserCompiler::Gate first{}, second{};
  std::array<u8,8> bytes{1,2,3,4,5,6,7,8};
  first.entry=second.entry=bytes.data();first.end=second.end=bytes.data()+bytes.size();
  registry.Add(first); registry.Add(second);
  assert(registry.Retain(first));
  const u8* retained=first.retained;
  bytes[0]=99;
  assert(retained[0]==1);
  const auto old_id=first.id,old_epoch=first.epoch;
  assert(registry.Find(&first,old_id,old_epoch)==&first);
  first.job=BrowserCompiler::Job::Queued; ++registry.queued;
  assert(registry.Install(&first,old_id,old_epoch,Compiled));
  assert(registry.compiled==1 && registry.queued==0);
  ++registry.active;
  registry.Retire(first);
  assert(first.compiled==nullptr && registry.compiled==0);
  assert(registry.Find(&first,old_id,old_epoch)==nullptr);
  std::vector<u32> released;
  unsigned clears=0;
  auto release=[&](u32 slot){released.push_back(slot);};
  auto clear=[&](u32){++clears;};
  registry.Drain(release,clear);
  assert(released.empty());
  assert(retained[0]==1); // Payload survives active invalidation and source mutation.
  --registry.active; registry.Drain(release,clear);
  assert(released.size()==1);
  registry.Add(first); // Reused code address gets a fresh identity.
  assert(first.id!=old_id);
  assert(!registry.Install(&first,old_id,old_epoch,Compiled));
  first.job=BrowserCompiler::Job::Queued; ++registry.queued;
  assert(registry.Install(&first,first.id,first.epoch,Compiled));
  second.job=BrowserCompiler::Job::Queued; ++registry.queued;
  const auto stale_epoch=second.epoch, stale_id=second.id;
  ++registry.active;
  registry.enabled=false;
  registry.Reset();
  assert(registry.compiled==0 && registry.queued==0 && first.compiled==nullptr);
  assert(second.epoch!=stale_epoch);
  assert(!registry.Install(&second,stale_id,stale_epoch,Compiled));
  registry.Drain(release,clear); assert(clears==0);
  --registry.active; registry.Drain(release,clear); assert(clears==1);
  registry.enabled=true;
  second.job=BrowserCompiler::Job::Queued; ++registry.queued;
  assert(registry.Install(&second,second.id,second.epoch,Compiled));
  registry.Retire(second);
  registry.Drain(release,clear);
  registry.Retire(first);
  assert(registry.live.empty());
  BrowserCompiler::Registry replacement;
  assert(replacement.epoch>registry.epoch); // Persistent JS manager sees monotonic epochs across instances.
  std::puts("Verified compiler gate identity, stale installs, active-slot retention, epoch reset, disable/reenable and code-address reuse");
}
