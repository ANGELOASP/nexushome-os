<#
.SYNOPSIS
  Instala o ambiente dos firmwares ESP32 do NexusHome (Arduino IDE/CLI, core 3.3.12, bibliotecas) e compila/grava um firmware.

.DESCRIPTION
  Pode rodar de novo quantas vezes quiser:
    1. instala a Arduino IDE 2 e o Arduino CLI (winget);
    2. instala o core da Espressif FIXO em esp32:esp32@3.3.12 e as bibliotecas
       ESP32_Display_Panel 1.0.4, lvgl 8.4.0 e ArduinoJson 7.4.2;
    3. copia o firmware para Documentos\Arduino\<firmware> (fora do repositório — é lá que ficam a senha
       do Wi-Fi e a chave). Se já existir uma cópia, ela é ATUALIZADA e as linhas WIFI_SSID / WIFI_PASSWORD /
       DEVICE_SECRET que você preencheu são mantidas (no painel também PAINEL_MODO / PAINEL_COMODO /
       PAINEL_PLACA). Backup em <firmware>.ino.bak;
    4. compila com o FQBN da placa certa;
    5. (opcional) grava na placa: informe a porta com -Porta COM5.

  Firmwares e placas:
    hidraulica | eletrica | seguranca | nobreak -> telas T1..T4, ESP32-S3-Touch-LCD-4.3B
    painel -Placa p4    -> corredor, ESP32-P4-NANO + tela 10,1"
    painel -Placa s3-7  -> cômodos, ESP32-S3-Touch-LCD-7
  Só para Windows (usa winget). Nunca mostra a senha do Wi-Fi nem a chave.

.PARAMETER Porta
  Porta COM da placa (ex.: COM5). Sem ela, só compila.

.PARAMETER Firmware
  hidraulica (padrão), eletrica, seguranca, nobreak ou painel.

.PARAMETER Placa
  Só para -Firmware painel: p4 (corredor) ou s3-7 (cômodos).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1
  Instala tudo e compila o firmware da hidráulica.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware eletrica -Porta COM5
  Compila e grava o firmware elétrico na tela T2 ligada na COM5.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1 -Firmware painel -Placa s3-7 -Porta COM7
  Tela de 7" de um cômodo (confira PAINEL_COMODO no .ino em Documentos\Arduino\nexus_painel).
#>
[CmdletBinding()]
param(
  [ValidatePattern('^(COM\d{1,3}|/dev/\S+)?$')][string]$Porta = '',
  [ValidateSet('hidraulica', 'eletrica', 'seguranca', 'nobreak', 'painel')][string]$Firmware = 'hidraulica',
  [ValidateSet('p4', 's3-7')][string]$Placa = ''
)

Set-StrictMode -Version 2
# 'Continue': no Windows PowerShell 5.1, 'Stop' transforma qualquer aviso de um .exe em erro fatal.
# Os erros reais são checados pelo código de saída de cada programa.
$ErrorActionPreference = 'Continue'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

function Passo([int]$n, [string]$txt) { Write-Host "`n[$n/5] $txt" -ForegroundColor Cyan }
function Falha([string]$txt) { Write-NexusErro $txt; exit 1 }
function Atualiza-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Test-NexusWindows)) {
  Falha 'este instalador é só para Windows (usa winget). No Linux/macOS instale o arduino-cli e use scripts/gravar-firmware.ps1.'
}

try { $fw = Get-NexusFirmware -Firmware $Firmware -Placa $Placa } catch { Falha $_.Exception.Message }
$repo      = Split-Path -Parent $PSScriptRoot
$origem    = Join-Path $repo "firmware\$($fw.Nome)"
$sketchDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "Arduino\$($fw.Nome)"
$espUrl    = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'

if (-not (Test-Path -LiteralPath (Join-Path $origem "$($fw.Nome).ino"))) {
  Falha "o firmware $($fw.Nome) não está em $origem. Atualize o repositório (git pull) e rode de novo."
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Falha 'winget não encontrado. Instale o "Instalador de Aplicativo" pela Microsoft Store e rode de novo.'
}

# ---- 1. Arduino IDE + CLI ----
Passo 1 'Instalando Arduino IDE 2 e Arduino CLI (pode pedir confirmação do Windows)...'
foreach ($id in 'ArduinoSA.IDE.stable', 'ArduinoSA.CLI') {
  winget list --id $id -e --accept-source-agreements | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "  $id já instalado" }
  else {
    winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Falha "falha ao instalar $id (código $LASTEXITCODE)" }
  }
}
Atualiza-Path
$cli = Find-ArduinoCli
if (-not $cli) {
  Falha 'arduino-cli instalado, mas não encontrado. Feche e reabra o PowerShell e rode o script de novo.'
}
Write-Host "  arduino-cli: $cli"

# ---- 2. Core ESP32 (versão fixa) + bibliotecas ----
Passo 2 "Instalando o core $script:NexusCoreEsp32 (download grande, ~10 min na primeira vez)..."
& $cli config init 2>&1 | Out-Null     # cria a configuração se ainda não existe (erro "já existe" é normal)
& $cli config set board_manager.additional_urls $espUrl | Out-Null
& $cli core update-index
if ($LASTEXITCODE -ne 0) { Falha 'falha ao atualizar o índice de placas (internet?)' }
& $cli core install $script:NexusCoreEsp32
if ($LASTEXITCODE -ne 0) { Falha "falha ao instalar o core $script:NexusCoreEsp32" }
& $cli lib update-index | Out-Null
$libs = @($script:NexusBibliotecas)
& $cli lib install @libs
if ($LASTEXITCODE -ne 0) { Falha "falha ao instalar as bibliotecas ($($script:NexusBibliotecas -join ', '))" }

# ---- 3. Cópia do firmware (sem sobrescrever a sua versão com senha) ----
Passo 3 "Copiando o firmware para $sketchDir ..."
try { $copia = Copy-NexusFirmware -Origem $origem -Destino $sketchDir -Nome $fw.Nome -Preservar $fw.Preservar }
catch { Falha $_.Exception.Message }
if (@($copia.Preservadas).Count -gt 0) {
  Write-Host "  atualizado; linhas mantidas: $(@($copia.Preservadas) -join ', '). Cópia anterior: $($fw.Nome).ino.bak"
} else {
  Write-NexusAviso '  copiado. Preencha WIFI_SSID, WIFI_PASSWORD e DEVICE_SECRET no .ino antes de gravar na placa.'
}
$pend = @(Get-NexusPendencias -Ino $copia.Ino)
if ($pend.Count -gt 0) { Write-NexusAviso "  ainda com valor de exemplo: $($pend -join ', ') (edite $($copia.Ino))" }
if ($fw.Firmware -eq 'painel') {
  $pp = Get-NexusLinhaDefine -Ino $copia.Ino -Nome 'PAINEL_PLACA'
  $pc = Get-NexusLinhaDefine -Ino $copia.Ino -Nome 'PAINEL_COMODO'
  Write-Host "  PAINEL_PLACA = $pp ; PAINEL_COMODO = $pc"
  if ($pp -and (($Placa -eq 'p4' -and $pp -notmatch 'P4') -or ($Placa -eq 's3-7' -and $pp -notmatch 'S3'))) {
    Write-NexusAviso "  ATENÇÃO: PAINEL_PLACA ($pp) não combina com -Placa $Placa. Ajuste o .ino antes de gravar."
  }
}

# ---- 4. Compilação ----
Passo 4 "Compilando para $($fw.Descricao)..."
& $cli compile --fqbn $fw.Fqbn $sketchDir
if ($LASTEXITCODE -ne 0) { Falha 'a compilação falhou — mande o texto acima para análise.' }

Passo 5 'Gravação na placa'
if ($Porta) {
  & $cli upload -p $Porta --fqbn $fw.Fqbn $sketchDir
  if ($LASTEXITCODE -ne 0) { Falha "falha ao gravar em $Porta (cabo USB-C na porta USB da placa? porta certa? Monitor Serial fechado?)" }
  Write-Host "  gravado em $Porta. Monitor serial: powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta $Porta"
} else {
  Write-Host '  pulado (sem -Porta). Com a placa no USB, veja a porta com: scripts\monitor-serial.ps1 -Listar'
}

Write-NexusOk "`nTudo pronto!"
Write-Host "Firmware em $sketchDir"
exit 0
