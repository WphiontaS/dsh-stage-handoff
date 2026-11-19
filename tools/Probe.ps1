<#
.SYNOPSIS
    Run the repository's diagnostic probes.

.DESCRIPTION
    这些探针查的都是「静态检查看不见」的问题：面板在真机上静默空白、
    英文界面里冒出中文、思维链退化成「好。做。好。做。」。它们不进 npm 包
    （package.json 的 files 不含 tools），只在开发机上用。

    - locale    面板英译覆盖度：每个中文 t()/tf() key 都必须有英文，且无死条目
    - render    真正渲染一次面板，检查英文界面下没有中文残留
    - boot      lib/client.js 的 factory 能否在最小桩下执行（抓模块顶层 ReferenceError）
    - thinking  思维链复读扫描（默认最近一次会话；-All 扫全部；-Session 指定）
    - all       上面四个全跑

.PARAMETER Probe
    locale | boot | thinking | all（默认 all）

.PARAMETER Session
    会话 id 片段，供 -Probe thinking 使用

.PARAMETER All
    -Probe thinking -All：扫所有会话

.PARAMETER Installed
    -Probe boot -Installed <目录>：检查已装进 profile 的那份，而不是仓库源码

.PARAMETER NpmPath
    未使用；保留与 Pack.ps1 一致的调用习惯

.EXAMPLE
    .\tools\Probe.ps1

.EXAMPLE
    .\tools\Probe.ps1 -Probe thinking -Session b8502892
#>
[CmdletBinding()]
param(
    [ValidateSet('locale', 'render', 'boot', 'thinking', 'all')]
    [string]$Probe = 'all',
    [string]$Session = '',
    [switch]$All,
    [string]$Installed = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$node = $env:DSH_NODE_EXECUTABLE
if ([string]::IsNullOrWhiteSpace($node)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw 'cannot find node. Set $env:DSH_NODE_EXECUTABLE or put node on PATH.'
    }
    $node = $nodeCmd.Source
}

$failures = 0

function Invoke-Probe {
    param([string]$Name, [string[]]$Arguments)
    Write-Host ''
    Write-Host ("=== {0}" -f $Name) -ForegroundColor Cyan
    & $node @Arguments
    if ($LASTEXITCODE -ne 0) {
        $script:failures += 1
        Write-Host ("  → 探针返回 {0}" -f $LASTEXITCODE) -ForegroundColor Yellow
    }
}

$wanted = if ($Probe -eq 'all') { @('locale', 'render', 'boot', 'thinking') } else { @($Probe) }

if ($wanted -contains 'locale') {
    Invoke-Probe -Name 'locale-coverage' -Arguments @((Join-Path $root 'tools\probes\locale-coverage.mjs'))
}

if ($wanted -contains 'render') {
    $renderArgs = @((Join-Path $root 'tools\probes\render-smoke.mjs'))
    if ($Installed -ne '') { $renderArgs += @('--installed', $Installed) }
    Invoke-Probe -Name 'render-smoke (en)' -Arguments $renderArgs
}

if ($wanted -contains 'boot') {
    $bootArgs = @((Join-Path $root 'tools\probes\client-boot.mjs'))
    if ($Installed -ne '') { $bootArgs += @('--installed', $Installed) }
    Invoke-Probe -Name 'client-boot' -Arguments $bootArgs
}

if ($wanted -contains 'thinking') {
    $thinkArgs = @((Join-Path $root 'tools\probes\thinking-loops.mjs'))
    if ($Session -ne '') { $thinkArgs += @('--session', $Session) }
    if ($All) { $thinkArgs += '--all' }
    Invoke-Probe -Name 'thinking-loops' -Arguments $thinkArgs
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host '所有探针通过' -ForegroundColor Green
    exit 0
}
Write-Host ("{0} 个探针报了问题" -f $failures) -ForegroundColor Yellow
exit 1
