<#
.SYNOPSIS
  Install or update dsh-plugin-design through the official DSH plugin manager.

.DESCRIPTION
  The script never removes the installed package first: installing over an
  existing version is the official update path, and a failed install must not
  leave the profile without a working plugin. Output and exit codes are kept
  separate, so a command that prints text and exits 0 is not mistaken for a
  failure.

  Dev-only link mode (-Link) is explicit; it is never an automatic fallback,
  because a linked directory cannot be reproduced on another machine.

.PARAMETER Profile
  DSH profile to install into (default: web).

.PARAMETER Link
  Development only: install as `link:<this directory>`. The installed plugin
  then depends on this machine's source tree.

.PARAMETER DryRun
  Print the exact command without running it.

.PARAMETER Cli
  Explicit DSH CLI command (default: DSHPD_CLI, then `dsh` on PATH).
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [switch]$Link,
  [switch]$DryRun,
  [string]$Cli = ''
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-plugin-design'
$packageRoot = $PSScriptRoot

function Resolve-DshCli {
  if ($Cli -ne '') { return $Cli }
  if ($env:DSHPD_CLI) { return $env:DSHPD_CLI }
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw 'dsh CLI not found. Install the DSH CLI, or pass -Cli / set DSHPD_CLI. This script will not fall back to editing a profile directly.'
  }
  return $command.Source
}

# Run one CLI invocation. Its output goes to the host stream; only the integer
# exit code is returned, so callers cannot mistake stdout for a failure.
function Invoke-DshCli {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  # Pipe stdout to Write-Host so it reaches the console but never the
  # function's return value: otherwise `$code = Invoke-DshCli ...` becomes an
  # array of output lines and the real exit code is lost.
  & $Command @Arguments | Write-Host
  return $LASTEXITCODE
}

$spec = if ($Link) { 'link:' + $packageRoot } else { $packageRoot }
$cliPath = Resolve-DshCli
$addArguments = @('plugin', '--profile', $Profile, 'add', $spec)

if ($DryRun) {
  Write-Host ('DRY-RUN: "' + $cliPath + '" ' + ($addArguments -join ' '))
  exit 0
}

if ($Link) {
  Write-Warning 'Link mode installs a junction to this source directory; it is not a distributable installation.'
}

Write-Host ('Installing ' + $packageName + ' into profile "' + $Profile + '" (no remove-then-add).')
$addCode = Invoke-DshCli -Command $cliPath -Arguments $addArguments
if ($addCode -ne 0) {
  # Write to stderr without Write-Error: under ErrorActionPreference=Stop the
  # latter is terminating and would replace the real exit code with 1.
  [Console]::Error.WriteLine('Installation failed with exit code ' + $addCode + '. The previous installation was not removed; fix the cause and retry.')
  exit $addCode
}

$verifyCode = Invoke-DshCli -Command $cliPath -Arguments @('plugin', '--profile', $Profile, 'why', $packageName)
if ($verifyCode -ne 0) {
  Write-Warning ('The install command succeeded but `dsh plugin why ' + $packageName + '` failed with exit code ' + $verifyCode + '.')
}

Write-Host ('Installed. Restart the DSH ' + $Profile + ' client so the Host/Client halves are composed.')
exit 0
