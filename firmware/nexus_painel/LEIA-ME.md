# Painel de parede — `nexus_painel` (v2.16)

Este é o firmware de **todas as telas de parede que ficam fora do quadro**:

| Tela | Placa | Modo | O que mostra |
|---|---|---|---|
| Corredor | Waveshare **ESP32-P4-NANO** + **10.1-DSI-TOUCH-A** (800 × 1280, em pé) | `PAINEL_MODO_CORREDOR` | a casa toda: energia, água, reservatório, bateria, alertas, filtro por cômodo e todos os aparelhos |
| Cômodo | Waveshare **ESP32-S3-Touch-LCD-7** (800 × 480, deitada) | `PAINEL_MODO_COMODO` + `PAINEL_COMODO "Cozinha"` | resumo da casa à esquerda e os aparelhos do cômodo à direita |

A placa é escolhida **automaticamente pelo chip**: compilou para ESP32-P4, vira a tela de 10,1"; compilou para ESP32-S3, vira a de 7".

O painel é **cliente** do NexusHome:
- lê `GET /iot-gateway/panel` a cada 3 s;
- no corredor, desenha **a planta do app** (`GET /iot-gateway/panel/plan`): os mesmos cômodos, paredes e aparelhos do Editor de Planta. Não há planta gravada no firmware. A cada consulta o `/panel` traz a assinatura da planta (`ps`); se você mudar a planta no app (ou importar outro DXF), o P4 baixa a nova e redesenha em poucos segundos, sem regravar a placa;
- manda os toques para `POST /iot-gateway/panel/command`;
- **não** entra no RS-485: quem comanda os barramentos são as telas 4,3" do quadro.

Sem internet, ele mostra "sem conexão" e o último estado recebido.

## Configurar

Edite as primeiras linhas de `nexus_painel.ino` **na sua cópia de trabalho** (`%LOCALAPPDATA%\NexusHome\firmware\nexus_painel`,
criada pelo instalador — fora de Documentos/OneDrive, ver `scripts/LEIA-ME.md`). O instalador preserva essas linhas quando
você atualiza o firmware e mostra `PAINEL_MODO`/`PAINEL_COMODO` antes de compilar, avisando se o modo não combina com a
placa (`-Placa p4` = corredor, `-Placa s3-7` = cômodo).

```c
#define WIFI_SSID       "SUA_REDE_WIFI"
#define WIFI_PASSWORD   "SUA_SENHA_WIFI"
#define DEVICE_SECRET   "o mesmo IOT_DEVICE_SECRET das outras placas"
#define PAINEL_MODO     PAINEL_MODO_COMODO        // ou PAINEL_MODO_CORREDOR
#define PAINEL_COMODO   "Cozinha"                 // nome do cômodo no app
```

O nome do cômodo é comparado como no servidor: sem diferenciar maiúsculas (inclusive `Á`/`á`, `Ç`/`ç`...) e
ignorando espaços nas pontas — mas o acento conta (`Area` ≠ `Área`).

## Gravar

```powershell
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware painel -Placa p4   -Porta COM7   # corredor
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware painel -Placa s3-7 -Porta COM8   # cômodo
```

Bibliotecas: ESP32_Display_Panel 1.0.4, lvgl 8.4.0 e ArduinoJson 7.4.2, com o core esp32 3.3.12. O instalador cuida delas.

## Usar

- **Toque num quadro:**
  - luz, tomada ou exaustor: liga e desliga na hora;
  - circuito do quadro elétrico, válvula de água ou portão: pede confirmação antes. A janela guarda **qual
    aparelho** (pelo id) e **o que fazer** no momento em que abre: se a lista mudar enquanto ela está aberta, o
    botão age sobre o mesmo aparelho e com a mesma ação; se o aparelho sumir da lista, a janela fecha sem enviar;
  - alarme: abre os botões Desarmar / Em casa / Ausente.
- **Toque longo:** brilho da luz ou temperatura do ar-condicionado.
- **Quadro vermelho:** aparelho em alarme ou travado (rompimento de cano, sobrecarga). O painel **não reabre** o que está travado — nem válvula/portão, nem circuito desarmado por sobrecarga (o toque só mostra o estado; desligar continua permitido): o rearme é feito na tela do quadro, de propósito.
- **Faixa "Seguro / Atenção / Crítico":** é a mesma saúde da casa mostrada no app.
- **Brilho:** 100 % de dia e 25 % das 22 h às 6 h. O P4 regula por PWM; a tela de 7" só liga e desliga.

## Serial (115200)

| Comando | Faz |
|---|---|
| `status` | Wi-Fi, IP, modo, quantos aparelhos e a energia da casa |
| `lista` | lista os aparelhos que o servidor mandou |
| `toque N` | simula um toque no aparelho N da lista, para testar sem encostar na tela |

## Teste no PC

O modelo de dados (`painel_model.h`) é C++ puro. O `npm test` compila `teste/teste_modelo.cpp` com g++ e confere se ele lê o JSON que o próprio servidor gera (`supabase/functions/iot-gateway/panel.ts`), inclusive: circuito travado por sobrecarga (`trip`) não oferece religar, a janela de confirmação acha o aparelho pelo id num snapshot reordenado (e não envia se ele sumiu ou travou) e a comparação do nome do cômodo.

A interface inteira roda no PC pelo simulador (`simulador/rodar.sh`, LVGL → PNG).

## Detalhes de funcionamento

- Os temporizadores usam diferença de tempo (`millis() - último >= intervalo`), então a virada do `millis()` a cada
  49,7 dias não congela o painel nem faz a planta ser baixada sem parar.
- O `GET /panel` é feito em HTTP/1.0 (sem `Transfer-Encoding: chunked`, conexão fechada no fim).
- HTTPS com o certificado do servidor **verificado** pelo pacote de CAs do core (`nh_tls.h`, igual nos 5
  firmwares). Se a verificação falhar, a serial mostra `TLS: certificado recusado`; para diagnosticar, descomente
  `#define NEXUS_TLS_INSEGURO 1` acima do `#include "nh_tls.h"` (só para teste — ver `scripts/LEIA-ME.md`).
- Watchdog: o `loop()` é vigiado (15 s) e a tarefa de rede dá um sinal a cada volta e a cada pedido; sem sinal por
  3 min (rede travada dentro da biblioteca), o painel reinicia sozinho.
- A cada resposta (3 s) só os quadros que mudaram são redesenhados (assinatura por quadro).
