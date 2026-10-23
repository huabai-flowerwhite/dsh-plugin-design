# install.ps1 — install / upgrade dsh-plugin-design (Windows)
#
# Preferred (DSH 0.1.5+): the official plugin manager picks the bundle up:
#   dsh plugin --profile web add <this directory>
#
# Fallback (no `dsh` CLI on PATH): link the package into the profile's
# node_modules and add one insert row to the profile patch. The two paths are
# mutually exclusive: installing both ways would mount the plugin twice.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Mode link
#
# Environment overrides: DSH_HOME, DSH_PROFILE, DSH_CLI.

param(
    [ValidateSet('auto', 'plugin', 'link')]
    [string]$Mode = 'auto',
    [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' })
)

$ErrorActionPreference = 'Stop'
$PluginDir = $PSScriptRoot
$PluginName = 'dsh-plugin-design'

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrEmpty($DshHome)) { $DshHome = Join-Path $HOME '.dsh' }

$ProfileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $ProfileDir)) {
    Write-Host "[$PluginName] profile dir not found: $ProfileDir" -ForegroundColor Yellow
    Write-Host "  Run dsh at least once first (dsh web), then re-run this script." -ForegroundColor Yellow
    exit 1
}

function Get-ProfileManifest {
    $path = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path $path)) { return $null }
    try { return Get-Content $path -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-BundleInstalled {
    $pkg = Get-ProfileManifest
    if ($null -eq $pkg) { return $false }
    if ($null -eq $pkg.dsh -or $null -eq $pkg.dsh.profile) { return $false }
    return @($pkg.dsh.profile.bundles) -contains $PluginName
}

function Get-DshCli {
    if ($env:DSH_CLI -and (Test-Path $env:DSH_CLI)) { return $env:DSH_CLI }
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    return $null
}

function Invoke-DshPlugin([string[]]$Arguments) {
    & $script:DshCli @Arguments
    return $LASTEXITCODE
}

$DshCli = $null
if ($Mode -ne 'link') { $DshCli = Get-DshCli }

if ($Mode -ne 'link' -and $null -eq $DshCli) {
    if ($Mode -eq 'plugin') {
        Write-Host "[$PluginName] no dsh CLI found (PATH or DSH_CLI). Use -Mode link as a fallback." -ForegroundColor Red
        exit 1
    }
    Write-Host "[$PluginName] no dsh CLI found; falling back to link mode." -ForegroundColor Yellow
    $Mode = 'link'
}

if ($Mode -ne 'link') {
    Write-Host "[$PluginName] installing as an official bundle via: $DshCli" -ForegroundColor Cyan
    $ProfilePatch = Join-Path $ProfileDir 'cordis.patch.yml'
    if ((Test-Path $ProfilePatch) -and ((Get-Content $ProfilePatch -Raw) -match "id:\s*$([regex]::Escape($PluginName))")) {
        Write-Host "[$PluginName] the profile patch still contains a $PluginName row; bundle install plus that row would mount the plugin twice." -ForegroundColor Red
        Write-Host "  Remove the row from $ProfilePatch first, then re-run this script." -ForegroundColor Red
        exit 1
    }
    if (Test-BundleInstalled) {
        Write-Host "[$PluginName] already listed in profile bundles; removing before re-adding (HMR refuses install-over-install)." -ForegroundColor Yellow
        Invoke-DshPlugin -Arguments @('plugin', '--profile', $Profile, 'remove', $PluginName) | Out-Null
    }
    $exit = Invoke-DshPlugin -Arguments @('plugin', '--profile', $Profile, 'add', $PluginDir)
    if ($exit -ne 0) {
        Write-Host "[$PluginName] 'dsh plugin add' failed with exit code $exit." -ForegroundColor Red
        Write-Host "  Check the pnpm output above (build scripts, registry, engines.dsh)." -ForegroundColor Red
        exit $exit
    }
    if (-not (Test-BundleInstalled)) {
        Write-Host "[$PluginName] installed, but the profile bundle list does not contain $PluginName." -ForegroundColor Yellow
        Write-Host "  Check $ProfileDir\package.json." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[$PluginName] installed as a bundle. Restart dsh (or let HMR reload) and refresh the page." -ForegroundColor Green
    Write-Host "  Chat: 12 dshpd_* tools · Settings → dsh plugin design" -ForegroundColor Green
    exit 0
}

# ---- fallback: link + profile patch (no official CLI) ----------------------
Write-Host "[$PluginName] fallback link mode (no official bundle install)." -ForegroundColor Yellow
if (Test-BundleInstalled) {
    Write-Host "[$PluginName] the profile already selects this bundle; do NOT also add a profile patch row (it would mount twice)." -ForegroundColor Yellow
    Write-Host "  Remove it with: dsh plugin --profile $Profile remove $PluginName" -ForegroundColor Yellow
    exit 0
}

$NodeModulesDirs = @(
    (Join-Path $DshHome 'profiles\node_modules'),
    (Join-Path $ProfileDir 'node_modules')
)

foreach ($NodeModules in $NodeModulesDirs) {
    if (-not (Test-Path $NodeModules)) {
        if ($NodeModules -eq $NodeModulesDirs[1]) { continue }
        New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null
    }
    $Link = Join-Path $NodeModules $PluginName
    if (Test-Path $Link) {
        $item = Get-Item $Link -Force
        if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
            cmd /c rmdir "$Link" 2>$null | Out-Null
            if (Test-Path $Link) { Remove-Item $Link -Force -ErrorAction SilentlyContinue }
        } elseif ($item.PSIsContainer) {
            Write-Host "[$PluginName] $Link is a real directory; remove it manually, then re-run." -ForegroundColor Red
            exit 1
        }
    }
    New-Item -ItemType Junction -Path $Link -Target $PluginDir | Out-Null
    Write-Host "[$PluginName] junction created: $Link -> $PluginDir" -ForegroundColor Green
}

$Patch = Join-Path $ProfileDir 'cordis.patch.yml'
$content = if (Test-Path $Patch) { Get-Content $Patch -Raw } else { '' }
if ($content -match "id:\s*$([regex]::Escape($PluginName))") {
    Write-Host "[$PluginName] profile patch already contains this row; skipped." -ForegroundColor Green
} else {
    $block = "`n# $PluginName - host composition (global tools + settings UI)`n- insert:`n    - id: $PluginName`n      name: '$PluginName'`n"
    Add-Content -Path $Patch -Value $block
    Write-Host "[$PluginName] wrote: $Patch" -ForegroundColor Green
}

Write-Host ""
Write-Host "[$PluginName] install complete (link mode)." -ForegroundColor Green
Write-Host "  Restart dsh, then refresh the page: 12 dshpd_* tools · Settings → dsh plugin design."
