# Scripts do NexusHome OS (Windows PowerShell 5.1 ou PowerShell 7)

Os scripts rodam no PC com Windows. Abra o PowerShell **dentro da pasta do repositório** (ex.: `C:\nexushome-os`)
e chame cada um com `powershell -ExecutionPolicy Bypass -File scripts\<script>.ps1 ...`. O `-ExecutionPolicy Bypass`
vale só para aquela execução e não muda nada no Windows.

- Mantenha a pasta `scripts\` inteira: todos usam `scripts\nexus-comum.ps1` (funções comuns; não é para rodar sozinho).
- Ajuda completa de qualquer script: `Get-Help scripts\<script>.ps1 -Detailed` (ou `-?`).
- Código de saída: **0** deu certo, **1** falhou (a mensagem em vermelho diz o motivo).
- Nenhum script pede para colar segredos em chat. A chave do dispositivo só é digitada no seu terminal (sem aparecer)
  ou lida da variável `NEXUS_DEVICE_KEY`, e nunca é mostrada.
- **Não digite** `supabase secrets set IOT_DEVICE_SECRET=...` no console: no Windows PowerShell 5.1 a linha fica gravada
  no histórico (`ConsoleHost_history.txt`). Use `publicar-funcoes.ps1 -DefinirSegredo` (abaixo).

| Script | Para quê | Exemplo |
|---|---|---|
| `instalar-arduino.ps1` | Instala Arduino IDE 2 + CLI (winget), o core **esp32:esp32@3.3.12** e as bibliotecas ESP32_Display_Panel 1.0.4, lvgl 8.4.0 e ArduinoJson 7.4.2; copia o firmware para `%LOCALAPPDATA%\NexusHome\firmware\` mantendo Wi-Fi/chave (e, no painel, `PAINEL_MODO`/`PAINEL_COMODO`); compila e grava | `powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware eletrica -Porta COM5` |
| `gravar-firmware.ps1` | Compila (e grava com `-Porta`) qualquer firmware com o FQBN certo; mostra flash/RAM usados; `-SoCompilar` para testar; `-Atualizar` recopia do repositório mantendo as suas linhas; no painel mostra `PAINEL_MODO`/`PAINEL_COMODO` e avisa se o modo não combina com a placa | `powershell -ExecutionPolicy Bypass -File scripts\gravar-firmware.ps1 -Firmware painel -Placa p4 -Porta COM9` |
| `monitor-serial.ps1` | Lista as portas COM (com descrição), abre o monitor 115200 (digite e Enter; Ctrl+C sai) ou manda um comando e mostra a resposta | `powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta COM5 -Comando scan -Segundos 10` |
| `enderecar-modbus.ps1` | Grava o endereço Modbus de **um** aparelho no adaptador USB-RS485 (PZEM-016/017, relé Waveshare, XY-MD02) e confere lendo de volta; `-WhatIf` só mostra os quadros | `powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo pzem016 -Novo 7 -Geral` |
| `testar-modbus.ps1` | Lê registradores pelo gateway (Modbus TCP, porta 502) ou pelo adaptador (RTU); `-Pzem` / `-Pzem017` mostram V, A, W, Wh... | `powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Ip 192.168.1.200 -Slave 7 -Pzem` |
| `quiosque-nexushome.ps1` | Abre o NexusHome em tela cheia (Edge/Chrome em modo quiosque) quando o Windows inicia; `-Monitor 2`; desliga o apagamento da tela (com confirmação); `-Remover` desfaz; `-Testar` abre agora | `powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar -Monitor 2` |
| `publicar-funcoes.ps1` | Publica `iot-gateway` e `notify-alert` (ou `-Todas`) no projeto `gfjxcsvxhaojbtuixpjh` pelo Supabase CLI; confere instalação e login; `-DefinirSegredo` grava o `IOT_DEVICE_SECRET` (digitado sem aparecer) e `-OwnerId <uuid>` o `IOT_OWNER_ID`; `-SoSegredos` só grava os secrets | `powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1` |
| `testar-painel.ps1` | Confere `/iot-gateway/health` e `/panel` (resumo: energia, água, bateria, alertas, aparelhos) e, opcionalmente, manda um comando (`/panel/command`, com confirmação; alarme: `-Acao armed -Valor off\|home\|away`) | `powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1 -Comodo Cozinha` |

## Firmwares e placas

| `-Firmware` | Pasta | Placa | FQBN |
|---|---|---|---|
| `hidraulica`, `eletrica`, `seguranca`, `nobreak` | `firmware\esp32s3_<nome>` | ESP32-S3-Touch-LCD-4.3B (T1–T4) | `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc` |
| `painel -Placa p4` | `firmware\nexus_painel` | ESP32-P4-NANO + 10,1" (corredor) | `esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled` |
| `painel -Placa s3-7` | `firmware\nexus_painel` | ESP32-S3-Touch-LCD-7 (cômodos) | o mesmo da 4.3B |

### Onde fica a sua cópia (com a senha do Wi-Fi e a chave)

A cópia de trabalho de cada firmware fica em **`%LOCALAPPDATA%\NexusHome\firmware\<firmware>`** (ex.:
`C:\Users\voce\AppData\Local\NexusHome\firmware\nexus_painel`), fora do repositório e **fora de Documentos** — no
Windows 11 o "Backup de pastas" do OneDrive costuma mandar Documentos para a nuvem, com a senha e a chave junto.

- Se você já tinha a cópia em `Documentos\Arduino\<firmware>` (versões anteriores), o `instalar-arduino.ps1` e o
  `gravar-firmware.ps1` a **copiam** para a pasta nova e avisam: **apague a pasta antiga** de Documentos (e esvazie a
  Lixeira) depois de conferir que a placa grava pela pasta nova. O script nunca apaga nada sozinho.
- O `<firmware>.ino.bak` (cópia anterior, feita a cada atualização) fica **sem** os valores de `WIFI_PASSWORD` e
  `DEVICE_SECRET` (trocados por `"(omitido no backup)"`).
- Outra pasta-base: variável de ambiente `NEXUS_FIRMWARE_DIR`.

As telas de 7" usam a mesma cópia `%LOCALAPPDATA%\NexusHome\firmware\nexus_painel`: confira `PAINEL_MODO` e troque
`PAINEL_COMODO` no `.ino` antes de gravar cada cômodo. Os scripts mostram `PAINEL_MODO`/`PAINEL_COMODO` antes de
compilar e avisam se o modo não combina com a placa (`-Placa p4` = `PAINEL_MODO_CORREDOR`; `-Placa s3-7` =
`PAINEL_MODO_COMODO`).

## Passo a passo típico (docs/projeto-unificado.md §17)

```powershell
# 1. ambiente + primeira gravação da tela de energia (T2)
powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware eletrica -Porta COM5

# 2. endereçar os aparelhos na bancada, UM por vez (tabela do §5.2)
powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo pzem016 -Novo 7 -Geral
powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo waveshare -Novo 5 -Geral
powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo pzem017 -Novo 41 -Geral
powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo xymd02 -Novo 80

# 3. conferir o barramento pela tela
powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Listar
powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta COM5 -Comando scan -Segundos 10

# 4. diagnóstico pelo gateway (desligue antes a tela do barramento: só pode haver um mestre)
powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Ip 192.168.1.200 -Slave 7 -Pzem

# 5. servidor
powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -DefinirSegredo -OwnerId <uuid-do-dono> -SoSegredos   # 1ª vez
powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1
powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1
powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar
```

## HTTPS verificado e watchdog

Os 5 firmwares (T1–T4 e o painel de parede) falam com o `iot-gateway` por HTTPS **com o certificado do servidor
verificado** pelo pacote de CAs raiz que vem no próprio core esp32 3.3.12 (`nh_tls.h`, cópia igual em cada pasta de
sketch). Antes, o TLS aceitava qualquer certificado, e quem se pusesse no meio da rede (AP falso, ARP spoof) podia
capturar o `x-device-key`. A verificação não depende do relógio (o core não confere datas), só da cadeia e do nome.

- **A placa parou de falar com o servidor?** Abra a serial (`monitor-serial.ps1 -Porta COMx`). A linha
  `TLS: certificado recusado` quer dizer que a verificação falhou: a rede está interceptando o HTTPS (Wi-Fi de
  visitante com portal, antivírus/proxy do roteador, AP falso) ou o Supabase passou a usar uma CA fora do pacote
  do core (atualize o core). `TLS: falha no handshake` aponta outro erro do TLS (rede ruim, falta de memória).
- **Só para diagnóstico**: no `.ino` da sua cópia, descomente `#define NEXUS_TLS_INSEGURO 1` (fica logo acima do
  `#include "nh_tls.h"`) e grave de novo. Se com isso a placa volta a conversar, o problema é o certificado/rede.
  A serial avisa `NEXUS_TLS_INSEGURO=1` no boot. **Não deixe assim**: comente a linha e grave de novo (reinstalar
  pelo `instalar-arduino.ps1` também volta ao modo verificado, porque essa linha não é preservada).
- **Watchdog**: o `loop()` de cada placa fica vigiado (15 s, `NEXUS_WDT_TIMEOUT_S`). Travou → a placa reinicia
  sozinha e o estado gravado (válvulas/alarmes da água, circuitos, alarme da casa, SoC) volta da memória antes de
  comandar os relés. Na serial: `[wdt] watchdog do loop ligado (15 s)` no boot. Se a tarefa de rede ficar 3 min
  sem dar sinal, a serial avisa `[wdt] tarefa de rede sem sinal` (no painel de parede, ele reinicia).

## Observações

- **Supabase:** o `iot-gateway` e o `notify-alert` são publicados com `--no-verify-jwt` (o ESP32 se autentica só pelo
  `x-device-key`; o `notify-alert` é chamado pelo webhook do banco). `smartthings-proxy` e `tuya-proxy` são publicados
  **sem** essa opção. Os secrets você grava com `publicar-funcoes.ps1 -DefinirSegredo [-OwnerId <uuid>]`: o
  `IOT_DEVICE_SECRET` é digitado duas vezes sem aparecer (`Read-Host -AsSecureString`) e vai para o Supabase CLI por um
  arquivo `.env` temporário (`supabase secrets set --env-file`), apagado em seguida — nunca na linha de comando nem no
  histórico. `IOT_OWNER_ID` é o uuid do usuário dono da casa (Supabase > Authentication > Users; não é segredo).
- **Chave no `testar-painel.ps1` sem aparecer:**
  `$env:NEXUS_DEVICE_KEY = (New-Object System.Net.NetworkCredential('', (Read-Host -AsSecureString 'chave'))).Password`
  (vale só para aquela janela).
- **`testar-painel.ps1 -VerComandos`** lê `/iot-gateway/commands`, que **consome** os comandos pendentes (a tela não os
  recebe mais). Use só para diagnóstico.
- **XY-MD02:** alguns lotes só passam a usar o endereço novo depois de desligar e ligar; se a conferência falhar, faça
  isso e confira com `testar-modbus.ps1 -Porta COM3 -Slave 80 -Funcao 3 -Registro 0x0101 -Quantidade 1`.
- **Quiosque:** o atalho fica em `shell:startup` e usa um perfil próprio do navegador
  (`%LOCALAPPDATA%\NexusHome\quiosque-perfil`). Para abrir sozinho depois de uma falta de energia, ative a entrada
  automática do usuário e a opção "ligar após falta de energia" na BIOS do mini PC.

## Testes (para quem mexe nos scripts)

```bash
pwsh -NoProfile -File scripts/testes/rodar-testes.ps1                    # sintaxe, compatibilidade 5.1 e funções puras
pwsh -NoProfile -File scripts/testes/rodar-testes.ps1 -Falsos <pasta>    # + integração com servidores falsos em Python
```

Sem Pester: o runner verifica a sintaxe de todos os `.ps1`, o BOM UTF-8 (necessário para os acentos no Windows
PowerShell 5.1), a ausência de recursos exclusivos do PowerShell 7 (`??`, `?:`, `&&`, `?.`, `-AsHashtable`, `$IsWindows`),
o CRC Modbus com vetores conhecidos, o MBAP, a interpretação do PZEM, a cópia do firmware preservando linhas (com o
`.ino.bak` sem segredos e a migração de Documentos), o corpo do `/panel/command` (alarme como texto), o arquivo `.env`
dos secrets, e roda os
scripts de verdade contra um gateway Modbus TCP falso, um iot-gateway HTTP falso e portas seriais falsas (pty).
Os servidores falsos (`falso_modbus_tcp.py`, `falso_http.py`, `falso_serial.py`, `modbus_comum.py`) ficam fora do repositório.
