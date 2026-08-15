[CmdletBinding()]
param(
  [string]$ExpectedCommit = "",
  [switch]$AllowDirty,
  [switch]$AllowUnsigned,
  [switch]$SkipInstall,
  [switch]$SkipVerify,
  [switch]$SkipLaunchSmoke
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot "package.json"
$tauriConfigPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$bundleDirectory = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
$binaryPath = Join-Path $repoRoot "src-tauri\target\release\openkiwi.exe"
$outputDirectory = Join-Path $repoRoot "RELEASE ASSETS"
$releaseRepository = "m17h/OpenKiwi-Windows"
$signingConfigPath = Join-Path $env:TEMP "OpenKiwi-tauri-windows-signing-$PID.json"
Set-Location -LiteralPath $repoRoot

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE."
  }
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "OpenKiwi's Windows release currently requires 64-bit Windows."
}
if (-not (Test-Path $packagePath) -or -not (Test-Path $tauriConfigPath)) {
  throw "Run Windows/build.ps1 from an OpenKiwi checkout."
}

# Clear the previous release before starting. This prevents a failed build from
# leaving stale artifacts that could be mistaken for the current release.
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}
$resolvedRepoRoot = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($outputDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutputDirectory.StartsWith($resolvedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clear release assets outside the repository: $resolvedOutputDirectory"
}
Get-ChildItem -LiteralPath $outputDirectory -Force |
  Where-Object { $_.Name -ne "README.md" } |
  Remove-Item -Recurse -Force

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  throw "TAURI_SIGNING_PRIVATE_KEY is required to sign the Windows updater artifact."
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  throw "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required to sign the Windows updater artifact."
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]$tauriConfig.version -ne $version) {
  throw "Version mismatch: package.json=$version, tauri.conf.json=$($tauriConfig.version)."
}

$head = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $head) {
  throw "Could not resolve the source commit."
}
if ($ExpectedCommit -and $head -ne $ExpectedCommit) {
  throw "Windows checkout is at $head, expected $ExpectedCommit."
}

$dirtyTree = (& git -C $repoRoot status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect the Git working tree."
}
if ($dirtyTree -and -not $AllowDirty) {
  throw "Refusing to build Windows from a dirty working tree:`n$dirtyTree"
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm -or -not $npx) {
  throw "Node.js/npm is not installed or is not available on PATH."
}

if (-not $SkipInstall) {
  Invoke-Checked -Command $npm -Arguments @("ci")
}
if (-not $SkipVerify) {
  Invoke-Checked -Command $npm -Arguments @("run", "verify")
}

$certificateThumbprint = [string]$env:OPENKIWI_WINDOWS_CERTIFICATE_THUMBPRINT
if (-not $certificateThumbprint) {
  $availableCertificates = @(
    Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
      Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt [DateTime]::Now }
  )
  if ($availableCertificates.Count -eq 1) {
    $certificateThumbprint = [string]$availableCertificates[0].Thumbprint
  } elseif ($availableCertificates.Count -gt 1) {
    throw "Multiple valid code-signing certificates are installed. Set OPENKIWI_WINDOWS_CERTIFICATE_THUMBPRINT to select one."
  }
}
if (-not $certificateThumbprint -and -not $AllowUnsigned) {
  throw "No trusted Authenticode code-signing certificate is available. Install one or rerun only with an explicitly approved -AllowUnsigned override."
}

$tauriArguments = @("tauri", "build", "--bundles", "nsis")
if ($certificateThumbprint) {
  $certificate = Get-ChildItem "Cert:\CurrentUser\My\$certificateThumbprint" -ErrorAction SilentlyContinue
  if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -le [DateTime]::Now) {
    throw "The selected Authenticode certificate is missing, expired, or lacks its private key."
  }
  $signingConfig = [ordered]@{
    bundle = [ordered]@{
      windows = [ordered]@{
        certificateThumbprint = $certificateThumbprint
        digestAlgorithm = "sha256"
        timestampUrl = if ($env:OPENKIWI_WINDOWS_TIMESTAMP_URL) { $env:OPENKIWI_WINDOWS_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
      }
    }
  }
  $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($signingConfigPath, ($signingConfig | ConvertTo-Json -Depth 4), $utf8WithoutBom)
  $tauriArguments += @("--config", $signingConfigPath)
}

if (Test-Path $bundleDirectory) {
  Remove-Item -LiteralPath $bundleDirectory -Recurse -Force
}
try {
  Invoke-Checked -Command $npx -Arguments $tauriArguments
} finally {
  if (Test-Path -LiteralPath $signingConfigPath) {
    Remove-Item -LiteralPath $signingConfigPath -Force
  }
}

$installerName = "OpenKiwi_${version}_x64-setup.exe"
$installerPath = Join-Path $bundleDirectory $installerName
$signaturePath = "$installerPath.sig"
foreach ($artifact in @($binaryPath, $installerPath, $signaturePath)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Missing Windows release artifact: $artifact"
  }
}
if ((Get-Item -LiteralPath $signaturePath).Length -le 0) {
  throw "The Windows updater signature is empty."
}

$peBytes = [System.IO.File]::ReadAllBytes($binaryPath)
if ($peBytes.Length -lt 256) {
  throw "Native Windows executable is too small to contain a valid PE header."
}
$peHeaderOffset = [BitConverter]::ToInt32($peBytes, 0x3c)
$subsystemOffset = $peHeaderOffset + 24 + 68
if ($peHeaderOffset -lt 0 -or $subsystemOffset + 2 -gt $peBytes.Length) {
  throw "Native Windows executable has an invalid PE header."
}
$peSubsystem = [BitConverter]::ToUInt16($peBytes, $subsystemOffset)
if ($peSubsystem -ne 2) {
  throw "Native Windows executable uses PE subsystem $peSubsystem instead of Windows GUI (2); it would open a background terminal window."
}

$versionInfo = (Get-Item -LiteralPath $installerPath).VersionInfo
if ([string]$versionInfo.ProductVersion -ne $version -or [string]$versionInfo.FileVersion -ne $version) {
  throw "Installer version mismatch: expected $version, product=$($versionInfo.ProductVersion), file=$($versionInfo.FileVersion)."
}

$authenticode = Get-AuthenticodeSignature -LiteralPath $installerPath
$authenticodeStatus = [string]$authenticode.Status
if ($authenticodeStatus -ne "Valid" -and -not $AllowUnsigned) {
  throw "The Windows installer is not Authenticode-signed (status: $authenticodeStatus). Install a trusted code-signing certificate or rerun only with an explicitly approved -AllowUnsigned override."
}

if (-not $SkipLaunchSmoke) {
  $process = Start-Process -FilePath $binaryPath -PassThru
  try {
    Start-Sleep -Seconds 5
    if ($process.HasExited) {
      throw "OpenKiwi exited during the Windows launch smoke test with code $($process.ExitCode)."
    }
  } finally {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
  }
}

Copy-Item -LiteralPath $installerPath -Destination (Join-Path $outputDirectory $installerName)
Copy-Item -LiteralPath $signaturePath -Destination (Join-Path $outputDirectory "$installerName.sig")

$sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$buildInfo = [ordered]@{
  version = $version
  commit = $head
  platform = "windows-x86_64"
  architecture = "x64"
  installer = $installerName
  signature = "$installerName.sig"
  sha256 = $sha256
  authenticodeStatus = $authenticodeStatus
  peSubsystem = "WindowsGui"
  builtAt = [DateTime]::UtcNow.ToString("o")
  dirty = [bool]$dirtyTree
}
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $outputDirectory "build-info.json"), ($buildInfo | ConvertTo-Json), $utf8WithoutBom)

$updaterSignature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
$releaseManifest = [ordered]@{
  version = $version
  notes = "OpenKiwi for Windows $version"
  pub_date = [DateTime]::UtcNow.ToString("o")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $updaterSignature
      url = "https://github.com/$releaseRepository/releases/download/v$version/$installerName"
    }
  }
}
[System.IO.File]::WriteAllText((Join-Path $outputDirectory "latest.json"), ($releaseManifest | ConvertTo-Json -Depth 5), $utf8WithoutBom)

Write-Output "Prepared OpenKiwi $version Windows release assets in $outputDirectory"
Get-ChildItem -LiteralPath $outputDirectory | Sort-Object Name | ForEach-Object { Write-Output "- $($_.Name)" }
if ($authenticodeStatus -ne "Valid") {
  Write-Warning "The installer is updater-signed but not Authenticode-signed. Windows SmartScreen may show Unknown publisher."
}
