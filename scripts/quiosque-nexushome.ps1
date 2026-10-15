<#
.SYNOPSIS
  Instala o NexusHome em tela cheia (modo quiosque) no monitor do servidor: Edge ou Chrome, iniciando com o Windows.

.DESCRIPTION
  -Instalar  cria o atalho "NexusHome Quiosque" na pasta Inicializar do usuário. Ele abre a URL no Edge
             (--kiosk URL --edge-kiosk-type=fullscreen --no-first-run) ou no Chrome (--kiosk), o que existir,
             com um perfil próprio (funciona mesmo com o navegador já aberto). Com -Monitor 2, a janela vai
             para o segundo monitor (--window-position calculado pelas telas do Windows).
             Também oferece (com confirmação) desligar o apagamento da tela e a suspensão na tomada
             (powercfg /change monitor-timeout-ac 0 e standby-timeout-ac 0). Os valores antigos ficam guardados.
  -Remover   apaga o atalho e devolve os tempos de tela/suspensão guardados.
  -Testar    abre o quiosque agora (Alt+F4 fecha).
  Só para Windows. Aceita -WhatIf.

.PARAMETER Url
  Endereço a abrir (padrão https://nexushome-os.vercel.app).

.PARAMETER Monitor
  1 = monitor principal (padrão), 2 = o segundo, e assim por diante.

.PARAMETER Navegador
  auto (padrão: Edge, senão Chrome), edge ou chrome.

.PARAMETER SemEnergia
  Não mexe nas opções de energia.

.PARAMETER Sim
  Não pergunta antes de mudar as opções de energia.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Instalar -Monitor 2 -Navegador chrome

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\quiosque-nexushome.ps1 -Remover
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Testar')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Instalar')][switch]$Instalar,
  [Parameter(Mandatory = $true, ParameterSetName = 'Remover')][switch]$Remover,
  [Parameter(ParameterSetName = 'Testar')][switch]$Testar,
  [Parameter(ParameterSetName = 'Instalar')]
  [Parameter(ParameterSetName = 'Testar')]
  [ValidatePattern('^https?://\S+$')][string]$Url = 'https://nexushome-os.vercel.app',
  [Parameter(ParameterSetName = 'Instalar')]
  [Parameter(ParameterSetName = 'Testar')]
  [ValidateRange(1, 8)][int]$Monitor = 1,
  [Parameter(ParameterSetName = 'Instalar')]
  [Parameter(ParameterSetName = 'Testar')]
  [ValidateSet('auto', 'edge', 'chrome')][string]$Navegador = 'auto',
  [Parameter(ParameterSetName = 'Instalar')][switch]$SemEnergia,
  [switch]$Sim
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

if (-not (Test-NexusWindows)) {
  Write-NexusErro 'o quiosque é só para Windows (Edge/Chrome, pasta Inicializar e powercfg). Rode no servidor Windows do rack.'
  exit 1
}

$nomeAtalho = 'NexusHome Quiosque.lnk'
$pastaDados = Join-Path $env:LOCALAPPDATA 'NexusHome'
$perfil     = Join-Path $pastaDados 'quiosque-perfil'
$estado     = Join-Path $pastaDados 'quiosque-energia.json'

function Join-Se($base, [string]$resto) { if ($base) { return (Join-Path $base $resto) } return $null }

function Find-Navegador([string]$qual) {
  $edge = @(
    (Join-Se ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Se $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ }
  $chrome = @(
    (Join-Se $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Se ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Se $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ }
  $ordem = @()
  if ($qual -eq 'auto' -or $qual -eq 'edge')   { foreach ($p in $edge)   { $ordem += [pscustomobject]@{ Tipo = 'edge';   Exe = $p } } }
  if ($qual -eq 'auto' -or $qual -eq 'chrome') { foreach ($p in $chrome) { $ordem += [pscustomobject]@{ Tipo = 'chrome'; Exe = $p } } }
  foreach ($o in $ordem) { if (Test-Path -LiteralPath $o.Exe) { return $o } }
  return $null
}

function Get-TempoEnergia([string]$sub, [string]$cfg) {
  # devolve minutos (CA) lidos do powercfg /query; $null se não der para ler (texto muda com o idioma)
  $saida = (& powercfg /query SCHEME_CURRENT $sub $cfg 2>$null) -join "`n"
  $hex = @([regex]::Matches($saida, '0x[0-9a-fA-F]{8}') | ForEach-Object { $_.Value })
  if ($hex.Count -lt 2) { return $null }
  return [int]([Convert]::ToInt32($hex[$hex.Count - 2].Substring(2), 16) / 60)
}

function Get-Linha {
  $nav = Find-Navegador $Navegador
  if (-not $nav) { throw 'não achei o Microsoft Edge nem o Google Chrome. Instale um deles (winget install Google.Chrome).' }
  $pos = $null
  if ($Monitor -gt 1) {
    Add-Type -AssemblyName System.Windows.Forms
    $telas = @([System.Windows.Forms.Screen]::AllScreens)
    $pos = Get-PosicaoMonitor -Telas $telas -Monitor $Monitor
    if ($null -eq $pos) { throw "o Windows só vê $($telas.Count) monitor(es); não existe o monitor $Monitor." }
    Write-Host "  monitor ${Monitor}: $($pos.Largura) x $($pos.Altura) em ($($pos.X), $($pos.Y))"
  }
  $argumentos = Get-QuiosqueArgumentos -Navegador $nav.Tipo -Url $Url -Perfil $perfil -Posicao $pos
  return [pscustomobject]@{ Exe = $nav.Exe; Tipo = $nav.Tipo; Argumentos = $argumentos }
}

if ($PSCmdlet.ParameterSetName -eq 'Testar' -and -not $Testar) {
  Write-NexusErro 'escolha -Instalar, -Remover ou -Testar (veja: Get-Help scripts\quiosque-nexushome.ps1 -Detailed).'
  exit 1
}

try {
  $startup = [Environment]::GetFolderPath('Startup')
  $atalho = Join-Path $startup $nomeAtalho

  if ($PSCmdlet.ParameterSetName -eq 'Remover') {
    if (Test-Path -LiteralPath $atalho) {
      if ($PSCmdlet.ShouldProcess($atalho, 'apagar o atalho do quiosque')) { Remove-Item -LiteralPath $atalho -Force; Write-NexusOk "Atalho removido: $atalho" }
    } else { Write-Host 'O atalho do quiosque não estava instalado.' }
    if (Test-Path -LiteralPath $estado) {
      $antigo = Get-Content -LiteralPath $estado -Raw | ConvertFrom-Json
      $mon = Get-NexusPropriedade $antigo 'monitor'; $sus = Get-NexusPropriedade $antigo 'standby'
      if ($PSCmdlet.ShouldProcess('opções de energia', "voltar tela=$mon min, suspensão=$sus min")) {
        if ($null -ne $mon) { & powercfg /change monitor-timeout-ac $mon | Out-Null }
        if ($null -ne $sus) { & powercfg /change standby-timeout-ac $sus | Out-Null }
        Remove-Item -LiteralPath $estado -Force
        Write-NexusOk "Energia devolvida: tela apaga em $mon min, suspensão em $sus min (0 = nunca)."
      }
    }
    exit 0
  }

  $linha = Get-Linha
  Write-Host "Navegador: $($linha.Tipo) ($($linha.Exe))"
  Write-Host "Argumentos: $($linha.Argumentos)"

  if ($PSCmdlet.ParameterSetName -eq 'Testar') {
    if ($PSCmdlet.ShouldProcess($Url, 'abrir o quiosque agora')) {
      New-Item -ItemType Directory -Force -Path $perfil | Out-Null
      Start-Process -FilePath $linha.Exe -ArgumentList $linha.Argumentos | Out-Null
      Write-NexusOk 'Quiosque aberto. Alt+F4 fecha.'
    }
    exit 0
  }

  # ---- Instalar ----
  if ($PSCmdlet.ShouldProcess($atalho, 'criar o atalho na pasta Inicializar')) {
    New-Item -ItemType Directory -Force -Path $perfil | Out-Null
    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut($atalho)
    $lnk.TargetPath = $linha.Exe
    $lnk.Arguments = $linha.Argumentos
    $lnk.WorkingDirectory = Split-Path -Parent $linha.Exe
    $lnk.Description = 'NexusHome OS em tela cheia'
    $lnk.Save()
    Write-NexusOk "Atalho criado: $atalho (abre sozinho quando este usuário entrar no Windows)."
  }

  if (-not $SemEnergia) {
    $faz = $Sim
    if (-not $faz -and -not $WhatIfPreference) { $faz = Confirm-Nexus 'Desligar o apagamento da tela e a suspensão do PC na tomada?' }
    if ($faz -and $PSCmdlet.ShouldProcess('opções de energia', 'monitor-timeout-ac 0 e standby-timeout-ac 0')) {
      if (-not (Test-Path -LiteralPath $estado)) {
        $guardar = [ordered]@{ monitor = (Get-TempoEnergia 'SUB_VIDEO' 'VIDEOIDLE'); standby = (Get-TempoEnergia 'SUB_SLEEP' 'STANDBYIDLE') }
        New-Item -ItemType Directory -Force -Path $pastaDados | Out-Null
        $guardar | ConvertTo-Json | Set-Content -LiteralPath $estado -Encoding UTF8
      }
      & powercfg /change monitor-timeout-ac 0 | Out-Null
      & powercfg /change standby-timeout-ac 0 | Out-Null
      Write-NexusOk 'Tela e suspensão: nunca (na tomada). -Remover devolve os valores antigos.'
    } elseif (-not $faz) { Write-Host 'Opções de energia não alteradas.' }
  }
  Write-Host "`nPara ver agora: scripts\quiosque-nexushome.ps1 -Testar$(if ($Monitor -gt 1) { " -Monitor $Monitor" })"
  Write-Host 'Dica: em Configurações > Contas, ative a entrada automática do usuário do quiosque.'
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}
