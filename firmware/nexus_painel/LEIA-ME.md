# Painel de parede — `nexus_painel` (v2.16)

Este é o firmware de **todas as telas de parede que ficam fora do quadro**:

| Tela | Placa | Modo | O que mostra |
|---|---|---|---|
| Corredor | Waveshare **ESP32-P4-NANO** + **10.1-DSI-TOUCH-A** (800 × 1280, em pé) | `PAINEL_MODO_CORREDOR` | a casa toda: energia, água, reservatório, bateria, alertas, filtro por cômodo e todos os aparelhos |
| Cômodo | Waveshare **ESP32-S3-Touch-LCD-7** (800 × 480, deitada) | `PAINEL_MODO_COMODO` + `PAINEL_COMODO "Cozinha"` | resumo da casa à esquerda e os aparelhos do cômodo à direita |

A placa é escolhida **automaticamente pelo chip**: compilou para ESP32-P4, vira a tela de 10,1"; compilou para ESP32-S3, vira a de 7".

O painel é **cliente** do NexusHome:
- lê `GET /iot-gateway/panel` a cada 3 s;
- manda os toques para `POST /iot-gateway/panel/command`;
- **não** entra no RS-485: quem comanda os barramentos são as telas 4,3" do quadro.

Sem internet, ele mostra "sem conexão" e o último estado recebido.

## Configurar

Edite as primeiras linhas de `nexus_painel.ino`. O instalador preserva essas linhas quando você atualiza o firmware.

```c
#define WIFI_SSID       "SUA_REDE_WIFI"
#define WIFI_PASSWORD   "SUA_SENHA_WIFI"
#define DEVICE_SECRET   "o mesmo IOT_DEVICE_SECRET das outras placas"
#define PAINEL_MODO     PAINEL_MODO_COMODO        // ou PAINEL_MODO_CORREDOR
#define PAINEL_COMODO   "Cozinha"                 // nome EXATO do cômodo no app
```

## Gravar

```powershell
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware painel -Placa p4   -Porta COM7   # corredor
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware painel -Placa s3-7 -Porta COM8   # cômodo
```

Bibliotecas: ESP32_Display_Panel 1.0.4, lvgl 8.4.0 e ArduinoJson 7.4.2, com o core esp32 3.3.12. O instalador cuida delas.

## Usar

- **Toque num quadro:**
  - luz, tomada ou exaustor: liga e desliga na hora;
  - circuito do quadro elétrico, válvula de água ou portão: pede confirmação antes;
  - alarme: abre os botões Desarmar / Em casa / Ausente.
- **Toque longo:** brilho da luz ou temperatura do ar-condicionado.
- **Quadro vermelho:** aparelho em alarme ou travado (rompimento de cano, sobrecarga). O painel **não reabre** o que está travado: o rearme é feito na tela do quadro, de propósito.
- **Faixa "Seguro / Atenção / Crítico":** é a mesma saúde da casa mostrada no app.
- **Brilho:** 100 % de dia e 25 % das 22 h às 6 h. O P4 regula por PWM; a tela de 7" só liga e desliga.

## Serial (115200)

| Comando | Faz |
|---|---|
| `status` | Wi-Fi, IP, modo, quantos aparelhos e a energia da casa |
| `lista` | lista os aparelhos que o servidor mandou |
| `toque N` | simula um toque no aparelho N da lista, para testar sem encostar na tela |

## Teste no PC

O modelo de dados (`painel_model.h`) é C++ puro. O `npm test` compila `teste/teste_modelo.cpp` com g++ e confere se ele lê o JSON que o próprio servidor gera (`supabase/functions/iot-gateway/panel.ts`).
