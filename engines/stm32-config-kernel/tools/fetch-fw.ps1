# Land the BSD-3-licensed STM32 firmware components the generated projects
# compile against (HAL driver, CMSIS device) under
# data/fw/<FAMILY>/{HAL_Driver,CMSIS_Device} plus one shared data/fw/CMSIS_Core
# — the layout codegen's FwPaths::locate expects.
#
# Three sources, tried in this order per family:
#
#   1. the local STM32Cube firmware repository (CubeMX's own download cache,
#      default $HOME\STM32Cube\Repository) — a plain file copy, no network;
#   2. ST's per-component GitHub repositories (stm32h7xx-hal-driver,
#      cmsis-device-h7);
#   3. the family's full STM32CubeXX package repository, blobless + sparse so
#      only Drivers/ is transferred. This is the only source for MP1, whose
#      HAL was never split into a component repo.
#
# Whatever the source, only .c/.h/.s/.S/.ld and licence texts are kept: vendor
# manuals (.chm), release notes and the _htmresc image trees are hundreds of
# megabytes of noise in a repo whose data payload is committed.
#
# Usage:
#   powershell -File tools/fetch-fw.ps1                      # F1 + F4
#   powershell -File tools/fetch-fw.ps1 -Families STM32H5,STM32H7
#   powershell -File tools/fetch-fw.ps1 -All                 # every family
#   powershell -File tools/fetch-fw.ps1 -Families STM32L4 -GitHubOnly
#   powershell -File tools/fetch-fw.ps1 -Families STM32H7 -Force

param(
    [string[]]$Families = @("STM32F1", "STM32F4"),

    # Land every family the kernel ships an IR pack for (data/*.irpack).
    [switch]$All,

    # CubeMX's firmware download cache. Family packs live here as
    # STM32Cube_FW_<F>_V<x.y.z>\Drivers\...
    [string]$CubeRepository = (Join-Path $HOME "STM32Cube\Repository"),

    # Skip the local repository and always clone from GitHub.
    [switch]$GitHubOnly,

    # Re-land a family even when data/fw/<FAMILY> already exists.
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$fwRoot = Join-Path $repoRoot "data\fw"
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "stm32ck-fw"
New-Item -ItemType Directory -Force $fwRoot | Out-Null

if ($All) {
    $Families = Get-ChildItem (Join-Path $repoRoot "data") -Filter "*.irpack" |
        ForEach-Object { $_.BaseName.ToUpper() } | Sort-Object
    if (-not $Families) { throw "-All needs data/*.irpack; run stm32ck-import first" }
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# Copy $Source/<sub> into $Dest/<sub> recursively, keeping only what a
# generated project needs.
function Copy-Component {
    param([string]$Source, [string]$Dest, [string[]]$Subdirs)

    New-Item -ItemType Directory -Force $Dest | Out-Null
    foreach ($sub in $Subdirs) {
        $from = Join-Path $Source $sub
        if (-not (Test-Path $from)) { continue }
        $to = Join-Path $Dest $sub
        New-Item -ItemType Directory -Force $to | Out-Null
        Get-ChildItem $from -Recurse -File |
            Where-Object { $_.Extension -in @(".c", ".h", ".s", ".S", ".ld", ".txt", ".md") } |
            ForEach-Object {
                $rel = $_.FullName.Substring($from.Length).TrimStart("\")
                $target = Join-Path $to $rel
                New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
                Copy-Item $_.FullName $target -Force
            }
    }
    # Licence text sits at the component root (LICENSE.txt / LICENSE.md /
    # License.md depending on the vintage) — redistribution requires it.
    Get-ChildItem $Source -File |
        Where-Object { $_.Name -match '^(LICENSE|License)\.(txt|md)$' } |
        ForEach-Object { Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force }
}

function Test-Repo {
    param([string]$Name)
    git ls-remote --exit-code "https://github.com/STMicroelectronics/$Name.git" HEAD *> $null
    $ok = $LASTEXITCODE -eq 0
    $global:LASTEXITCODE = 0     # a probe miss is an answer, not a failure
    return $ok
}

# Shallow clone into a scratch directory and return its path.
function Clone-Scratch {
    param([string]$Name, [string[]]$SparsePaths)

    $dest = Join-Path $tmpRoot $Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    $url = "https://github.com/STMicroelectronics/$Name.git"

    if ($SparsePaths) {
        # Blobless + sparse: a full Cube package is multiple GB, of which we
        # want Drivers/ only.
        git clone --depth 1 --filter=blob:none --sparse $url $dest
        if ($LASTEXITCODE -ne 0) { throw "git clone of $Name failed ($LASTEXITCODE)" }
        git -C $dest sparse-checkout set @SparsePaths
        if ($LASTEXITCODE -ne 0) { throw "sparse-checkout of $Name failed ($LASTEXITCODE)" }
    } else {
        git clone --depth 1 $url $dest
        if ($LASTEXITCODE -ne 0) { throw "git clone of $Name failed ($LASTEXITCODE)" }
    }
    return $dest
}

# Drivers/ -> data/fw/<FAMILY>. Shared by the local-repository and full-package
# sources, which have identical layout. The HAL directory is globbed rather
# than spelled: WB0 ships STM32WB0x_HAL_Driver, not STM32WB0xx_HAL_Driver.
function Land-FromDrivers {
    param([string]$Family, [string]$Drivers, [string]$Provenance)

    $hal = Get-ChildItem $Drivers -Directory -Filter "STM32*_HAL_Driver" |
        Select-Object -First 1
    $dev = Get-ChildItem (Join-Path $Drivers "CMSIS\Device\ST") -Directory -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $hal -or -not $dev) { return $false }

    $famRoot = Join-Path $fwRoot $Family
    Copy-Component -Source $hal.FullName -Dest (Join-Path $famRoot "HAL_Driver")  -Subdirs @("Inc", "Src")
    Copy-Component -Source $dev.FullName -Dest (Join-Path $famRoot "CMSIS_Device") -Subdirs @("Include", "Source\Templates")
    Set-Content -Path (Join-Path $famRoot "SOURCE.txt") -Value @(
        "Component source: $Provenance"
        "HAL_Driver:   Drivers/$($hal.Name)"
        "CMSIS_Device: Drivers/CMSIS/Device/ST/$($dev.Name)"
    )
    Write-Host "  landed $Family from $Provenance"
    return $true
}

function Land-FromCubeRepository {
    param([string]$Family, [string]$Repository)

    if (-not (Test-Path $Repository)) { return $false }
    $suffix = $Family.Substring(5).ToUpper()        # STM32H7 -> H7
    $pack = Get-ChildItem $Repository -Directory -Filter "STM32Cube_FW_${suffix}_V*" |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $pack) { return $false }
    return Land-FromDrivers -Family $Family -Drivers (Join-Path $pack.FullName "Drivers") `
        -Provenance "local repository $($pack.Name)"
}

# ST's per-component repositories. Naming is not mechanical — the series
# suffix is spelled as the HAL header prefix ("stm32wb0x", "stm32wl3x"), and
# some repos still carry the pre-rename underscore form — so candidates are
# probed and the first that resolves wins.
function Land-FromComponentRepos {
    param([string]$Family)

    $s = $Family.Substring(5).ToLower()             # STM32WB0 -> wb0
    $halNames = @("stm32${s}xx-hal-driver", "stm32${s}x-hal-driver", "stm32${s}xx_hal_driver")
    $devNames = @("cmsis-device-${s}", "cmsis_device_${s}")

    $halRepo = $halNames | Where-Object { Test-Repo $_ } | Select-Object -First 1
    $devRepo = $devNames | Where-Object { Test-Repo $_ } | Select-Object -First 1
    if (-not $halRepo -or -not $devRepo) { return $false }

    $famRoot = Join-Path $fwRoot $Family
    $halSrc = Clone-Scratch -Name $halRepo
    Copy-Component -Source $halSrc -Dest (Join-Path $famRoot "HAL_Driver") -Subdirs @("Inc", "Src")
    $devSrc = Clone-Scratch -Name $devRepo
    Copy-Component -Source $devSrc -Dest (Join-Path $famRoot "CMSIS_Device") -Subdirs @("Include", "Source\Templates")
    Remove-Item $halSrc, $devSrc -Recurse -Force

    Set-Content -Path (Join-Path $famRoot "SOURCE.txt") -Value @(
        "Component source: github.com/STMicroelectronics"
        "HAL_Driver:   $halRepo"
        "CMSIS_Device: $devRepo"
    )
    Write-Host "  landed $Family from $halRepo + $devRepo"
    return $true
}

# Full Cube package (STM32CubeMP1, ...) for families ST never split into
# component repos.
function Land-FromCubePackage {
    param([string]$Family)

    $suffix = $Family.Substring(5).ToUpper()
    $repo = "STM32Cube$suffix"
    if (-not (Test-Repo $repo)) { return $false }
    $src = Clone-Scratch -Name $repo -SparsePaths @("Drivers")
    $ok = Land-FromDrivers -Family $Family -Drivers (Join-Path $src "Drivers") -Provenance "github.com/STMicroelectronics/$repo"
    Remove-Item $src -Recurse -Force
    return $ok
}

# One CMSIS core for the whole tree: it is core-generic (core_cm0.h ..
# core_cm55.h in one Include/) and identical for every family, so 27 copies
# would be 27x the same 2.7 MB.
function Land-CmsisCore {
    $dest = Join-Path $fwRoot "CMSIS_Core"
    if ((Test-Path (Join-Path $dest "Include")) -and -not $Force) {
        Write-Host "skip (exists): CMSIS_Core"
        return
    }
    $src = Clone-Scratch -Name "cmsis-core"
    # Layout differs across snapshots: Include/ at the root or under CMSIS/Core.
    $sub = @("Include", "CMSIS\Core\Include") | Where-Object { Test-Path (Join-Path $src $_) } | Select-Object -First 1
    Copy-Component -Source $src -Dest $dest -Subdirs @($sub)
    if ($sub -ne "Include") {
        Move-Item (Join-Path $dest $sub) (Join-Path $dest "Include") -Force
    }
    Remove-Item $src -Recurse -Force
    Set-Content -Path (Join-Path $dest "SOURCE.txt") -Value "Component source: github.com/STMicroelectronics/cmsis-core"
    Write-Host "landed CMSIS_Core (shared by all families)"
}

# ---------------------------------------------------------------------------

Land-CmsisCore

$failed = @()
foreach ($fam in $Families) {
    $famRoot = Join-Path $fwRoot $fam
    if ((Test-Path (Join-Path $famRoot "HAL_Driver\Src")) -and -not $Force) {
        Write-Host "skip (exists): $fam  (use -Force to re-land)"
        continue
    }
    Write-Host "$fam :"
    $landed = $false
    if (-not $GitHubOnly) {
        $landed = Land-FromCubeRepository -Family $fam -Repository $CubeRepository
    }
    if (-not $landed) { $landed = Land-FromComponentRepos -Family $fam }
    if (-not $landed) { $landed = Land-FromCubePackage -Family $fam }
    if (-not $landed) {
        Write-Warning "$fam : no firmware source found (no local pack, no component repos, no STM32Cube package)"
        $failed += $fam
        if (Test-Path $famRoot) { Remove-Item $famRoot -Recurse -Force }
    }
}

if (Test-Path $tmpRoot) { Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
if ($failed) {
    Write-Host ""
    Write-Warning "no firmware for: $($failed -join ', ') — these families stay IR-pack only (list/describe/validate work, generate does not)"
}
Write-Host "done."
exit 0
