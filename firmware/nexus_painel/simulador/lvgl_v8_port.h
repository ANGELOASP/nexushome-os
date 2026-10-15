#pragma once
#include <lvgl.h>
namespace esp_panel { namespace drivers { struct LCD; struct Touch; } }
bool lvgl_port_init(esp_panel::drivers::LCD*, esp_panel::drivers::Touch*);
static inline bool lvgl_port_lock(int) { return true; }
static inline bool lvgl_port_unlock(void) { return true; }
