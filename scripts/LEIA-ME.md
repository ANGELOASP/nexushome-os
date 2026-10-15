# Scripts do NexusHome OS (Windows PowerShell 5.1 ou PowerShell 7)

Os scripts rodam no PC com Windows. Abra o PowerShell **dentro da pasta do repositório** (ex.: `C:\nexushome-os`)
e chame cada um com `powershell -ExecutionPolicy Bypass -File scripts\<script>.ps1 ...`. O `-ExecutionPolicy Bypass`
vale só para aquela execução e não muda nada no Windows.

- Mantenha a pasta `scripts\` inteira: todos usam `scripts\nexus-comum.ps1` (funções comuns; não é para rodar sozinho).
- Ajuda completa de qualquer script: `Get-Help scripts\<script>.ps1 -Detailed` (ou `-?`).
- Código de saída: **0** deu certo, **1** falhou (a mensagem em vermelho diz o motivo).
- Nenhum script pede para colar segredos em chat. A chave do dispositivo só é digitada no seu terminal (sem aparecer)
  ou lida da variável `NEXUS_DEVICE_KEY`, e nunca é mostrada.

| Script | Para quê | Exemplo |
|---|---|---|
| `instalar-arduino.ps1` | Instala Arduino IDE 2 + CLI (winget), o core **esp32:esp32@3.3.12** e as bibliotecas ESP32_Display_Panel 1.0.4, lvgl 8.4.0 e ArduinoJson 7.4.2; copia o firmware para `Documentos\Arduino\` mantendo Wi-Fi/chave (e, no painel, `PAINEL_MODO`/`PAINEL_COMODO`/`PAINEL_PLACA`); compila e grava | `powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware eletrica -Porta COM5` |
| `gravar-firmware.ps1` | Compila (e grava com `-Porta`) qualquer firmware com o FQBN certo; mostra flash/RAM usados; `-SoCompilar` para testar; `-Atualizar` recopia do repositório mantendo as suas linhas | `powershell -ExecutionPolicy Bypass -File scripts\gravar-firmware.ps1 -Firmware painel -Placa p4 -Porta COM9` |
| `monitor-serial.ps1` | Lista as portas COM (com descrição), abre o monitor 115200 (digite e Enter; Ctrl+C sai) ou manda um comando e mostra a resposta | `powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta COM5 -Comando scan -Segundos 10` |
| `enderecar-modbus.ps1` | Grava o endereço Modbus de **um** aparelho no adaptador USB-RS485 (PZEM-016/017, relé Waveshare, XY-MD02) e confere lendo de volta; `-WhatIf` só mostra os quadros | `powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo pzem016 -Novo 7 -Geral` |
| `testar-modbus.ps1` | Lê registradores pelo gateway (Modbus TCP, porta 502) ou pelo adaptador (RTU); `-Pzem` / `-Pzem017` mostram V, A, W, Wh... | `powershell -ExecutionPolicy Bypass -File scripts\testar-modbus.ps1 -Ip 192.168.1.200 -Slave 7 -Pzem` |
| `quiosque-nexushome.ps1` | Abre o NexusHome em tela cheia (Edge/Chrome em modo quiosque) quando o Windows inicia; `-Monitor 2`; desliga o apagamento da tela (com confirmação); `-Remover` desfaz; `-Testar` abre agora | `powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar -Monitor 2` |
| `publicar-funcoes.ps1` | Publica `iot-gateway` e `notify-alert` (ou `-Todas`) no projeto `gfjxcsvxhaojbtuixpjh` pelo Supabase CLI; confere instalação e login; não pede segredos | `powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1` |
| `testar-painel.ps1` | Confere `/iot-gateway/health` e `/panel` (resumo: energia, água, bateria, alertas, aparelhos) e, opcionalmente, manda um comando (`/panel/command`, com confirmação) | `powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1 -Comodo Cozinha` |

## Firmwares e placas

| `-Firmware` | Pasta | Placa | FQBN |
|---|---|---|---|
| `hidraulica`, `eletrica`, `seguranca`, `nobreak` | `firmware\esp32s3_<nome>` | ESP32-S3-Touch-LCD-4.3B (T1–T4) | `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc` |
| `painel -Placa p4` | `firmware\nexus_painel` | ESP32-P4-NANO + 10,1" (corredor) | `esp32:esp32:esp32p4:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled` |
| `painel -Placa s3-7` | `firmware\nexus_painel` | ESP32-S3-Touch-LCD-7 (cômodos) | o mesmo da 4.3B |

As telas de 7" usam a mesma cópia `Documentos\Arduino\nexus_painel`: troque `PAINEL_COMODO` no `.ino` antes de gravar
cada cômodo.

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
powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1
powershell -ExecutionPolicy Bypass -File scripts\testar-painel.ps1
powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar
```

## Observações

- **Supabase:** o `iot-gateway` e o `notify-alert` são publicados com `--no-verify-jwt` (o ESP32 se autentica só pelo
  `x-device-key`; o `notify-alert` é chamado pelo webhook do banco). `smartthings-proxy` e `tuya-proxy` são publicados
  **sem** essa opção. O segredo você configura digitando no seu terminal:
  `supabase secrets set IOT_DEVICE_SECRET=<seu-segredo> --project-ref gfjxcsvxhaojbtuixpjh`.
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
o CRC Modbus com vetores conhecidos, o MBAP, a interpretação do PZEM, a cópia do firmware preservando linhas, e roda os
scripts de verdade contra um gateway Modbus TCP falso, um iot-gateway HTTP falso e portas seriais falsas (pty).
Os servidores falsos (`falso_modbus_tcp.py`, `falso_http.py`, `falso_serial.py`, `modbus_comum.py`) ficam fora do repositório.
