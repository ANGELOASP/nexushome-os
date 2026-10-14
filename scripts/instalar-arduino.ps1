# ============================================================
# NexusHome OS — instala o ambiente do firmware ESP32-S3 (Windows)
# ------------------------------------------------------------
# O que faz (pode rodar de novo quantas vezes quiser):
#   1. instala a Arduino IDE 2 e o Arduino CLI (winget)
#   2. instala o suporte ao ESP32 (Espressif, core 3.x) e as bibliotecas da tela
#      (ESP32_Display_Panel 1.0.4 + lvgl 8.4.0)
#   3. copia o firmware para Documentos\Arduino\esp32s3_hidraulica (ou esp32s3_eletrica)
#      (fora do repositório — é lá que ficam a senha do Wi-Fi e a chave). Se já existir
#      uma cópia, ela é ATUALIZADA e as linhas WIFI_SSID / WIFI_PASSWORD / DEVICE_SECRET
#      que você preencheu são mantidas (backup em <firmware>.ino.bak)
#   4. compila para a ESP32-S3-Touch-LCD-4.3B (16 MB, PSRAM OPI, USB CDC)
#   5. (opcional) grava na placa: informe a porta com -Porta COM5
#
# Como rodar (PowerShell, dentro de C:\nexushome-os):
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Porta COM5   # compila e grava
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware eletrica -Porta COM6
#     (v2.11: automação elétrica — PZEM-016 + relés dos subquadros, em OUTRA placa)
# ============================================================

param([string]$Porta = '', [ValidateSet('hidraulica', 'eletrica')][string]$Firmware = 'hidraulica')

# 'Continue': no Windows PowerShell 5.1, 'Stop' transforma qualquer aviso de um .exe em erro fatal.
# Os erros reais são checados por $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$repo      = Split-Path -Parent $PSScriptRoot
$nome      = "esp32s3_$Firmware"
$origem    = Join-Path $repo "firmware\$nome"
$sketchDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "Arduino\$nome"
$espUrl    = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
$fqbn      = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc'

function Passo($n, $txt) { Write-Host "`n[$n/5] $txt" -ForegroundColor Cyan }
function Atualiza-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Host 'winget não encontrado. Instale o "Instalador de Aplicativo" pela Microsoft Store e rode de novo.' -ForegroundColor Red
  exit 1
}

# ---- 1. Arduino IDE + CLI ----
Passo 1 'Instalando Arduino IDE 2 e Arduino CLI (pode pedir confirmação do Windows)...'
foreach ($id in 'ArduinoSA.IDE.stable', 'ArduinoSA.CLI') {
  winget list --id $id -e --accept-source-agreements | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "  $id já instalado" }
  else {
    winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar $id (código $LASTEXITCODE)" }
  }
}
Atualiza-Path
if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
  throw 'arduino-cli instalado, mas não está no PATH. Feche e reabra o PowerShell e rode o script de novo.'
}

# ---- 2. Core ESP32 ----
Passo 2 'Instalando o suporte ao ESP32 (download grande, ~10 min na primeira vez)...'
arduino-cli config set board_manager.additional_urls $espUrl | Out-Null   # cria a configuração se ainda não existe
arduino-cli core update-index
if ($LASTEXITCODE -ne 0) { throw 'Falha ao atualizar o índice de placas' }
arduino-cli core install esp32:esp32
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar o core esp32:esp32' }
arduino-cli lib update-index | Out-Null
arduino-cli lib install 'ESP32_Display_Panel@1.0.4' 'lvgl@8.4.0'
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar as bibliotecas da tela (ESP32_Display_Panel / lvgl)' }

# ---- 3. Cópia do firmware (sem sobrescrever a sua versão com senha) ----
Passo 3 "Copiando o firmware para $sketchDir ..."
$ino = Join-Path $sketchDir "$nome.ino"
$segredos = @{}
if (Test-Path $ino) {
  # guarda as linhas que você preencheu antes de atualizar os arquivos
  foreach ($linha in Get-Content $ino -Encoding UTF8) {
    if ($linha -match '^\s*#define\s+(WIFI_SSID|WIFI_PASSWORD|DEVICE_SECRET)\s+".*"') { $segredos[$Matches[1]] = $linha }
  }
  Copy-Item $ino "$ino.bak" -Force
}
New-Item -ItemType Directory -Force -Path $sketchDir | Out-Null
Copy-Item -Path (Join-Path $origem '*') -Destination $sketchDir -Recurse -Force
if ($segredos.Count) {
  $novo = foreach ($linha in Get-Content $ino -Encoding UTF8) {
    if ($linha -match '^\s*#define\s+(WIFI_SSID|WIFI_PASSWORD|DEVICE_SECRET)\s' -and $segredos.ContainsKey($Matches[1])) { $segredos[$Matches[1]] } else { $linha }
  }
  [IO.File]::WriteAllLines($ino, $novo, (New-Object Text.UTF8Encoding $false))
  Write-Host "  atualizado; Wi-Fi e chave mantidos ($($segredos.Count) de 3 linhas). Cópia anterior: $nome.ino.bak"
} else {
  Write-Host '  copiado. Preencha WIFI_SSID, WIFI_PASSWORD e DEVICE_SECRET antes de gravar na placa.' -ForegroundColor Yellow
}

# ---- 4. Compilação ----
Passo 4 'Compilando para ESP32-S3-Touch-LCD-4.3B (16 MB / PSRAM OPI)...'
arduino-cli compile --fqbn $fqbn $sketchDir
if ($LASTEXITCODE -ne 0) { throw 'A compilação falhou — mande o texto acima para análise.' }

Passo 5 'Gravação na placa'
if ($Porta) {
  arduino-cli upload -p $Porta --fqbn $fqbn $sketchDir
  if ($LASTEXITCODE -ne 0) { throw "Falha ao gravar em $Porta (cabo USB-C na porta USB da placa? porta certa?)" }
  Write-Host "  gravado em $Porta. Monitor serial: arduino-cli monitor -p $Porta -c baudrate=115200"
} else {
  Write-Host '  pulado (sem -Porta). Com a placa no USB, veja a porta com: arduino-cli board list'
}

Write-Host "`nTudo pronto!" -ForegroundColor Green
Write-Host "Firmware em $sketchDir"
