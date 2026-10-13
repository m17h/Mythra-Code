# Windows half of scripts/release.mjs. The Mac copies this file to the Windows
# PC and runs it over SSH. It checks out the exact release commit in a
# persistent build checkout (keeping node_modules and the Cargo target cache
# warm between releases) and runs the normal Windows builder.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BuildDir,
  [Parameter(Mandatory = $true)][string]$Commit,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Repository
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-Git {
  & git @args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE."
  }
}

Write-Output "Windows release build on $env:COMPUTERNAME for $Version at $Commit"
if (-not (Test-Path -LiteralPath (Join-Path $BuildDir ".git"))) {
  Write-Output "Cloning $Repository into $BuildDir (first build is cold and slower)"
  Invoke-Git -c core.autocrlf=false clone --quiet --no-checkout $Repository $BuildDir
}
Invoke-Git -C $BuildDir config core.autocrlf false
Invoke-Git -C $BuildDir fetch --quiet origin
Invoke-Git -C $BuildDir checkout --quiet --force --detach $Commit
# Remove untracked files but keep ignored node_modules/ and src-tauri/target/.
Invoke-Git -C $BuildDir clean -fdq

$package = Get-Content -LiteralPath (Join-Path $BuildDir "package.json") -Raw | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
  throw "Commit $Commit is version $($package.version), not $Version."
}

& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $BuildDir "Windows\build.ps1") -ExpectedCommit $Commit
if ($LASTEXITCODE -ne 0) {
  throw "Windows\build.ps1 failed with exit code $LASTEXITCODE."
}
Write-Output "Windows release build finished."
