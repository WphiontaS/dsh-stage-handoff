<#
.SYNOPSIS
    Install this plugin's current build into a DSH profile, reliably.

.DESCRIPTION
    `pnpm install` cannot do this job. The profile declares the plugin as

        "dsh-stage-handoff": "file:D:/work/repo/dsh-stage-handoff/dist/<name>.tgz"

    and pnpm records that dependency in `pnpm-lock.yaml` as a bare path with **no
    integrity hash**:

        dsh-stage-handoff:
          specifier: file:D:/work/repo/.../dsh-stage-handoff-1.0.0-beta.2.tgz
          version:   file:../../../../../work/repo/.../dsh-stage-handoff-1.0.0-beta.2.tgz

    Because no hash is stored, pnpm compares only the path. Overwrite the tarball
    with the same version and every install command reports "Already up to date" —
    `pnpm install`, `pnpm add <same path>`, and `pnpm install --fix-lockfile` alike —
    while `node_modules/dsh-stage-handoff` keeps the old files. Rebuilding, restarting
    DSH, and re-running the tests then all appear to do nothing, which is exactly how
    a whole session's worth of fixes can look broken.

    So this script does what pnpm will not: pack the artifact, verify its contents,
    back up the installed copy, and lay the new files down directly. It does not
    touch `package.json` or `pnpm-lock.yaml` — those still describe the same path,
    which remains accurate.

.PARAMETER Profile
    Profile directory to install into. Default: data/profiles/web under DshHome.

.PARAMETER DshHome
    DSH installation root. Required — there is deliberately no default, because a
    hard-coded default would be one contributor's machine layout baked into a
    script that ships in the repository.

.PARAMETER NpmPath
    Explicit path to npm-cli.js, when `npm` is not on PATH.

.PARAMETER SkipPack
    Reuse the existing tarball instead of packing again.

.EXAMPLE
    .\tools\Sync-Profile.ps1 -DshHome D:\path\to\DeepSeekHarness
    Pack, verify, back up the installed copy and install. Restart DSH afterwards.
#>
[CmdletBinding()]
param(
    [string]$Profile = '',
    [Parameter(Mandatory)]
    [string]$DshHome,
    [string]$NpmPath = '',
    [switch]$SkipPack
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Profile -eq '') { $Profile = Join-Path $DshHome 'data/profiles/web' }
$target = Join-Path $Profile 'node_modules/dsh-stage-handoff'
$packageJson = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
$artifact = Join-Path $repoRoot "dist/dsh-stage-handoff-$version.tgz"

if (-not (Test-Path $Profile)) { throw "profile 不存在: $Profile" }
$profileManifestPath = Join-Path $Profile 'package.json'
if (-not (Test-Path $profileManifestPath)) { throw "$Profile 下没有 package.json，不像一个 profile" }

# 「有 package.json」不够 —— 仓库根也有一个。真正的判据是 DSH 在 profile 的
# package.json 里写的 `dsh.profile` 段。少这一步，把本仓库当成 profile 传进来
# 会在仓库里建出 node_modules/dsh-stage-handoff 并铺满文件（实测发生过）。
$profileManifest = Get-Content $profileManifestPath -Raw | ConvertFrom-Json
# StrictMode 下直接访问 `$obj.dsh.profile` 会抛英文原始异常（属性不存在即报错），
# 所以用 PSObject.Properties 探测，并用 `-and` 短路保证只在存在时才往下取值。
$dshProperty = $profileManifest.PSObject.Properties['dsh']
$hasProfileSection =
    ($null -ne $dshProperty) -and
    ($null -ne $dshProperty.Value.PSObject.Properties['profile'])
if (-not $hasProfileSection) {
    throw "拒绝：$Profile 不像 DSH profile（package.json 里没有 dsh.profile 段）"
}

if (-not $SkipPack) {
    Write-Host "== 打包 $version =="
    $packArgs = @{ OutDir = 'dist' }
    if ($NpmPath -ne '') { $packArgs.NpmPath = $NpmPath }
    & (Join-Path $PSScriptRoot 'Pack.ps1') @packArgs
    if (-not $?) { throw '打包失败' }
}

if (-not (Test-Path $artifact)) { throw "找不到产物: $artifact" }

# 校验：新包必须真的带上当前源码里的东西，否则铺完还是旧的却看不出来。
Write-Host "== 校验产物 =="
$unpack = Join-Path ([System.IO.Path]::GetTempPath()) ("sh-verify-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $unpack -Force | Out-Null
try {
    & tar -xzf $artifact -C $unpack
    if (-not $?) { throw '解包失败' }
    $packedIndex = Join-Path $unpack 'package/lib/index.js'
    if (-not (Test-Path $packedIndex)) { throw '产物里没有 lib/index.js' }

    # 用两个只有新版才有的标识，确认「源码里的改动确实进了包」。
    $markers = @('refreshHostMaxTokens', 'describeDropped')
    foreach ($marker in $markers) {
        $hits = (Select-String -Path $packedIndex -Pattern $marker -SimpleMatch | Measure-Object).Count
        if ($hits -eq 0) { throw "产物里找不到 $marker —— 包不是最新的，先确认 npm pack 用的是当前目录" }
        Write-Host "  ok  $marker  x$hits"
    }

    $packedFiles = (Get-ChildItem (Join-Path $unpack 'package') -Recurse -File | Measure-Object).Count
    Write-Host "  ok  产物文件数 $packedFiles"
} finally {
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
}

# 备份已安装的副本：铺错时唯一的回退路径。
if (Test-Path $target) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $repoRoot ".tmp/profile-backup/stage-handoff-$stamp"
    New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
    Copy-Item $target $backup -Recurse -Force
    $count = (Get-ChildItem $backup -Recurse -File | Measure-Object).Count
    Write-Host "== 已备份旧副本（$count 个文件）=="
    Write-Host "  $backup"
    Get-ChildItem (Split-Path -Parent $backup) -Directory |
        Sort-Object LastWriteTime |
        Select-Object -SkipLast 5 |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# 铺文件：清空目标目录内容再解包，避免删掉的文件残留。
#
# 下面有 `Remove-Item -Recurse`，所以目标路径必须先自证：它必须真的是
# `<profile>/node_modules/dsh-stage-handoff`。参数是从命令行来的，一个手滑的
# `-Profile C:\Users` 不该变成「删掉 C:\Users 下的 dsh-stage-handoff」以外的
# 任何东西 —— 加这两道断言，拼错的路径在这里停下，而不是在删除之后。
$expectedTail = Join-Path 'node_modules' 'dsh-stage-handoff'
if (-not $target.EndsWith($expectedTail, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝写入：目标路径必须以 $expectedTail 结尾，实际是 $target"
}
if (-not [System.IO.Path]::IsPathRooted($target)) {
    throw "拒绝写入：目标路径不是绝对路径：$target"
}
Write-Host "== 安装到 $target =="
# 不能「先清空 target 再解包」：解包一旦失败，profile 里就留下一个空的或半份的
# 插件目录，而 lockfile 仍写着这个依赖 —— 宿主下次启动直接找不到入口。这里改成
# 解到暂存目录，成功了再一次 rename 换上去；换的中间态用 `.old-<stamp>` 兜着，
# 任何一步失败都把它移回来。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("sh-stage-staging-$stamp")
$retired = "$target.old-$stamp"
New-Item -ItemType Directory -Path $staging -Force | Out-Null
& tar -xzf $artifact -C $staging --strip-components=1
if (-not $?) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue; throw '解包到暂存目录失败，profile 未改动' }
if (-not (Test-Path (Join-Path $staging 'lib/index.js'))) {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    throw '暂存目录里没有 lib/index.js，profile 未改动'
}

$swapped = $false
try {
    if (Test-Path $target) { Move-Item $target $retired -Force }
    Move-Item $staging $target -Force
    $swapped = $true
} catch {
    # 换上去失败：把旧的移回来，尽量恢复原状。
    if ((-not (Test-Path $target)) -and (Test-Path $retired)) { Move-Item $retired $target -Force }
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    throw "替换 $target 失败，已尝试回滚：$($_.Exception.Message)"
}
if ($swapped -and (Test-Path $retired)) { Remove-Item $retired -Recurse -Force -ErrorAction SilentlyContinue }

$installedFiles = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
$mine = Get-FileHash (Join-Path $repoRoot 'lib/index.js') -Algorithm SHA256
$theirs = Get-FileHash (Join-Path $target 'lib/index.js') -Algorithm SHA256
Write-Host "  安装文件数 $installedFiles"
if ($mine.Hash -ne $theirs.Hash) { throw "装进去的 lib/index.js 与工作区不一致（$($theirs.Hash) vs $($mine.Hash)）" }
Write-Host '  ok  与工作区源码哈希一致'

Write-Host ''
Write-Host '完成。**必须重启 DSH** 才会加载新代码 —— 插件在宿主启动时 import，'
Write-Host '重启任何数量的「页面刷新」都不会替换已经加载的模块。'
Write-Host ''
Write-Host "回滚：把上面备份目录的内容铺回 $target"
