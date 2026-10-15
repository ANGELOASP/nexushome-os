<#
.SYNOPSIS
  Grava o endereço Modbus de UM aparelho ligado ao PC por adaptador USB-RS485 (PZEM-016/017, relé Waveshare, XY-MD02).

.DESCRIPTION
  Ligue SÓ UM aparelho no adaptador (24 V/5 V + A/B), porque o pedido pode ir para o endereço "geral".
  Monta o quadro Modbus RTU (função 06, CRC16), envia, confere o eco e depois LÊ DE VOLTA o endereço
  no endereço novo (função 03) para confirmar.

    Tipo        Registro  Formato  Endereço geral (-Geral)
    pzem016     0x0002    8N1      0xF8 (responde qualquer PZEM)
    pzem017     0x0002    8N2      0xF8
    waveshare   0x4000    8N1      0x00 (broadcast)
    xymd02      0x0101    8N1      (não tem: use -Atual)

  Sem -Geral, o pedido vai para -Atual (de fábrica todos saem com 1).
  Endereços do projeto: docs/projeto-unificado.md §5.2. Escreva o endereço com caneta no aparelho.
  -WhatIf só mostra os quadros, sem abrir a porta.

.PARAMETER Porta
  Porta do adaptador USB-RS485 (COM3; no Linux /dev/ttyUSB0).

.PARAMETER Tipo
  pzem016, pzem017, waveshare ou xymd02.

.PARAMETER Novo
  Endereço novo (1 a 247).

.PARAMETER Atual
  Endereço atual (padrão 1).

.PARAMETER Geral
  Usa o endereço geral (0xF8 no PZEM, 0x00 na Waveshare) em vez de -Atual.

.PARAMETER Baud
  Velocidade (padrão 9600, a de fábrica de todos).

.PARAMETER Sim
  Não pergunta "só um aparelho ligado?".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo pzem016 -Novo 7 -Geral

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo waveshare -Novo 5

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\enderecar-modbus.ps1 -Porta COM3 -Tipo xymd02 -Novo 80 -Atual 1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^(COM\d{1,3}|/dev/\S+)$')][string]$Porta,
  [Parameter(Mandatory = $true)][ValidateSet('pzem016', 'pzem017', 'waveshare', 'xymd02')][string]$Tipo,
  [Parameter(Mandatory = $true)][ValidateRange(1, 247)][int]$Novo,
  [ValidateRange(1, 247)][int]$Atual = 1,
  [switch]$Geral,
  [ValidateSet(2400, 4800, 9600, 19200, 38400, 57600, 115200)][int]$Baud = 9600,
  [ValidateRange(100, 10000)][int]$TimeoutMs = 1000,
  [switch]$Sim
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

try {
  $info = Get-NexusEnderecoInfo -Tipo $Tipo
  if ($Geral) {
    if ($info.Geral -lt 0) { throw "o $($info.Nome) não tem endereço geral. Use -Atual (de fábrica é 1)." }
    if ($PSBoundParameters.ContainsKey('Atual')) { Write-NexusAviso "-Geral ligado: -Atual $Atual ignorado." }
    $origem = [int]$info.Geral
  } else {
    $origem = $Atual
    if ($origem -eq $Novo) { Write-NexusOk "O aparelho já está no endereço $Novo. Nada a fazer."; exit 0 }
  }

  $gravar = New-ModbusFrame -Slave $origem -Funcao 6 -Registro $info.Registro -Valor $Novo
  $ler    = New-ModbusFrame -Slave $Novo -Funcao 3 -Registro $info.Registro -Valor 1

  Write-Host ("{0}: endereço {1} -> {2}  (registro 0x{3:X4}, {4} baud {5})" -f $info.Nome, ('0x{0:X2} ({0})' -f $origem), $Novo, $info.Registro, $Baud, $info.Formato)
  Write-Host "  gravar:    $(Format-NexusHex $gravar)"
  Write-Host "  conferir:  $(Format-NexusHex $ler)"

  if (-not $PSCmdlet.ShouldProcess("$($info.Nome) em $Porta", "gravar o endereço $Novo")) { exit 0 }

  if (-not $Sim) {
    if (-not (Confirm-Nexus "Só UM aparelho está ligado no adaptador ${Porta}?")) {
      Write-Host 'Cancelado. Desligue os outros aparelhos do adaptador e rode de novo.'
      exit 1
    }
  }

  $sp = Open-NexusSerial -Porta $Porta -Baud $Baud -Formato $info.Formato -TimeoutMs $TimeoutMs
  try {
    Write-NexusPasso 'Gravando...'
    $resp = Invoke-ModbusRtu -Serial $sp -Pedido $gravar -TimeoutMs $TimeoutMs
    if ($resp.Length -eq 0) {
      if ($origem -eq 0) { Write-Host '  (broadcast: sem resposta é normal; vou conferir lendo de volta)' }
      else { throw "sem resposta do endereço $origem. Confira: A/B (troque se preciso), alimentação do aparelho, -Atual certo (ou -Geral), $Baud baud $($info.Formato)." }
    } else {
      $ok = Test-ModbusResponse -Pedido $gravar -Resposta $resp
      if (-not $ok.Ok) { throw "resposta inesperada à gravação: $($ok.Mensagem)" }
      Write-Host "  eco recebido: $(Format-NexusHex $resp)"
    }

    Start-Sleep -Milliseconds 300
    Write-NexusPasso "Conferindo no endereço $Novo..."
    $resp2 = Invoke-ModbusRtu -Serial $sp -Pedido $ler -TimeoutMs $TimeoutMs
    $ok2 = Test-ModbusResponse -Pedido $ler -Resposta $resp2
    if (-not $ok2.Ok) {
      $dica = ''
      if ($Tipo -eq 'xymd02') { $dica = ' O XY-MD02 só passa a usar o endereço novo depois de desligar e ligar: faça isso e confira com scripts\testar-modbus.ps1 -Porta ' + $Porta + " -Slave $Novo -Funcao 3 -Registro 0x0101 -Quantidade 1." }
      throw "não consegui confirmar: $($ok2.Mensagem).$dica"
    }
    $lido = [int]$ok2.Registros[0]
    if ($Tipo -eq 'waveshare') { $lido = $lido -band 0xFF }
    if ($lido -ne $Novo) { throw "o aparelho respondeu no $Novo, mas o registro diz $lido." }
  } finally { $sp.Close() }

  Write-NexusOk "`nEndereço $Novo gravado e confirmado no $($info.Nome)."
  Write-Host 'Escreva o endereço com caneta no aparelho e ligue o próximo.'
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}
