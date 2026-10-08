# Checklist: do zero ao ESP32 enviando dados ao NexusHome

> Opcional. Para **água (Tuya/Smart Life)** e **TV/ar-condicionado (Samsung SmartThings)** não é
> preciso nenhuma placa: essas integrações já estão prontas no app. Use este roteiro se quiser
> montar algo sob medida (por exemplo, um medidor próprio).

## Fase 1 — Comprar (lista mínima)

- [ ] **1 placa ESP32 DevKit V1** (chip ESP32-WROOM-32, 30 pinos). Busque por "ESP32 DevKit V1 WROOM 32".
  - [ ] Anote o conversor USB do anúncio: **CP2102** ou **CH340** (define o driver).
  - [ ] Anote a entrada: **micro-USB** ou **USB-C** (define o cabo).
- [ ] **1 cabo USB de DADOS** do mesmo tipo da placa (cabo só de carga não funciona).
- [ ] *(opcional)* protoboard + jumpers macho-macho, para o exemplo "Blink" com LED.

Onde pesquisar (links de busca, **não verificados** — confira estoque, preço e vendedor):

- Mercado Livre: <https://lista.mercadolivre.com.br/esp32-devkit-v1>
- Lojas maker (pesquise pelo termo acima): filipeflop.com, makerhero.com, usinainfo.com.br
- AliExpress (entrega demorada)

## Fase 2 — Instalar no PC (Windows)

- [ ] **Arduino IDE 2**: <https://www.arduino.cc/en/software>
- [ ] **Driver USB** (só se o Windows não reconhecer a placa): CP210x ou CH340, conforme a placa.
- [ ] **Suporte ao ESP32** ([documentação oficial](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)):
  1. Arquivo → Preferências → "URLs adicionais do gerenciador de placas".
  2. Cole: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
  3. Ferramentas → Placa → Gerenciador de placas → busque `esp32` → instale **esp32 by Espressif Systems**.
  4. Reinicie a IDE.

## Fase 3 — Primeiro teste (a gravação funciona?)

- [ ] Ligue a placa ao PC; em Ferramentas → Porta deve aparecer uma **COM** nova.
- [ ] Ferramentas → Placa → **ESP32 Dev Module**.
- [ ] Arquivo → Exemplos → 01.Basics → **Blink** → Upload.
- [ ] Se travar em "Connecting...", segure o botão **BOOT** da placa.
- [ ] O LED da placa pisca? Ambiente pronto.

## Fase 4 — Firmware do NexusHome (modo simulado)

- [ ] Gere um segredo **novo** (PowerShell):
  `-join ((48..57)+(97..122) | Get-Random -Count 32 | % {[char]$_})`
- [ ] Grave no Supabase (terminal em `C:\nexushome-os`, projeto **NEXUSHOME** vinculado):
  `npx supabase secrets set IOT_DEVICE_SECRET="VALOR"`
- [ ] Abra `firmware/esp32_nexushome/esp32_nexushome.ino` e preencha:
  - [ ] `WIFI_SSID` — rede **2,4 GHz** (o ESP32 não conecta em 5 GHz)
  - [ ] `WIFI_PASSWORD`
  - [ ] `DEVICE_SECRET` — **igual** ao `IOT_DEVICE_SECRET`
- [ ] Deixe `SIMULATE_SENSORS true` (leituras falsas, sem sensor).
- [ ] Upload e abra o **Monitor Serial** em 115200 baud.
- [ ] Apareceu **HTTP 200**? Confira no SQL Editor do NEXUSHOME:
  `select * from public.telemetry_logs order by created_at desc limit 5;`

| Código | Causa provável |
| --- | --- |
| 401 | `DEVICE_SECRET` diferente do `IOT_DEVICE_SECRET` |
| 503 | `IOT_DEVICE_SECRET` não configurado no Supabase |
| erro de conexão / -1 | Wi-Fi errado ou rede só 5 GHz |

## Fase 5 — Sensores reais (só depois da fase 4)

- [ ] Escolha o que medir. Vazão de água (**YF-S201**) é o mais seguro para começar.
- [ ] Energia com **SCT-013** envolve a rede elétrica: **não instale sozinho**, chame um eletricista.
- [ ] Siga os pinos descritos no comentário do firmware; só então mude `SIMULATE_SENSORS` para `false`.

## Segurança

- [ ] Nunca faça commit do `.ino` com Wi-Fi/segredo preenchidos.
- [ ] Se um segredo aparecer em print ou chat, gere outro e regrave (`secrets set` + sketch).
- [ ] O ESP32 usa USB (5 V); não ligue direto à tomada (127/220 V).
- [ ] Antes de qualquer `deploy`, confirme o projeto com `npx supabase projects list` (o NEXUSHOME **não** é o `oncosystem-prod`).

## Alternativa: Raspberry Pi

- **Pico W** (microcontrolador): serve, mas o firmware atual é para ESP32 e teria de ser reescrito.
- **Raspberry Pi completo**: serve com um script Python que faça POST ao `iot-gateway`
  (`x-device-key` + JSON `device_id`/`metric_type`/`value`). Não tem entrada analógica (ADC),
  então medir energia com SCT-013 exige um conversor externo.
- Para quem está começando, o ESP32 é o caminho mais simples, pois o firmware já está pronto.
