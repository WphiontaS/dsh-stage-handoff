<#
.SYNOPSIS
    Build the release tarball and print its SHA-256.

.DESCRIPTION
    Runs `npm pack` into dist/, then reports the artifact path, byte size and hash.
    Verifies the packaged file list against the files recorded in package.json
    before declaring success.

.PARAMETER OutDir
    Directory (relative to the repo root) that receives the tarball. Default: dist

.PARAMETER NpmPath
    Explicit path to npm-cli.js. Needed only when `npm` is not on PATH.

.EXAMPLE
    .\tools\Pack.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = 'dist',
    [string]$NpmPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# npm 把进度与 `npm notice` 写到 stderr。在 $ErrorActionPreference='Stop' 下，
# PowerShell 会把原生命令的 stderr 当成终止性错误（NativeCommandError），
# 于是打包在第一条 npm notice 处就失败，而 npm 其实成功退出了。
# 关掉这个转换，改由下面的 $LASTEXITCODE 判定成败。
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "missing manifest: $manifestPath" }

# Resolve a way to run npm. `npm` may be absent from PATH on managed Node
# installs, where node.exe is invoked directly by absolute path.
function Resolve-NodeCommand {
    # node.exe 是运行 npm-cli.js 的解释器。托管安装（DSH 的 runtime）只提供
    # 绝对路径，PATH 上查不到，所以先查 PATH，再从 npm-cli.js 的位置反推：
    #   <rt>\node-vX\node_modules\npm\bin\npm-cli.js → <rt>\node-vX\node.exe
    param([string]$NpmCliPath)
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $parts = $NpmCliPath -split '[\\/]'
    foreach ($ancestor in 4, 3) {
        if ($parts.Count -le $ancestor) { continue }
        $base = ($parts[0..($parts.Count - $ancestor - 1)] -join '\')
        $candidate = Join-Path $base 'node.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return 'node'
}

function Resolve-NpmInvocation {
    param([string]$Explicit)
    if ($Explicit -ne '') {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "NpmPath not found: $Explicit" }
        return @{ Command = (Resolve-NodeCommand -NpmCliPath $Explicit); Prefix = @($Explicit) }
    }
    $onPath = Get-Command npm -ErrorAction SilentlyContinue
    if ($onPath) { return @{ Command = $onPath.Source; Prefix = @() } }
    # 托管安装里 node 与 npm 都不在 PATH，只有 $env:DSH_NODE_EXECUTABLE。
    # Probe.ps1 与 Test-Package.ps1 都是先认这个变量，这里原先不认，于是同一个
    # 环境里那两支能跑、打包这支必然 throw，必须由调用者手工传 -NpmPath。
    $nodeCandidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_NODE_EXECUTABLE)) {
        $nodeCandidates += $env:DSH_NODE_EXECUTABLE
    }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $nodeCandidates += $nodeCmd.Source }
    foreach ($candidate in $nodeCandidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $cli = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
        if (Test-Path -LiteralPath $cli) { return @{ Command = $candidate; Prefix = @($cli) } }
    }
    throw 'cannot find npm. Install Node.js, put it on PATH, set DSH_NODE_EXECUTABLE, or pass -NpmPath <path-to-npm-cli.js>.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$name = [string]$manifest.name
$version = [string]$manifest.version
if ($name -eq '' -or $version -eq '') { throw 'package.json must declare name and version' }

$invocation = Resolve-NpmInvocation -Explicit $NpmPath
$target = Join-Path $root $OutDir
New-Item -ItemType Directory -Path $target -Force | Out-Null

Write-Host "packing $name@$version"

$packArgs = @()
if ($invocation.Prefix.Count -gt 0) { $packArgs += $invocation.Prefix }
$packArgs += @('pack', '--pack-destination', $target)

# `npm pack` 读的是当前目录的 package.json，所以不能依赖调用者的 cwd。
Push-Location $root
try {
    $output = & $invocation.Command @packArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $output | ForEach-Object { Write-Host $_ }
        throw "npm pack failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$expected = "$name-$version.tgz"
$artifact = Join-Path $target $expected
if (-not (Test-Path -LiteralPath $artifact)) {
    throw "npm pack completed but expected artifact is missing: $artifact"
}

$file = Get-Item -LiteralPath $artifact
$hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash

# 帮助头声称「声明成功前核对打包清单」—— 这里真的核对。清单的权威是
# Test-Package.ps1（它持有硬编码的期望文件集）；它不存在就拒绝报成功 ——
# `package.json` 的 files 少写一项时，只跑 `npm pack` 一样会 exit 0。
# 走子进程：Test-Package.ps1 内部的 `exit` 会直接终止调用者脚本。
$testScript = Join-Path $PSScriptRoot 'Test-Package.ps1'
if (-not (Test-Path -LiteralPath $testScript -PathType Leaf)) {
    throw "Test-Package.ps1 is missing; refusing to declare success without a file-list check"
}
$runner = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
}
else {
    Join-Path $PSHOME 'powershell.exe'
}
& $runner -NoProfile -ExecutionPolicy Bypass -File $testScript -Tarball $artifact
if ($LASTEXITCODE -ne 0) {
    throw "packaged artifact failed the file-list check: $artifact"
}

Write-Host ("artifact : {0}" -f $file.FullName)
Write-Host ("size     : {0} bytes" -f $file.Length)
Write-Host ("sha256   : {0}" -f $hash)
Write-Host ''
Write-Host 'Attach this file to the GitHub release as:'
Write-Host ("  {0}" -f $file.Name)
Write-Host 'The install URL depends on that name staying fixed.'
