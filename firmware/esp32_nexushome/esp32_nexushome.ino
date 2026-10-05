// ============================================================
// NexusHome OS — Firmware ESP32 (ponte IoT)
// ------------------------------------------------------------
// Lê sensores (energia, fluxo de água, temperatura/umidade) e
// publica a telemetria na Edge Function "iot-gateway".
// Também aciona um relé conectado à válvula solenoide de água.
//
// Placa alvo: ESP32 DevKit (Arduino Core 2.x+)
// Bibliotecas: WiFi, HTTPClient (built-in do core ESP32).
//   Nenhuma biblioteca JSON é necessária — o payload é montado
//   com snprintf. Se um dia quiser parsear respostas, use
//   ArduinoJson v6 (compatível com Arduino IDE 1.8/2.x).
//   Com HAS_DHT22 = true é preciso instalar pela Library Manager:
//     · "DHT sensor library" (Adafruit)
//     · "Adafruit Unified Sensor" (dependência, a IDE oferece)
//
// Fiação do DHT22 / AM2302 (opcional, ver HAS_DHT22):
//   VCC  → 3.3V
//   DATA → GPIO4 (configurável em DHT_PIN) com pull-up de 10kΩ
//          para 3.3V — muitos módulos breakout já incluem o resistor
//   GND  → GND
//   AVISO: alimente com 3.3V, NÃO 5V, principalmente em cabos
//   longos (queda de tensão e nível lógico comprometem a leitura).
//   O DHT22 exige ~2 s entre leituras; o ciclo de telemetria de
//   5 s (PUBLISH_INTERVAL_MS) já respeita isso.
//
// Contrato HTTP da Edge Function (supabase/functions/iot-gateway):
//   POST <GATEWAY_URL>
//   Headers: Content-Type: application/json
//            x-device-key: <IOT_DEVICE_SECRET>
//   Body:    {"device_id":"<uuid>","metric_type":"energy_watts|
//            water_flow_lph|temperature|humidity","value":<n>,
//            "status":{...}}   // "status" opcional: faz merge em
//                              // devices.status (ex.: {"watts":X})
//   Respostas: 200 ok · 400 payload inválido · 401 chave errada
//              500 falha ao gravar · 207 telemetria ok, status falhou
//
// Para começar rápido, deixe SIMULATE_SENSORS = true: o firmware
// gera leituras plausíveis sem nenhum hardware ligado.
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>

// ---------- Feature flag: sensor de clima real DHT22/AM2302 ----------
// true  → lê temperatura/umidade de um DHT22 ligado ao DHT_PIN
// false → compila sem nenhum código DHT e usa o caminho simulado
//         (ou o stub dos #else, se SIMULATE_SENSORS = false)
#define HAS_DHT22 true
#if HAS_DHT22
#include <DHT.h>            // "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
#endif

// ---------- Configuração do usuário ----------
// ATENÇÃO: o ESP32 só enxerga redes Wi-Fi 2.4 GHz (não funciona
// em redes 5 GHz nem em SSIDs combinados sem banda 2.4 GHz ativa).
#define WIFI_SSID        "SUA_REDE_WIFI"
#define WIFI_PASSWORD    "SUA_SENHA_WIFI"

// URL da Edge Function iot-gateway (projeto NexusHome OS)
#define GATEWAY_URL      "https://gfjxcsvxhaojbtuixpjh.supabase.co/functions/v1/iot-gateway"
// Mesmo segredo configurado no Supabase via:
//   supabase secrets set IOT_DEVICE_SECRET=<segredo>
#define DEVICE_SECRET    "SUA_IOT_DEVICE_SECRET"

// UUIDs dos dispositivos na tabela `devices`
// (seeds de supabase/migrations/001_init.sql — iguais ao Modo Demo):
//   a1111111-1111-4111-8111-111111111111  Luz da Sala            (light)
//   a2222222-2222-4222-8222-222222222222  Ar-Condicionado        (ac)
//   a3333333-3333-4333-8333-333333333333  Válvula de Água Geral  (valve)
//   a4444444-4444-4444-8444-444444444444  Medidor de Energia     (meter) ← padrão
#define DEVICE_ID_METER  "a4444444-4444-4444-8444-444444444444"  // Medidor de Energia
#define DEVICE_ID_AC     "a2222222-2222-4222-8222-222222222222"  // Ar-Condicionado (temp/umidade)
#define DEVICE_ID_VALVE  "a3333333-3333-4333-8333-333333333333"  // Válvula de Água Geral

#define SIMULATE_SENSORS true
#define PUBLISH_INTERVAL_MS 5000

// Retry com backoff exponencial: 1s, 2s, 4s entre tentativas
#define POST_MAX_RETRIES    3
#define POST_RETRY_BASE_MS  1000

// Pinos
#define PIN_VALVE_RELAY  26   // relé da válvula solenoide (ativo em HIGH)
#define PIN_FLOW_SENSOR  27   // sensor de fluxo YF-S201 (pulsos)
#define PIN_ENERGY_ADC   34   // SCT-013 via divisor (leitura analógica)

#if HAS_DHT22
#define DHT_PIN          4    // DATA do DHT22 (GPIO4 — configurável; pull-up 10kΩ para 3.3V)
#define DHT_TYPE         DHT22
DHT dht(DHT_PIN, DHT_TYPE);
#endif

// ---------- Estado ----------
unsigned long lastPublish = 0;
volatile uint32_t flowPulses = 0;

void IRAM_ATTR onFlowPulse() { flowPulses++; }

// ---------- Publicação ----------
// Uma tentativa de POST. Retorna o código HTTP (ou <0 em erro de rede).
int postTelemetryOnce(const char* deviceId, const char* metric, float value, const char* statusJson) {
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
  if (code > 0 && code != 200) {
    // loga o corpo da resposta para facilitar diagnóstico (401/400/500/207)
    String resp = http.getString();
    Serial.printf("[iot] resposta (%d): %s\n", code, resp.c_str());
  }
  http.end();
  return code;
}

// POST com retry e backoff exponencial (1s → 2s → 4s).
bool postTelemetry(const char* deviceId, const char* metric, float value, const char* statusJson) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[iot] %s = %.2f → sem Wi-Fi, descartado\n", metric, value);
    return false;
  }

  for (int attempt = 0; attempt <= POST_MAX_RETRIES; attempt++) {
    int code = postTelemetryOnce(deviceId, metric, value, statusJson);
    bool ok = (code >= 200 && code < 300);
    Serial.printf("[iot] %s = %.2f → HTTP %d%s\n", metric, value, code,
                  ok ? "" : (attempt < POST_MAX_RETRIES ? " (retry)" : " (falha final)"));
    if (ok) return true;
    if (code == 401 || code == 400) break;  // erro de contrato/credencial: retry não ajuda
    if (attempt < POST_MAX_RETRIES) {
      delay(POST_RETRY_BASE_MS << attempt);  // backoff exponencial
    }
  }
  return false;
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
#if HAS_DHT22
  float t = dht.readTemperature();  // °C (NAN em falha de leitura)
  if (isnan(t)) Serial.println("[dht22] falha na leitura de temperatura — métrica pulada neste ciclo");
  return t;
#elif SIMULATE_SENSORS
  return 23.0f + 4.0f * (float)sin(millis() / 90000.0f) + random(-5, 5) / 10.0f;
#else
  return 24.0f;  // sem DHT22 e sem simulação: valor fixo de fallback
#endif
}

float readHumidity() {
#if HAS_DHT22
  float h = dht.readHumidity();  // % (NAN em falha de leitura)
  if (isnan(h)) Serial.println("[dht22] falha na leitura de umidade — métrica pulada neste ciclo");
  return h;
#elif SIMULATE_SENSORS
  return 52.0f + random(-60, 60) / 10.0f;
#else
  return 55.0f;  // sem DHT22 e sem simulação: valor fixo de fallback
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

#if HAS_DHT22
  dht.begin();
  Serial.println("[dht22] sensor inicializado (GPIO4)");
#endif

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
  float temp  = readTemperature();  // NAN se a leitura do DHT22 falhar
  float hum   = readHumidity();     // idem

  // O medidor publica energia e já atualiza devices.status ({"watts": X})
  // no formato que o painel 3D espera.
  char statusJson[64];
  snprintf(statusJson, sizeof(statusJson), "{\"watts\":%.0f}", watts);
  postTelemetry(DEVICE_ID_METER, "energy_watts", watts, statusJson);
  postTelemetry(DEVICE_ID_VALVE, "water_flow_lph", flow, nullptr);

  // Clima ambiente no Ar-Condicionado: temperatura e umidade em POSTs
  // separados; leituras inválidas (NAN) são puladas. O campo opcional
  // "status" do contrato carrega o merge {"ambient_temperature": t,
  // "ambient_humidity": h} no devices.status do AC (vai no primeiro POST).
  bool tempOk = !isnan(temp);
  bool humOk  = !isnan(hum);

  char acStatus[96];
  const char* acStatusPtr = nullptr;
  if (tempOk && humOk) {
    snprintf(acStatus, sizeof(acStatus),
      "{\"ambient_temperature\":%.1f,\"ambient_humidity\":%.0f}", temp, hum);
    acStatusPtr = acStatus;
  } else if (tempOk) {
    snprintf(acStatus, sizeof(acStatus), "{\"ambient_temperature\":%.1f}", temp);
    acStatusPtr = acStatus;
  } else if (humOk) {
    snprintf(acStatus, sizeof(acStatus), "{\"ambient_humidity\":%.0f}", hum);
    acStatusPtr = acStatus;
  }

  if (tempOk) {
    postTelemetry(DEVICE_ID_AC, "temperature", temp, acStatusPtr);
    acStatusPtr = nullptr;  // status já enviado; o POST de umidade vai sem ele
  }
  if (humOk) {
    postTelemetry(DEVICE_ID_AC, "humidity", hum, acStatusPtr);
  }
}
