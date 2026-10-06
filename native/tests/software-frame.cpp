#include "DolphinLibretro/SoftwareFrame.h"

#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>

int main()
{
  // Two RGBA rows, with distinct corners so cropping and source stride are observable.
  const std::array<std::uint8_t, 24> rgba = {
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
      17, 34, 51, 255, 68, 85, 102, 255, 119, 136, 153, 255};
  Libretro::Video::SoftwareFrame frame;
  assert(frame.CopyRGBA(rgba.data(), 3, 2, 0, 0, 3, 2));
  assert(frame.width == 3 && frame.height == 2);
  assert(frame.pixels[0] == 0xffff0000u);
  assert(frame.pixels[1] == 0xff00ff00u);
  assert(frame.pixels[2] == 0xff0000ffu);
  assert(frame.pixels[3] == 0xff112233u);
  assert(frame.pixels[5] == 0xff778899u);

  assert(frame.CopyRGBA(rgba.data(), 3, 2, 1, 0, 3, 2));
  assert(frame.width == 2 && frame.height == 2);
  assert((frame.pixels == std::vector<std::uint32_t>{
      0xff00ff00u, 0xff0000ffu, 0xff445566u, 0xff778899u}));
  assert(frame.CopyRGBA(rgba.data(), 3, 2, 1, 1, 2, 2));
  assert(frame.width == 1 && frame.height == 1 && frame.pixels[0] == 0xff445566u);

  assert(frame.CopyRGBA(rgba.data(), 3, 2, -1, -1, 4, 3));
  assert(frame.width == 3 && frame.height == 2);
  assert(!frame.CopyRGBA(rgba.data(), 3, 2, 3, 0, 4, 1));
  assert(!frame.CopyRGBA(rgba.data(), 3, 2, 2, 1, 1, 0));
  assert(!frame.CopyRGBA(nullptr, 3, 2, 0, 0, 3, 2));
  assert(!frame.CopyRGBA(rgba.data(), 0, 2, 0, 0, 3, 2));
  std::puts("Software frame conversion: channel order, crop, stride, and bounds passed.");
}
