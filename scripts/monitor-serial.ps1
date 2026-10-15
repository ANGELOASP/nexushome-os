<#
.SYNOPSIS
  Monitor serial das telas do NexusHome: lista as portas, abre o monitor (lê e escreve) ou manda um comando e mostra a resposta.

.DESCRIPTION
  -Listar             mostra as portas COM com a descrição do Windows (no Linux, /dev/ttyUSB* e /dev/ttyACM*).
  -Porta COMx         abre o monitor (115200 por padrão). Digite um comando e Enter para enviar
                      (ex.: status, scan, dump 7). Ctrl+C sai e fecha a porta.
                      Se a placa reiniciar (gravação, reset), o monitor tenta reconectar sozinho.
  -Comando "scan"     manda um comando, mostra a resposta por -Segundos (5) e sai. Código de saída 1 se nada chegou.
  Feche o Monitor Serial da Arduino IDE antes: a porta só abre em um programa por vez.

.PARAMETER Listar
  Lista as portas seriais.

.PARAMETER Porta
  Porta da placa: COM5 no Windows, /dev/ttyACM0 no Linux.

.PARAMETER Baud
  Velocidade (padrão 115200, a dos firmwares do NexusHome).

.PARAMETER Comando
  Comando a enviar (status, scan, dump N, pzemaddr N, reladdr N...).

.PARAMETER Segundos
  Por quanto tempo esperar a resposta do -Comando (1 a 120; padrão 5).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Listar

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta COM5

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\monitor-serial.ps1 -Porta COM5 -Comando scan -Segundos 10
#>
[CmdletBinding(DefaultParameterSetName = 'Listar')]
param(
  [Parameter(ParameterSetName = 'Listar')][switch]$Listar,
  [Parameter(Mandatory = $true, ParameterSetName = 'Monitor')]
  [Parameter(Mandatory = $true, ParameterSetName = 'Comando')]
  [ValidatePattern('^(COM\d{1,3}|/dev/\S+)$')][string]$Porta,
  [Parameter(ParameterSetName = 'Monitor')]
  [Parameter(ParameterSetName = 'Comando')]
  [ValidateSet(9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600)][int]$Baud = 115200,
  [Parameter(Mandatory = $true, ParameterSetName = 'Comando')][ValidateNotNullOrEmpty()][string]$Comando,
  [Parameter(ParameterSetName = 'Comando')][ValidateRange(1, 120)][int]$Segundos = 5
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

function Abrir([string]$p) { return (Open-NexusSerial -Porta $p -Baud $Baud -TimeoutMs 500 -Dtr) }

try {
  if ($PSCmdlet.ParameterSetName -eq 'Listar') {
    $portas = @(Get-NexusPortas)
    if ($portas.Count -eq 0) {
      Write-NexusAviso 'Nenhuma porta serial encontrada. Ligue a placa pelo USB-C (cabo de dados, não só de carga) e rode de novo.'
      exit 1
    }
    Write-Host 'Portas seriais:'
    foreach ($p in $portas) {
      $linha = "  $($p.Porta)"
      if ($p.Descricao) { $linha += "  — $($p.Descricao)" }
      if ($p.Dica) { $linha += "  [$($p.Dica)]" }
      Write-Host $linha
    }
    Write-Host "`nAbra o monitor com: scripts\monitor-serial.ps1 -Porta $($portas[0].Porta)"
    exit 0
  }

  if ($PSCmdlet.ParameterSetName -eq 'Comando') {
    $sp = Abrir $Porta
    try {
      Start-Sleep -Milliseconds 200
      try { $sp.DiscardInBuffer() } catch { }
      Write-Host "> $Comando" -ForegroundColor DarkGray
      $sp.Write("$Comando`n")
      $recebido = 0
      $fim = (Get-Date).AddSeconds($Segundos)
      while ((Get-Date) -lt $fim) {
        $txt = $sp.ReadExisting()
        if ($txt) { $recebido += $txt.Length; [Console]::Out.Write($txt) }
        else { Start-Sleep -Milliseconds 30 }
      }
      [Console]::Out.WriteLine()
    } finally { $sp.Close() }
    if ($recebido -eq 0) {
      Write-NexusAviso "Nada chegou em $Segundos s. Porta certa? Placa ligada? Baud ${Baud}? Outro programa usando a porta?"
      exit 1
    }
    exit 0
  }

  # ---- monitor interativo ----
  $redir = $false
  try { $redir = [Console]::IsInputRedirected } catch { }
  if ($redir) { throw 'o monitor interativo precisa de uma janela do PowerShell. Para usar em script, passe -Comando.' }

  $sp = Abrir $Porta
  Write-NexusOk "Monitor em $Porta ($Baud). Digite um comando + Enter (status, scan...). Ctrl+C sai."
  $antesCtrlC = [Console]::TreatControlCAsInput
  [Console]::TreatControlCAsInput = $true
  $digitado = ''
  try {
    :laco while ($true) {
      try {
        $txt = $sp.ReadExisting()
        if ($txt) { [Console]::Out.Write($txt) }
      } catch {
        Write-NexusAviso "`n[desconectado — a placa reiniciou? tentando reconectar... Ctrl+C sai]"
        try { $sp.Close() } catch { }
        $sp = $null
        while ($null -eq $sp) {
          if ([Console]::KeyAvailable) {
            $k = [Console]::ReadKey($true)
            if ($k.Key -eq [ConsoleKey]::C -and ($k.Modifiers -band [ConsoleModifiers]::Control)) { break laco }
          }
          Start-Sleep -Milliseconds 1000
          try { $sp = Abrir $Porta; Write-NexusOk '[reconectado]' } catch { $sp = $null }
        }
      }
      while ([Console]::KeyAvailable) {
        $k = [Console]::ReadKey($true)
        if ($k.Key -eq [ConsoleKey]::C -and ($k.Modifiers -band [ConsoleModifiers]::Control)) { break laco }
        if ($k.Key -eq [ConsoleKey]::Enter) {
          [Console]::Out.WriteLine()
          try { $sp.Write("$digitado`n") } catch { Write-NexusAviso '[não consegui enviar]' }
          $digitado = ''
        } elseif ($k.Key -eq [ConsoleKey]::Backspace) {
          if ($digitado.Length -gt 0) { $digitado = $digitado.Substring(0, $digitado.Length - 1); [Console]::Out.Write("`b `b") }
        } elseif ([int]$k.KeyChar -ge 32) {
          $digitado += $k.KeyChar
          [Console]::Out.Write($k.KeyChar)
        }
      }
      Start-Sleep -Milliseconds 20
    }
  } finally {
    [Console]::TreatControlCAsInput = $antesCtrlC
    if ($null -ne $sp) { try { $sp.Close() } catch { } }
  }
  Write-Host "`nPorta $Porta fechada."
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}
