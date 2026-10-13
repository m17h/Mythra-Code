# Windows half of scripts/release.mjs. The Mac copies this file to the Windows
# PC and runs it over SSH. It checks out the exact release commit in a
# persistent build checkout (keeping node_modules and the Cargo target cache
# warm between releases) and runs the normal Windows builder.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BuildDir,
  [string]$Commit = "",
  [string]$Version = "",
  [string]$Repository = "",
  # Only stop processes left by an interrupted run, then exit.
  [switch]$StopOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-Git {
  & git @args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE."
  }
}

if (-not $StopOnly -and (-not $Commit -or -not $Version -or -not $Repository)) {
  throw "Commit, Version and Repository are required unless -StopOnly is given."
}

# Windows keeps processes running after an SSH session drops, so an interrupted
# earlier run can still be building here. Stop every process tree that runs
# from, or names, this dedicated build directory, except this runner and the
# SSH shell that launched it.
$buildPrefix = [IO.Path]::GetFullPath($BuildDir).TrimEnd('\')
$processes = @(Get-CimInstance Win32_Process)
$parents = @{}
foreach ($process in $processes) { $parents[[int]$process.ProcessId] = [int]$process.ParentProcessId }
$ancestors = @{}
$cursor = $PID
while ($cursor -and -not $ancestors.ContainsKey($cursor)) {
  $ancestors[$cursor] = $true
  $cursor = $parents[$cursor]
}
$leftovers = @($processes | Where-Object {
  -not $ancestors.ContainsKey([int]$_.ProcessId) -and (
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($buildPrefix + '\', [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($buildPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0))
})
foreach ($process in $leftovers) {
  Write-Output "Stopping leftover process $($process.ProcessId) ($($process.Name)) from an interrupted run"
  & cmd.exe /d /c "taskkill /PID $($process.ProcessId) /T /F >nul 2>&1"
}
if ($leftovers.Count) { Start-Sleep -Seconds 2 }
if ($StopOnly) {
  Write-Output "Stopped $($leftovers.Count) leftover process(es) on $env:COMPUTERNAME."
  exit 0
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
