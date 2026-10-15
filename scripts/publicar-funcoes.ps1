<#
.SYNOPSIS
  Publica as Edge Functions do NexusHome no Supabase (projeto gfjxcsvxhaojbtuixpjh) pelo Supabase CLI.

.DESCRIPTION
  Roda, na pasta do repositório:
    supabase functions deploy <nome> --project-ref gfjxcsvxhaojbtuixpjh [--no-verify-jwt]
  Padrão: iot-gateway e notify-alert. -Todas inclui smartthings-proxy e tuya-proxy.
    iot-gateway   --no-verify-jwt  (o ESP32 se autentica só pelo cabeçalho x-device-key)
    notify-alert  --no-verify-jwt  (quem chama é o webhook do banco)
    smartthings-proxy / tuya-proxy SEM --no-verify-jwt (exigem login no app)
  Confere se o Supabase CLI existe e se você está logado. Tenta publicar sem Docker (--use-api) e,
  se o seu CLI for antigo, sem essa opção.
  Este script NUNCA pede nem mostra segredos. O IOT_DEVICE_SECRET você configura digitando no SEU terminal:
    supabase secrets set IOT_DEVICE_SECRET=<seu-segredo> --project-ref gfjxcsvxhaojbtuixpjh
  Só para Windows (o PC onde você faz a manutenção). Aceita -WhatIf.

.PARAMETER Funcoes
  Quais publicar: iot-gateway, notify-alert, smartthings-proxy, tuya-proxy.

.PARAMETER Todas
  Publica as quatro.

.PARAMETER Sim
  Não pergunta antes de abrir o "supabase login".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -Funcoes iot-gateway

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publicar-funcoes.ps1 -Todas -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('iot-gateway', 'notify-alert', 'smartthings-proxy', 'tuya-proxy')][string[]]$Funcoes = @('iot-gateway', 'notify-alert'),
  [switch]$Todas,
  [switch]$Sim
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$comum = Join-Path $PSScriptRoot 'nexus-comum.ps1'
if (-not (Test-Path -LiteralPath $comum)) { Write-Host "ERRO: falta $comum (copie a pasta scripts inteira)." -ForegroundColor Red; exit 1 }
. $comum

if (-not (Test-NexusWindows)) {
  Write-NexusErro 'este script é para o Windows do PC de manutenção. Em outro sistema rode à mão: supabase functions deploy iot-gateway --project-ref gfjxcsvxhaojbtuixpjh --no-verify-jwt'
  exit 1
}

$semJwt = @('iot-gateway', 'notify-alert')
$ref = $script:NexusProjetoRef

try {
  if ($Todas) { $Funcoes = @('iot-gateway', 'notify-alert', 'smartthings-proxy', 'tuya-proxy') }
  $repo = Split-Path -Parent $PSScriptRoot
  foreach ($f in $Funcoes) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo "supabase\functions\$f\index.ts"))) { throw "não achei supabase\functions\$f\index.ts no repositório ($repo)." }
  }

  $cmd = Get-Command supabase -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) {
    throw ('Supabase CLI não encontrado. Instale com:  winget install Supabase.CLI   (ou: npm i -g supabase)' +
           ' — depois feche e reabra o PowerShell.')
  }
  $sb = $cmd.Path
  Write-Host "Supabase CLI: $sb"

  # ---- logado? (só o código de saída importa; a lista de projetos não é mostrada) ----
  $teste = Invoke-NexusNativo -Exe $sb -Argumentos @('projects', 'list') -Silencioso
  if ($teste.Codigo -ne 0) {
    Write-NexusAviso 'Você não está logado no Supabase CLI.'
    Write-Host '  O login abre o navegador; nenhuma senha passa por este script.'
    if ($WhatIfPreference) { Write-Host '  (WhatIf: rodaria "supabase login")' }
    elseif ($Sim -or (Confirm-Nexus 'Rodar "supabase login" agora?')) {
      & $sb login
      if ($LASTEXITCODE -ne 0) { throw 'o login não terminou. Rode "supabase login" e depois este script de novo.' }
    } else { throw 'rode "supabase login" e depois este script de novo.' }
  }

  $falhas = @()
  Push-Location -LiteralPath $repo
  try {
    foreach ($f in $Funcoes) {
      $a = @('functions', 'deploy', $f, '--project-ref', $ref)
      if ($semJwt -contains $f) { $a += '--no-verify-jwt' }
      if (-not $PSCmdlet.ShouldProcess("$f (projeto $ref)", "supabase $($a -join ' ')")) { continue }
      Write-NexusPasso "Publicando $f..."
      $r = Invoke-NexusNativo -Exe $sb -Argumentos ($a + '--use-api')
      if ($r.Codigo -ne 0 -and $r.Saida -match 'unknown flag|flag provided but not defined') {
        Write-Host '  (CLI antigo: tentando sem --use-api; precisa do Docker Desktop aberto)'
        $r = Invoke-NexusNativo -Exe $sb -Argumentos $a
      }
      if ($r.Codigo -ne 0) { $falhas += $f; Write-NexusErro "falha ao publicar $f (código $($r.Codigo))." }
      else { Write-NexusOk "  $f publicada." }
    }
  } finally { Pop-Location }

  if ($WhatIfPreference) { exit 0 }

  if ($Funcoes -contains 'iot-gateway' -and $falhas -notcontains 'iot-gateway') {
    $h = Invoke-NexusHttp -Url "$($script:NexusGatewayUrl)/health"
    if ($h.Status -eq 200) { Write-NexusOk 'iot-gateway respondendo (/health ok).' }
    else { Write-NexusAviso "o /health respondeu $($h.Status). Confira em supabase.com > Edge Functions > iot-gateway > Logs." }
  }

  Write-Host ''
  Write-Host 'Lembrete: os segredos ficam só no Supabase. Se ainda não configurou, digite VOCÊ MESMO no terminal:' -ForegroundColor Yellow
  Write-Host "  supabase secrets set IOT_DEVICE_SECRET=<seu-segredo> --project-ref $ref"
  Write-Host '  (o mesmo valor do DEVICE_SECRET dos firmwares; nunca cole em chat, e-mail ou commit)'

  if ($falhas.Count -gt 0) { throw "não publicadas: $($falhas -join ', ')" }
  exit 0
} catch {
  Write-NexusErro $_.Exception.Message
  exit 1
}
