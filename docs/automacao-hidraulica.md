# Automação hidráulica — ESP32-S3 Modbus RTU

Firmware: [`firmware/esp32s3_hidraulica/esp32s3_hidraulica.ino`](../firmware/esp32s3_hidraulica/esp32s3_hidraulica.ino)
— **C++ / framework Arduino**, placa "ESP32S3 Dev Module". Implementa o *Memorial Descritivo e Projeto de
Automação Hidráulica* (Painel de Controle Laje): o ESP32-S3 é o mestre Modbus RTU do barramento RS-485.

| Slave | Equipamento | O que o firmware faz |
|---|---|---|
| 1 | Contadora FT-PFC-04 nº 1 | lê DI1–DI4 (Cozinha, Banheiro 1, Banheiro 2, Área de Serviço) |
| 2 | Contadora FT-PFC-04 nº 2 | lê DI1–DI3 (Ramal 5, Ramal 6, Área Externa); DI4 reserva |
| 3 | Sonda QDY30A | lê o nível (mm) → volume dos 2 reservatórios interligados |
| 4 | Waveshare Relay 8-CH | comanda as 8 válvulas (relés 1–6 ramais, 7 geral, 8 área externa) |

Barramento: 9600 8N1 em todos, par trançado blindado em cascata, **resistor de 120 Ω** entre A e B no último
elemento. Configure os endereços de cada equipamento antes de ligar todos juntos (cada um sai de fábrica com ID 1).

## ⚠️ Correções ao memorial (revise antes de energizar)

1. **Fiação NO/NC das válvulas (item 2.4) está invertida em relação à nota de segurança.**
   Com o relé desligado (boot, falha, placa sem alimentação), o COM fica ligado ao **NC**. Se o NC for ao fio
   azul (*Fecha*), todas as válvulas **fecham** ao ligar o painel — o oposto do que a nota promete.
   Ligação correta para "aberta por padrão":
   - **NC → fio Vermelho (Abre)**
   - **NO → fio Azul (Fecha)**
   - Preto → GND fixo

   Assim, relé **energizado = válvula fechada**. O firmware usa essa convenção
   (`RELAY_ENERGIZED_CLOSES true`). Se mantiver a fiação do memorial, mude para `false` — mas aí qualquer
   reinício fecha a água da casa.
2. **Fator da sonda (item 3.1).** Duas caixas de 500 L somam 1000 L em ~70 cm de lâmina: **~14 L por cm**
   (1,4 L/mm), não 1,3–1,4 L por cm. Calibre `TANK_LITERS_PER_MM` = litros úteis ÷ altura útil em mm, e
   `TANK_EMPTY_MM` = leitura da sonda no nível mínimo.
3. **Registradores a confirmar no manual do fabricante** (variam entre lotes):
   - FT-PFC-04: função (03/04), endereço base da contagem acumulada de 32 bits e ordem das palavras
     (`COUNTER_FUNC`, `COUNTER_REG_BASE`, `COUNTER_HIGH_FIRST`).
   - QDY30A: registrador de casas decimais (0x0003) e de valor (0x0004), e a unidade configurada
     (`SONDA_UNIT_TO_MM`).
   - Pinos RS-485 da placa SpotPear (`RS485_RX_PIN`, `RS485_TX_PIN`, `RS485_DE_PIN`; use -1 se a direção for
     automática).

## Regras de segurança (item 3.2)

| Regra | Condição | Ação |
|---|---|---|
| Rompimento de adutora | volume caiu > 10% (100 L) em ≤ 180 s **e** os 7 medidores registraram < 30% dessa queda | fecha o **Relé 7** (Geral) |
| Vazamento externo | Ramal 7 (DI3 da Contadora 2) com fluxo ≥ 6 L/h ininterrupto por 60 min | fecha o **Relé 8** (Área Externa) |
| Pânico geral | botão BOOT segurado 2 s, comando `panico` na serial, ou `panicCloseAll()` chamado pela tela | fecha as 8 válvulas num único comando Modbus (função 0F) |

- Os alarmes **ficam travados**: a válvula só reabre com `reset` (serial) — de propósito, para ninguém
  "rearmar" um vazamento sem ver.
- Sem leitura dos medidores, a regra de rompimento **avisa mas não corta** (não dá para separar consumo de
  vazamento); sem leitura da sonda, a regra não roda.
- A telemetria roda numa tarefa separada (núcleo 0): Wi-Fi lento ou fora do ar não atrasa a segurança.

## Telemetria no NexusHome

A cada 15 s o firmware envia para a Edge Function `iot-gateway`:
- cada ramal: `water_flow_lph` + status `{flow_lph, total_l, is_open}` (preencha `DEVICE_RAMAL[]` com os UUIDs
  dos dispositivos criados no app);
- reservatório: `water_level_pct` + status `{level_mm, volume_l, level_pct}` (`DEVICE_TANK`);
- válvula geral: vazão total + status `{is_open, alarm_burst, alarm_external, panic}`.

O `iot-gateway` passou a aceitar `water_level_pct` (a coluna já existia desde a migração 005) — **faça o deploy
da função** (`supabase functions deploy iot-gateway`).

## Bancada (serial 115200)

`status` · `abrir N` · `fechar N` (N = 1..8) · `panico` · `reset`

## Ainda não implementado

- **Tela touch da SpotPear**: a interface gráfica depende do driver de display da placa (LVGL). O firmware expõe
  `panicCloseAll()` e `resetAll()` para o botão virtual chamar.
- **Comandar válvulas pelo app**: hoje o app só recebe telemetria do ESP32; falta um canal de comandos
  (app → Supabase → ESP32).
- **Gateway Waveshare RS485→Wi-Fi/ETH**: não é necessário com o ESP32-S3 conectando direto ao Wi-Fi; se for usado
  como segundo mestre no mesmo barramento, haverá colisão — use-o só para diagnóstico.
