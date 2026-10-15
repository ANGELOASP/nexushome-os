<#
.SYNOPSIS
  Compila (e grava, se você informar a porta) qualquer firmware do NexusHome com o FQBN certo da placa.

.DESCRIPTION
  Usa o arduino-cli (procura no PATH, na instalação do winget e na Arduino IDE 2).
  Qual pasta compila:
    -Pasta informada                      -> essa pasta;
    senão Documentos\Arduino\<firmware>   -> a sua cópia com Wi-Fi e chave (criada pelo instalar-arduino.ps1);
    senão firmware\<firmware> do repositório (só para testar a compilação: está com os valores de exemplo).
  -Atualizar recopia o firmware do repositório para Documentos\Arduino mantendo as linhas preenchidas
  (WIFI_SSID, WIFI_PASSWORD, DEVICE_SECRET e, no painel, PAINEL_MODO / PAINEL_COMODO / PAINEL_PLACA).
  No fim mostra o tamanho usado de flash e de RAM. Nunca mostra a senha do Wi-Fi nem a chave.

  Placas:
    hidraulica | eletrica | seguranca | nobreak -> ESP32-S3-Touch-LCD-4.3B
    painel -Placa p4   -> ESP32-P4-NANO + 10,1" (corredor)
    painel -Placa s3-7 -> ESP32-S3-Touch-LCD-7 (cômodos)

.PARAMETER Firmware
  hidraulica, eletrica, seguranca, nobreak ou painel.

.PARAMETER Placa
  Só para o painel: p4 ou s3-7.

.PARAMETER Porta
  Porta da placa (ex.: COM5). Sem ela, só compila.

.PARAMETER SoCompilar
  Só compila, mesmo com -Porta.

.PARAMETER Pasta
  Pasta do sketch a compilar (o .ino precisa ter o mesmo nome da pasta).

.PARAMETER Atualizar
  Recopia do repositório para Documentos\Arduino antes de compilar (mantém Wi-Fi/chave/painel).

.PARAMETER Sim
  Não pergunta nada (grava mesmo com Wi-Fi/chave ainda no valor de exemplo).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\gravar-firmware.ps1 -Firmware eletrica -SoCompilar

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\gravar-firmware.ps1 -Firmware seguranca -Porta COM6

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\gravar-firmware.ps1 -Firmware painel -Placa p4 -Atualizar -Porta COM9
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('hidraulica', 'eletrica', 'seguranca', 'nobreak', 'painel')][string]$Firmware,
  [ValidateSet('p4', 's3-7')][string]$Placa = '',
  [ValidatePattern('^(COM\d{1,3}|/dev/\S+)$')][string]$Porta = '',
  [switch]$SoCompilar,
  [string]$Pasta = '',
  [switch]$Atualizar,
  [switch]$Sim
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

try {
  $fw = Get-NexusFirmware -Firmware $Firmware -Placa $Placa
  $repo = Split-Path -Parent $PSScriptRoot
  $noRepo = Join-Path (Join-Path $repo 'firmware') $fw.Nome
  $docs = [Environment]::GetFolderPath('MyDocuments')
  $naCopia = ''
  if ($docs) { $naCopia = Join-Path (Join-Path $docs 'Arduino') $fw.Nome }

  $cli = Find-ArduinoCli
  if (-not $cli) {
    throw ('arduino-cli não encontrado. Rode primeiro: powershell -ExecutionPolicy Bypass -File scripts\instalar-arduino.ps1' +
           ' (ou winget install ArduinoSA.CLI e reabra o PowerShell).')
  }

  # ---- qual pasta compilar ----
  if ($Atualizar) {
    if ($Pasta) { throw 'use -Atualizar OU -Pasta, não os dois.' }
    if (-not $naCopia) { throw 'não achei a pasta Documentos deste usuário.' }
    Write-NexusPasso "Atualizando $naCopia a partir do repositório..."
    $c = Copy-NexusFirmware -Origem $noRepo -Destino $naCopia -Nome $fw.Nome -Preservar $fw.Preservar
    if (@($c.Preservadas).Count -gt 0) { Write-Host "  linhas mantidas: $(@($c.Preservadas) -join ', ') (backup em $($fw.Nome).ino.bak)" }
    else { Write-NexusAviso '  cópia nova: preencha WIFI_SSID, WIFI_PASSWORD e DEVICE_SECRET no .ino.' }
    $sketch = $naCopia
  } elseif ($Pasta) {
    $sketch = (Resolve-Path -LiteralPath $Pasta -ErrorAction SilentlyContinue)
    if (-not $sketch) { throw "a pasta $Pasta não existe." }
    $sketch = "$sketch"
  } elseif ($naCopia -and (Test-Path -LiteralPath (Join-Path $naCopia "$($fw.Nome).ino"))) {
    $sketch = $naCopia
  } else {
    $sketch = $noRepo
    if (-not (Test-Path -LiteralPath (Join-Path $sketch "$($fw.Nome).ino"))) {
      throw "o firmware $($fw.Nome) não está em $noRepo. Atualize o repositório (git pull)."
    }
    Write-NexusAviso "Usando a pasta do repositório (sem Wi-Fi/chave). Para a sua cópia: -Atualizar ou scripts\instalar-arduino.ps1."
  }
  $nomeIno = (Split-Path -Leaf $sketch) + '.ino'
  $ino = Join-Path $sketch $nomeIno
  if (-not (Test-Path -LiteralPath $ino)) { throw "não achei $nomeIno em $sketch (o .ino precisa ter o nome da pasta)." }

  Write-NexusPasso "Compilando $($fw.Nome) para $($fw.Descricao)"
  Write-Host "  pasta: $sketch"
  Write-Host "  FQBN:  $($fw.Fqbn)"
  if ($fw.Firmware -eq 'painel') {
    $pp = Get-NexusLinhaDefine -Ino $ino -Nome 'PAINEL_PLACA'
    if ($pp) {
      Write-Host "  PAINEL_PLACA = $pp ; PAINEL_MODO = $(Get-NexusLinhaDefine -Ino $ino -Nome 'PAINEL_MODO') ; PAINEL_COMODO = $(Get-NexusLinhaDefine -Ino $ino -Nome 'PAINEL_COMODO')"
      if (($Placa -eq 'p4' -and $pp -notmatch 'P4') -or ($Placa -eq 's3-7' -and $pp -notmatch 'S3')) {
        Write-NexusAviso "  ATENÇÃO: PAINEL_PLACA ($pp) não combina com -Placa $Placa."
      }
    }
  }

  $r = Invoke-NexusNativo -Exe $cli -Argumentos @('compile', '--fqbn', $fw.Fqbn, $sketch)
  if ($r.Codigo -ne 0) { throw "a compilação falhou (código $($r.Codigo)). Mande o texto acima para análise." }

  $t = Get-ArduinoTamanho -Texto $r.Saida
  Write-NexusPasso 'Tamanho'
  if ($t) {
    if ($null -ne $t.FlashBytes) { Write-Host "  Flash (programa): $(Format-NexusBytes $t.FlashBytes) de $(Format-NexusBytes $t.FlashMax) ($($t.FlashPct)%)" }
    if ($null -ne $t.RamBytes)   { Write-Host "  RAM (variáveis):  $(Format-NexusBytes $t.RamBytes) de $(Format-NexusBytes $t.RamMax) ($($t.RamPct)%)" }
    if ($null -ne $t.FlashPct -and $t.FlashPct -ge 90) { Write-NexusAviso '  quase sem espaço na partição do programa!' }
  } else {
    Write-Host '  (o arduino-cli não informou o tamanho)'
  }

  if (-not $Porta -or $SoCompilar) {
    if ($Porta) { Write-Host "`n-SoCompilar: não gravei em $Porta." }
    Write-NexusOk "`nCompilado com sucesso."
    exit 0
  }

  $pend = @(Get-NexusPendencias -Ino $ino)
  if ($pend.Count -gt 0) {
    Write-NexusAviso "`nAinda com valor de exemplo: $($pend -join ', '). A placa não vai entrar no Wi-Fi/servidor (a proteção local funciona)."
    if (-not $Sim -and -not (Confirm-Nexus 'Gravar assim mesmo?')) { Write-Host 'Cancelado.'; exit 1 }
  }

  Write-NexusPasso "Gravando em $Porta..."
  $u = Invoke-NexusNativo -Exe $cli -Argumentos @('upload', '-p', $Porta, '--fqbn', $fw.Fqbn, $sketch)
  if ($u.Codigo -ne 0) {
    throw "falha ao gravar em $Porta. Cabo USB-C na porta USB da placa? Porta certa (scripts\monitor-serial.ps1 -Listar)? Monitor Serial fechado? Se travar, segure BOOT, aperte RESET e solte BOOT."
  }
  Write-NexusOk "`nGravado em $Porta."
  Write-Host "Monitor serial: powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta $Porta"
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}
