#pragma once
namespace esp_panel { namespace drivers {
  struct LCD {}; struct Touch {};
  struct Backlight { void on() {} void off() {} void setBrightness(int) {} };
} namespace board {
  struct Board { void init() {} bool begin() { return true; }
    drivers::LCD* getLCD() { return nullptr; } drivers::Touch* getTouch() { return nullptr; }
    drivers::Backlight* getBacklight() { return nullptr; } };
} }
