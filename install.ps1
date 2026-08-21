# install.ps1 — install dsh-plugin-design into DeepSeek Harness (Windows)
#
# Usage (inside the cloned directory):
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# It does two things, idempotently:
#   1. links the package into node_modules:
#        $DSH_HOME/profiles/node_modules/dsh-plugin-design  ->  this directory
#   2. appends an insert row to $DSH_HOME/profiles/<profile>/cordis.patch.yml

$ErrorActionPreference = 'Stop'

$PluginDir = $PSScriptRoot

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrEmpty($DshHome)) { $DshHome = Join-Path $HOME '.dsh' }

$Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"

if (-not (Test-Path $ProfileDir)) {
    Write-Host "[dsh-plugin-design] profile dir not found: $ProfileDir" -ForegroundColor Yellow
    Write-Host "  Run dsh at least once first (npx dsh web), then re-run this script." -ForegroundColor Yellow
    exit 1
}

# ---- 1) node_modules junction -> plugin directory ----
$NodeModules = Join-Path $DshHome 'profiles\node_modules'
if (-not (Test-Path $NodeModules)) { New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null }
$Link = Join-Path $NodeModules 'dsh-plugin-design'

if (Test-Path $Link) {
    $item = Get-Item $Link -Force
    if ($item.LinkType -eq 'Junction') {
        cmd /c rmdir "$Link" | Out-Null
    } elseif ($item.PSIsContainer) {
        Write-Host "[dsh-plugin-design] $Link is a real directory (not a junction); remove it manually, then re-run." -ForegroundColor Red
        exit 1
    }
}

New-Item -ItemType Junction -Path $Link -Target $PluginDir | Out-Null
Write-Host "[dsh-plugin-design] junction created: $Link -> $PluginDir" -ForegroundColor Green

# ---- 2) append insert row to cordis.patch.yml ----
$Patch = Join-Path $ProfileDir 'cordis.patch.yml'
$content = if (Test-Path $Patch) { Get-Content $Patch -Raw } else { '' }

if ($content -match 'id:\s*dsh-plugin-design') {
    Write-Host "[dsh-plugin-design] cordis.patch.yml already contains this plugin row; skipped." -ForegroundColor Green
} else {
    $block = "`n# dsh plugin design - host composition (global tools + settings UI)`n- insert:`n    - id: dsh-plugin-design`n      name: 'dsh-plugin-design'`n"
    Add-Content -Path $Patch -Value $block
    Write-Host "[dsh-plugin-design] wrote: $Patch" -ForegroundColor Green
}

Write-Host ""
Write-Host "[dsh-plugin-design] Install complete." -ForegroundColor Green
Write-Host "  Restart dsh: press Ctrl+C on the running dsh, then run: npx dsh web"
Write-Host "  After restart: 10 dshpd_* tools in chat; Settings -> dsh plugin design page appears."
