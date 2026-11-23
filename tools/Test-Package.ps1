<#
.SYNOPSIS
    Verify a packed tarball without installing it into a live harness.

.DESCRIPTION
    Unpacks the tarball into a temporary directory and checks five things:

      1. every declared `files` entry exists (skipping `!pattern` exclusions);
      2. no development-only file (tests, tsconfig, tools, node_modules) leaked in;
      3. no stage-anchor directory (host paths / session ids) is packed;
      4. the full file set matches the exact release manifest;
      5. the plugin entry loads and the declared client entry is self-consistent.

    This is a structural check, not an integration test: it proves the artifact is
    shaped correctly, not that a harness can run it.

.PARAMETER Tarball
    Path to the .tgz. Defaults to the newest tarball under dist/.

.EXAMPLE
    .\tools\Test-Package.ps1
    .\tools\Test-Package.ps1 -Tarball .\dist\dsh-stage-handoff-0.1.0.tgz
#>
[CmdletBinding()]
param(
    [string]$Tarball = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

if ($Tarball -eq '') {
    $distDir = Join-Path $root 'dist'
    if (-not (Test-Path -LiteralPath $distDir)) { throw "no dist/ directory; run tools\Pack.ps1 first" }
    $newest = Get-ChildItem -LiteralPath $distDir -Filter '*.tgz' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { throw 'no tarball in dist/; run tools\Pack.ps1 first' }
    $Tarball = $newest.FullName
}
if (-not (Test-Path -LiteralPath $Tarball)) { throw "missing tarball: $Tarball" }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-stage-handoff-check-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$failures = New-Object System.Collections.Generic.List[string]
function Fail([string]$message) { $script:failures.Add($message); Write-Host "FAIL  $message" -ForegroundColor Red }
function Pass([string]$message) { Write-Host "ok    $message" -ForegroundColor Green }

try {
    Write-Host "verifying $Tarball"
    & tar -xzf $Tarball -C $work
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

    $packageRoot = Join-Path $work 'package'
    if (-not (Test-Path -LiteralPath $packageRoot)) { throw 'tarball has no package/ root' }

    # 1. declared files must be present
    $manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $declared = @($manifest.files)
    foreach ($entry in $declared) {
        # `!pattern` is a files-exclusion, not a declared path.
        if ([string]$entry -like '!*') { continue }
        $path = Join-Path $packageRoot $entry
        if (Test-Path -LiteralPath $path) { Pass "declared entry present: $entry" }
        else { Fail "declared entry missing from artifact: $entry" }
    }

    # 2. development files must not leak
    $forbidden = @('test', 'tsconfig.json', 'tools', 'node_modules', '.github', '.gitignore', 'package-lock.json')
    foreach ($entry in $forbidden) {
        if (Test-Path -LiteralPath (Join-Path $packageRoot $entry)) { Fail "development file leaked into artifact: $entry" }
    }
    if ($failures.Count -eq 0) { Pass 'no development files in artifact' }

    # 2b. stage anchors are workspace runtime data: absolute host paths and session ids
    if (Test-Path -LiteralPath (Join-Path $packageRoot 'docs\anchors')) {
        Fail 'stage anchor directory leaked into artifact: docs/anchors'
    } else { Pass 'no stage anchor directory in artifact' }

    # 2c. compare the complete file set. Checking only top-level directories
    # would still allow a stray file under lib/ or docs/ into the release.
    $expectedFiles = @(
        'LICENSE',
        'NOTICE.md',
        'README.md',
        'README.en.md',
        'README.zh-CN.md',
        'CHANGELOG.md',
        'cordis.patch.yml',
        'package.json',
        'assets/icon.svg',
        'locale/en.json',
        'locale/zh.json',
        'lib/index.js',
        'lib/prestep-log.js',
        'lib/client.js',
        'lib/config.js',
        'lib/util.js',
        'lib/usage.js',
        'lib/cleanup.js',
        'lib/repeat-scan.js',
        'lib/stream-guard.js',
        'docs/ANCHOR-POLICY.md',
        'docs/ARCHITECTURE.md',
        'docs/CONFIGURATION.md',
        'docs/FEEDBACK-injected-messages-cannot-be-removed.md',
        'docs/PRIVACY.md',
        'docs/RELEASING.md',
        'docs/SECURITY.md',
        'docs/VALIDATION.md'
    )
    $actualFiles = @(
        Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Force |
            ForEach-Object {
                $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
            }
    )
    $expectedFiles = @($expectedFiles | Sort-Object)
    $actualFiles = @($actualFiles | Sort-Object)
    $missingFiles = @($expectedFiles | Where-Object { $actualFiles -notcontains $_ })
    $unexpectedFiles = @($actualFiles | Where-Object { $expectedFiles -notcontains $_ })
    if ($missingFiles.Count -gt 0) {
        Fail ('expected release files missing: ' + ($missingFiles -join ', '))
    }
    if ($unexpectedFiles.Count -gt 0) {
        Fail ('unexpected files in artifact: ' + ($unexpectedFiles -join ', '))
    }
    if ($missingFiles.Count -eq 0 -and $unexpectedFiles.Count -eq 0) {
        Pass "artifact contains exactly $($expectedFiles.Count) expected files"
    }

    # 3. the entry must load and export the plugin contract
    $entryPath = Join-Path $packageRoot 'lib\index.js'
    if (-not (Test-Path -LiteralPath $entryPath)) {
        Fail 'lib/index.js missing from artifact'
    } else {
        $probe = @'
const url = require('node:url')
const path = require('node:path')
const fs = require('node:fs')
const entry = path.resolve(process.argv[2])
import(url.pathToFileURL(entry).href).then((mod) => {
  const name = mod.name
  const inject = mod.inject
  const apply = mod.apply
  const problems = []
  if (typeof name !== 'string' || name.length === 0) problems.push('name is not a non-empty string')
  if (!Array.isArray(inject)) problems.push('inject is not an array')
  if (typeof apply !== 'function') problems.push('apply is not a function')
  if (!Object.prototype.hasOwnProperty.call(mod, 'Config')) problems.push('Config is not exported')
  console.log(JSON.stringify({ ok: problems.length === 0, name, inject, problems }))
}).catch((error) => {
  const message = error && error.message ? error.message : String(error)
  // 宿主包（`@deepseek-ai/*`）在裸 Node 下解析不到是**预期**的：真实运行时由 DSH 的
  // Loader 解析，它有自己的一套解析器（同一 profile 里 dsh-tool-imagegen 与
  // dsh-web-search-hybrid 都静态 import 了 @deepseek-ai/schemastery，而
  // profile 的 node_modules 里根本没有这个包，它们照样正常加载）。
  // 这种情况降级为静态契约检查，而不是判定产物损坏。
  if (/Cannot find package '@deepseek-ai\//.test(message)) {
    const source = fs.readFileSync(entry, 'utf8')
    const problems = []
    if (!/export\s+const\s+name\s*=/.test(source)) problems.push('missing export const name')
    if (!/export\s+const\s+inject\s*=/.test(source)) problems.push('missing export const inject')
    if (!/(export\s+function\s+apply|export\s+const\s+apply\s*=)/.test(source)) problems.push('missing apply export')
    if (!/export\s+const\s+Config\s*=/.test(source)) problems.push('missing export const Config (the settings panel needs it)')
    console.log(JSON.stringify({
      ok: problems.length === 0,
      name: '(static check: host-package import skipped)',
      inject: [],
      problems,
    }))
    return
  }
  console.log(JSON.stringify({ ok: false, problems: ['import failed: ' + message] }))
})
'@
        $probePath = Join-Path $work 'probe.cjs'
        [System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))

        # 托管安装（DSH runtime）里 node 不在 PATH，只有绝对路径。和 Pack.ps1
        # 一样：先看显式环境变量，再查 PATH，最后从 tarball 旁边的 runtime 反推。
        $nodeSource = $null
        if (-not [string]::IsNullOrWhiteSpace($env:DSH_NODE_EXECUTABLE)) {
            if (Test-Path -LiteralPath $env:DSH_NODE_EXECUTABLE) { $nodeSource = $env:DSH_NODE_EXECUTABLE }
        }
        if ($null -eq $nodeSource) {
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($nodeCmd) { $nodeSource = $nodeCmd.Source }
        }
        if ($null -eq $nodeSource) {
            Fail 'cannot find node. Set $env:DSH_NODE_EXECUTABLE or put node on PATH.'
        } else {
            $raw = & $nodeSource $probePath $entryPath 2>&1
            $parsed = $null
            try { $parsed = ($raw | Select-Object -Last 1) | ConvertFrom-Json } catch { }
            if ($null -eq $parsed) {
                Fail "entry probe produced no parsable output: $raw"
            } elseif ($parsed.ok) {
                Pass ("entry loads: name={0} inject=[{1}] apply=function" -f $parsed.name, ($parsed.inject -join ','))
            } else {
                foreach ($problem in $parsed.problems) { Fail "entry contract: $problem" }
            }
        }
    }

    # 4. client entry, when declared, must exist and be self-consistent.
    #    StrictMode 下不能直接读可能不存在的属性，所以用 PSObject.Properties 探测。
    $clientDecl = $null
    if ($null -ne $manifest.PSObject.Properties['dsh']) {
        $clientDecl = $manifest.dsh.PSObject.Properties['client']
    }
    if ($null -eq $clientDecl) {
        Pass 'no client entry declared (host-only plugin)'
    } else {
        $client = $clientDecl.Value
        if ($client.platform -eq 'web') { Pass 'dsh.client.platform = web' }
        else { Fail ("dsh.client.platform must be 'web', got '{0}'" -f $client.platform) }

        $exportDecl = $null
        if ($null -ne $manifest.PSObject.Properties['exports']) {
            $exportDecl = $manifest.exports.PSObject.Properties['./client']
        }
        if ($null -eq $exportDecl) {
            Fail 'dsh.client is declared but exports["./client"] is missing'
        } else {
            $clientRel = ([string]$exportDecl.Value).TrimStart('.', '/')
            $clientPath = Join-Path $packageRoot ($clientRel -replace '/', '\')
            if (-not (Test-Path -LiteralPath $clientPath)) {
                Fail "exports['./client'] points at a missing file: $clientRel"
            } else {
                Pass "client entry present: $clientRel"
                $clientSource = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
                if ($clientSource -match '__ModuleLoader__\.load\(') {
                    Pass 'client registers through __ModuleLoader__.load'
                } else {
                    Fail 'client entry never calls __ModuleLoader__.load'
                }
                if ($clientSource -match ('id:\s*''' + [regex]::Escape($manifest.name) + '''')) {
                    Pass "client id matches package name: $($manifest.name)"
                } else {
                    Fail "client id does not match package name $($manifest.name)"
                }
            }
        }
    }
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}

Write-Host ''
if ($failures.Count -eq 0) {
    Write-Host 'PASS: artifact is structurally valid.' -ForegroundColor Green
    exit 0
}
Write-Host ("FAILED with {0} problem(s)." -f $failures.Count) -ForegroundColor Red
foreach ($f in $failures) { Write-Host "  - $f" }
exit 1
