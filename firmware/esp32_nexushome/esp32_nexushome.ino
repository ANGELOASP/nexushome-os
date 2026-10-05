// ============================================================
// NexusHome OS — Firmware ESP32 (ponte IoT)
// ------------------------------------------------------------
// Lê sensores (energia, fluxo de água, temperatura/umidade) e
// publica a telemetria na Edge Function "iot-gateway".
// Também aciona um relé conectado à válvula solenoide de água.
//
// Placa alvo: ESP32 DevKit (Arduino Core 2.x+)
// Bibliotecas: WiFi, HTTPClient (built-in), ArduinoJson 7 (opcional)
//
// Para começar rápido, deixe SIMULATE_SENSORS = true: o firmware
// gera leituras plausíveis sem nenhum hardware ligado.
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>

// ---------- Configuração do usuário ----------
#define WIFI_SSID        "SUA_REDE_WIFI"
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"

// URL da Edge Function (Supabase Dashboard → Edge Functions)
#define GATEWAY_URL      "https://SEU_PROJETO.supabase.co/functions/v1/iot-gateway"
#define DEVICE_SECRET    "MESMO_SEGREDO_DE_IOT_DEVICE_SECRET"

// UUID do dispositivo na tabela devices (ver supabase/migrations/001_init.sql)
#define DEVICE_ID_METER  "a4444444-4444-4444-8444-444444444444"  // Medidor de Energia
#define DEVICE_ID_VALVE  "a3333333-3333-4333-8333-333333333333"  // Válvula de Água Geral

#define SIMULATE_SENSORS true
#define PUBLISH_INTERVAL_MS 5000

// Pinos
#define PIN_VALVE_RELAY  26   // relé da válvula solenoide (ativo em HIGH)
#define PIN_FLOW_SENSOR  27   // sensor de fluxo YF-S201 (pulsos)
#define PIN_ENERGY_ADC   34   // SCT-013 via divisor (leitura analógica)

// ---------- Estado ----------
unsigned long lastPublish = 0;
volatile uint32_t flowPulses = 0;

void IRAM_ATTR onFlowPulse() { flowPulses++; }

// ---------- Publicação ----------
bool postTelemetry(const char* deviceId, const char* metric, float value, const char* statusJson) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.begin(GATEWAY_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_SECRET);
  http.setTimeout(6000);

  char body[256];
  if (statusJson) {
    snprintf(body, sizeof(body),
      "{\"device_id\":\"%s\",\"metric_type\":\"%s\",\"value\":%.2f,\"status\":%s}",
      deviceId, metric, value, statusJson);
  } else {
    snprintf(body, sizeof(body),
      "{\"device_id\":\"%s\",\"metric_type\":\"%s\",\"value\":%.2f}",
      deviceId, metric, value);
  }

  int code = http.POST(body);
  Serial.printf("[iot] %s = %.2f → HTTP %d\n", metric, value, code);
  http.end();
  return code >= 200 && code < 300;
}

// ---------- Leituras ----------
float readEnergyWatts() {
#if SIMULATE_SENSORS
  // carga base + variação + pico ocasional (800–2500 W, picos maiores)
  float w = 900.0f + 700.0f * (float)sin(millis() / 30000.0f) + random(0, 600);
  if (random(0, 100) < 6) w += random(1200, 2600);
  return w < 0 ? 0 : w;
#else
  int raw = analogRead(PIN_ENERGY_ADC);
  // calibrar conforme o seu sensor/circuito:
  return (raw / 4095.0f) * 5000.0f;
#endif
}

float readWaterFlowLph() {
#if SIMULATE_SENSORS
  return random(0, 100) < 20 ? random(300, 900) : 0;  // consumo intermitente
#else
  // YF-S201: ~450 pulsos por litro. Medir entre publicações.
  noInterrupts();
  uint32_t pulses = flowPulses;
  flowPulses = 0;
  interrupts();
  float seconds = PUBLISH_INTERVAL_MS / 1000.0f;
  float liters = pulses / 450.0f;
  return (liters / seconds) * 3600.0f;  // L/h
#endif
}

float readTemperature() {
#if SIMULATE_SENSORS
  return 23.0f + 4.0f * (float)sin(millis() / 90000.0f) + random(-5, 5) / 10.0f;
#else
  return 24.0f;  // ligar aqui um DHT22 (biblioteca DHT sensor library)
#endif
}

float readHumidity() {
#if SIMULATE_SENSORS
  return 52.0f + random(-60, 60) / 10.0f;
#else
  return 55.0f;  // idem DHT22
#endif
}

// ---------- Válvula ----------
void setValve(bool open) {
  digitalWrite(PIN_VALVE_RELAY, open ? HIGH : LOW);
  Serial.printf("[iot] válvula %s\n", open ? "ABERTA" : "FECHADA");
}

// ---------- Setup / Loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_VALVE_RELAY, OUTPUT);
  pinMode(PIN_FLOW_SENSOR, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_FLOW_SENSOR), onFlowPulse, RISING);
  setValve(true);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[wifi] conectando");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print('.'); }
  Serial.printf("\n[wifi] conectado: %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(1000);
    return;
  }

  unsigned long now = millis();
  if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
  lastPublish = now;

  float watts = readEnergyWatts();
  float flow  = readWaterFlowLph();
  float temp  = readTemperature();
  float hum   = readHumidity();

  char statusJson[64];
  snprintf(statusJson, sizeof(statusJson), "{\"watts\":%.0f}", watts);
  postTelemetry(DEVICE_ID_METER, "energy_watts", watts, statusJson);
  postTelemetry(DEVICE_ID_VALVE, "water_flow_lph", flow, nullptr);
  postTelemetry(DEVICE_ID_METER, "temperature", temp, nullptr);
  postTelemetry(DEVICE_ID_METER, "humidity", hum, nullptr);
}
