# ============================================================
# NexusHome OS — instala o ambiente do firmware ESP32-S3 (Windows)
# ------------------------------------------------------------
# O que faz (pode rodar de novo quantas vezes quiser):
#   1. instala a Arduino IDE 2 e o Arduino CLI (winget)
#   2. instala o suporte ao ESP32 (Espressif, core 3.x)
#   3. copia o firmware para Documentos\Arduino\esp32s3_hidraulica
#      (fora do repositório — é lá que você põe a senha do Wi-Fi e a chave)
#   4. compila o firmware para a placa ESP32-S3 (8 MB, PSRAM OPI)
#
# Como rodar (PowerShell, dentro de C:\nexushome-os):
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1
# ============================================================

# 'Continue': no Windows PowerShell 5.1, 'Stop' transforma qualquer aviso de um .exe em erro fatal.
# Os erros reais são checados por $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$repo      = Split-Path -Parent $PSScriptRoot
$origem    = Join-Path $repo 'firmware\esp32s3_hidraulica'
$sketchDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Arduino\esp32s3_hidraulica'
$espUrl    = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
$fqbn      = 'esp32:esp32:esp32s3:FlashSize=8M,PSRAM=opi'

function Passo($n, $txt) { Write-Host "`n[$n/4] $txt" -ForegroundColor Cyan }
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

# ---- 3. Cópia do firmware (sem sobrescrever a sua versão com senha) ----
Passo 3 "Copiando o firmware para $sketchDir ..."
if (Test-Path (Join-Path $sketchDir 'esp32s3_hidraulica.ino')) {
  Write-Host '  já existe uma cópia — mantida (ela pode ter sua senha do Wi-Fi). Para atualizar, apague a pasta e rode de novo.' -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Force -Path $sketchDir | Out-Null
  Copy-Item -Path (Join-Path $origem '*') -Destination $sketchDir -Recurse -Force
  Write-Host '  copiado.'
}

# ---- 4. Compilação ----
Passo 4 'Compilando para ESP32-S3 (8 MB / PSRAM OPI)...'
arduino-cli compile --fqbn $fqbn $sketchDir
if ($LASTEXITCODE -ne 0) { throw 'A compilação falhou — mande o texto acima para análise.' }

Write-Host "`nTudo pronto!" -ForegroundColor Green
Write-Host "Próximo passo: abra $sketchDir\esp32s3_hidraulica.ino na Arduino IDE e preencha"
Write-Host "WIFI_SSID, WIFI_PASSWORD e DEVICE_SECRET (a chave da Etapa 2)."
