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
3. **Terminação do barramento.** O RS-485 precisa de 120 Ω nas **duas** pontas, não só no último elemento. O
   ESP32-S3 fica numa ponta: ligue o resistor de 120 Ω da própria placa (jumper/chave "120R" ao lado do
   conector RS-485) e coloque outro no último equipamento da cascata.

## Pinos e registradores (pesquisa nos manuais dos fabricantes)

| Item | O que o manual diz | No firmware |
|---|---|---|
| RS-485 da SpotPear / Waveshare **ESP32-S3-Touch-LCD-7** (e 4.3 sem "B") | GPIO15 e GPIO16; direção TX/RX automática | `RS485_PIN_A 15`, `RS485_PIN_B 16`, `RS485_DE_PIN -1` |
| RS-485 da **ESP32-S3-Touch-LCD-4.3B** / LCD-4 | GPIO43 (RX) e GPIO44 (TX) | troque `RS485_PIN_A/B` para 43/44 |
| Ordem RX/TX | a wiki rotula pelo lado do transceptor, e as páginas divergem | o firmware testa uma ordem e **troca sozinho** se ninguém responder (`RS485_AUTO_SWAP`) |
| Placa de relés Waveshare 8-CH | bobinas 0x0000–0x0007, funções 01/05/0F, 0xFF00 = liga; endereço de fábrica 1 | comando em lote 0x0F, com reserva de oito 0x05 se a placa recusar |
| Sonda QDY30A | mapa da família: 0x0003 = casas decimais, 0x0004 = valor (int16); unidade costuma ser cm ou mm | `SONDA_DECIMALS_REG 0x0003`, `SONDA_VALUE_REG 0x0004`, `SONDA_UNIT_TO_MM` (conferir com `dump 3`) |
| Contadora FT-PFC-04 | **mapa não publicado online** — vem no PDF/manual que acompanha a placa | provisório: 32 bits por canal a partir de 0x0000, função 03; confirme com `dump 1` |

### Como confirmar na bancada (quando as placas chegarem)

1. Ligue **uma placa por vez** ao barramento e grave o endereço dela (1, 2, 3 ou 4) com o software do fabricante.
2. No monitor serial (115200): `dump 1` → gire a turbina do ramal 1 → `dump 1` de novo. O par de registradores
   que aumentou é a contagem do DI1; os seguintes são DI2–DI4. Ajuste `COUNTER_FUNC`, `COUNTER_REG_BASE` e
   `COUNTER_HIGH_FIRST` (se a palavra que muda devagar vier depois, use `false`).
3. `dump 3` com a sonda numa altura conhecida (ex.: 20 cm de água): confira o registrador 4 e as casas decimais
   do registrador 3 e ajuste `SONDA_UNIT_TO_MM`.
4. `fechar 1` / `abrir 1`: o relé 1 deve estalar e a válvula do ramal 1 fechar/abrir.

Fontes: [wiki ESP32-S3-Touch-LCD-7](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-7) ·
[docs ESP32-S3-Touch-LCD-4.3](https://docs.waveshare.com/ESP32-S3-Touch-LCD-4.3) ·
[wiki ESP32-S3-Touch-LCD-4.3B](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-4.3B) ·
[wiki Modbus RTU Relay](https://waveshare.com/wiki/Modbus_RTU_Relay) ·
[manual de transmissor de nível da mesma família (registradores 3/4)](https://store.hipco.com/images/additional/Icon_100-Series_RS-485-Operating-Manual.pdf)

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
- cada ramal: `water_flow_lph` + status `{flow_lph, total_l, open}` — os dispositivos são criados por
  `supabase/seeds/hidraulica.sql` com UUIDs fixos que já estão no firmware;
- reservatório: `water_level_pct` + status `{level_mm, volume_l, level_pct}` (`DEVICE_TANK`);
- válvula geral: vazão total + status `{open, alarm_burst, alarm_external, panic}`.

O `iot-gateway` passou a aceitar `water_level_pct` (a coluna já existia desde a migração 005) — **faça o deploy
da função** (`supabase functions deploy iot-gateway`).

## Instalar o ambiente e compilar (Windows)

```powershell
cd C:\nexushome-os
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1
```

Instala a Arduino IDE 2 + Arduino CLI (winget), o core ESP32 da Espressif, copia o firmware para
`Documentos\Arduino\esp32s3_hidraulica` (onde você coloca Wi-Fi e `DEVICE_SECRET`, fora do Git) e compila para
ESP32-S3 (8 MB, PSRAM OPI). Compilado com o core `esp32:esp32` 3.3.12: 996 KB (75% da partição de app).

## Bancada (serial 115200)

`status` · `abrir N` · `fechar N` (N = 1..8) · `panico` · `reset` · `dump S` (lista os registradores do escravo S)

## Ainda não implementado

- **Tela touch da SpotPear**: a interface gráfica depende do driver de display da placa (LVGL). O firmware expõe
  `panicCloseAll()` e `resetAll()` para o botão virtual chamar.
- **Comandar válvulas pelo app**: hoje o app só recebe telemetria do ESP32; falta um canal de comandos
  (app → Supabase → ESP32).
- **Gateway Waveshare RS485→Wi-Fi/ETH**: não é necessário com o ESP32-S3 conectando direto ao Wi-Fi; se for usado
  como segundo mestre no mesmo barramento, haverá colisão — use-o só para diagnóstico.
