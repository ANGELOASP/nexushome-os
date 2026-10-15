#pragma once
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <stdio.h>
extern uint32_t sim_ms;
static inline uint32_t millis() { return sim_ms; }
typedef void* SemaphoreHandle_t;
#define portMAX_DELAY 0xffffffff
#define pdTRUE 1
static inline SemaphoreHandle_t xSemaphoreCreateMutex() { return (void*)1; }
static inline int xSemaphoreTake(SemaphoreHandle_t, uint32_t) { return pdTRUE; }
static inline int xSemaphoreGive(SemaphoreHandle_t) { return pdTRUE; }
#define MALLOC_CAP_SPIRAM 1
static inline void* heap_caps_malloc(size_t n, int) { return malloc(n); }
