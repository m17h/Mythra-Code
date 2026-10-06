$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$wrapper = Join-Path $PSScriptRoot 'release-build-job.ps1'
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('mythra-build-job-test-' + [guid]::NewGuid().ToString('N'))
$probeRoot = Join-Path $workspace 'probe'
$stdout = Join-Path $workspace 'stdout.log'
$stderr = Join-Path $workspace 'stderr.log'
$process = $null
try {
  New-Item -ItemType Directory -Path $probeRoot | Out-Null
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $wrapper + '"'), '-Probe', '-ProbeDirectory', ('"' + $probeRoot + '"'))
  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath (Join-Path $probeRoot 'grandchild.json'))) {
    $process.Refresh()
    if ($process.HasExited) { throw ('Probe exited before creating its child tree: ' + (Get-Content -LiteralPath $stderr -Raw)) }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Probe startup deadline exceeded.' }
    Start-Sleep -Milliseconds 50
  }
  $builder = Get-Content -LiteralPath (Join-Path $probeRoot 'builder.json') -Raw | ConvertFrom-Json
  $grandchild = Get-Content -LiteralPath (Join-Path $probeRoot 'grandchild.json') -Raw | ConvertFrom-Json
  if ($builder.parent -ne $process.Id -or $grandchild.parent -ne $builder.pid -or $builder.grandchild -ne $grandchild.pid) { throw 'Probe process identities do not form the owned tree.' }
  if (-not (Get-Process -Id $builder.pid -ErrorAction SilentlyContinue) -or -not (Get-Process -Id $grandchild.pid -ErrorAction SilentlyContinue)) { throw 'Probe descendant exited unexpectedly.' }
  Stop-Process -Id $process.Id -Force
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id $builder.pid -ErrorAction SilentlyContinue) -or (Get-Process -Id $grandchild.pid -ErrorAction SilentlyContinue)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Native job left a live descendant after wrapper termination.' }
    Start-Sleep -Milliseconds 50
  }
  $capturedOutput = Get-Content -LiteralPath $stdout -Raw
  $capturedError = Get-Content -LiteralPath $stderr -Raw
  if ($capturedOutput -notmatch 'MYTHRA_JOB_STDOUT' -or $capturedError -notmatch 'MYTHRA_JOB_STDERR') { throw 'Build standard output/error was not inherited.' }

  # Exercise normal exit propagation through the same compiled containment code.
  $source = Get-Content -LiteralPath $wrapper -Raw
  $type = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  if (-not $type) { throw 'Cannot locate the containment implementation.' }
  Add-Type -TypeDefinition $type
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  $result = [MythraReleaseBuildJob]::Run($node, @('-e', 'process.exit(7)'), $workspace)
  if ($result -ne 7) { throw "Child exit code was not preserved: $result" }
  [ordered]@{ jobContainment = 'passed'; stdout = 'passed'; stderr = 'passed'; exitCode = 'passed'; builderPid = $builder.pid; grandchildPid = $grandchild.pid; noReleaseBuild = $true } | ConvertTo-Json -Compress
} finally {
  if ($process) { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } }
  if (Test-Path -LiteralPath $workspace) { Remove-Item -LiteralPath $workspace -Recurse -Force }
}
