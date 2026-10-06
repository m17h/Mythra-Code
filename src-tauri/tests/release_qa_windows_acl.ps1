# Actual Windows descriptor fixtures; never reads or launches an application profile.
param([Parameter(Mandatory=$true)][string]$Checker)
$ErrorActionPreference = 'Stop'
$checkerPath = (Resolve-Path -LiteralPath $Checker).Path
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$capability = 'S-1-15-3-1024-3239966617-1410756637-3494353204-65451782-2225605771-3526040376-1730753648-3419555762'
$base = Join-Path ([IO.Path]::GetTempPath()) ('mythra-acl-test-' + [guid]::NewGuid())
$previous = @($env:MYTHRA_QA_OWNER_PATH, $env:MYTHRA_QA_CHECK_TREE, $env:MYTHRA_QA_REQUIRE_PROTECTED)
$count = 0
$junctions = @()
function PrivateDirectory([string]$Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [void][IO.Directory]::CreateDirectory($Path, $acl)
}
function Add-Ace([string]$Path, [string]$Sid = $capability, [int]$Mask = 0x1301bf, [int]$Flags = 0, [string]$Type = 'common') {
    $item = Get-Item -LiteralPath $Path
    $acl = $item.GetAccessControl()
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $principal = [Security.Principal.SecurityIdentifier]::new($Sid)
    if ($Type -eq 'object') {
        $ace = [Security.AccessControl.ObjectAce]::new($Flags, 'AccessAllowed', $Mask, $principal, 'ObjectAceTypePresent', [guid]::NewGuid(), [guid]::Empty, $false, $null)
    } else {
        $callback = $Type -eq 'callback'
        $ace = [Security.AccessControl.CommonAce]::new($Flags, 'AccessAllowed', $Mask, $principal, $callback, $null)
    }
    $raw.DiscretionaryAcl.InsertAce(0, $ace)
    $bytes = New-Object byte[] $raw.BinaryLength; $raw.GetBinaryForm($bytes, 0)
    $acl.SetSecurityDescriptorBinaryForm($bytes, [Security.AccessControl.AccessControlSections]::Access)
    $item.SetAccessControl($acl)
}
function Check([string]$Root, [bool]$Expected, [string]$Label) {
    $env:MYTHRA_QA_OWNER_PATH = $Root; $env:MYTHRA_QA_CHECK_TREE = '1'; $env:MYTHRA_QA_REQUIRE_PROTECTED = '1'
    # Separate process exercises the exact embedded script including exit/fail-closed behavior.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & $ps -NoProfile -NonInteractive -File $checkerPath 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $passed = $exitCode -eq 0
    if ($passed -ne $Expected) { throw "${Label}: expected pass=$Expected; exit=$exitCode; $result" }
    $script:count++
}
function Case([string]$Label, [string]$Relative, [scriptblock]$Change, [bool]$Directory = $true) {
    $root = Join-Path $base ([guid]::NewGuid().ToString()); PrivateDirectory $root
    $target = if ($Relative) { Join-Path $root $Relative } else { $root }
    if ($Directory) { [void][IO.Directory]::CreateDirectory($target) }
    else { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)); [IO.File]::WriteAllText($target, 'owned fixture') }
    & $Change $target $root
    Check $root $false $Label
}
try {
    PrivateDirectory $base
    $root = Join-Path $base 'valid'; PrivateDirectory $root
    Check $root $true 'ordinary protected root'
    foreach ($anchor in @('Cache', 'Network', 'Shared Dictionary')) {
        $path = Join-Path $root ('webview\EBWebView\Default\' + $anchor)
        [void][IO.Directory]::CreateDirectory($path)
        Add-Ace $path $capability -536805376 11
        Add-Ace $path
        $child = Join-Path $path 'child'; [void][IO.Directory]::CreateDirectory($child)
        [IO.File]::WriteAllText((Join-Path $child 'file'), 'owned fixture')
    }
    Check $root $true 'all three anchors and inherited directory/file ACEs'
    # Independently bind the identity to Chromium's named capability algorithm.
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $hash.ComputeHash([Text.Encoding]::Unicode.GetBytes('LPACEDGESTABLENETWORKSANDBOX')) } finally { $hash.Dispose() }
    $derived = 'S-1-15-3-1024-' + ((0..7 | ForEach-Object { [BitConverter]::ToUInt32($bytes, $_ * 4) }) -join '-')
    if ($derived -ne $capability) { throw 'Named capability identity differs' }
    foreach ($sid in @('S-1-1-0', 'S-1-15-3-1', 'S-1-5-21-111-222-333-1006', 'S-1-5-21-444-555-666-1007', 'S-1-5-21-777-888-999-1008', ($capability + '-1'))) {
        Case ('foreign SID ' + $sid) 'webview\EBWebView\Default\Cache' { param($p) Add-Ace $p $sid }
    }
    foreach ($path in @('', 'webview', 'webview\EBWebView', 'webview\EBWebView\Default', 'webview\EBWebView\Other\Cache', 'webview\EBWebView\Default\CacheOther', 'webview\EBWebView\Default\NetworkOther', 'webview\EBWebView\Default\Local Storage', 'app-data', 'home')) {
        Case ('wrong directory ' + $path) $path { param($p) Add-Ace $p }
    }
    foreach ($path in @('.mythra-release-qa.json', 'profile.lock', 'events.jsonl', 'request.json', 'app-data\openkiwi.sqlite3', 'webview\EBWebView\Default\Cache')) {
        Case ('wrong file ' + $path) $path { param($p) Add-Ace $p } $false
    }
    foreach ($mask in @(0x1f01ff, 0x40000, 0x80000, 0x1301ff, -268369920)) {
        Case ('wrong mask ' + $mask) 'webview\EBWebView\Default\Cache' { param($p) Add-Ace $p $capability $mask }
    }
    Case 'explicit descendant grant' 'webview\EBWebView\Default\Cache\child' { param($p) Add-Ace $p }
    # Windows may strip ACCESS_SYSTEM_SECURITY, map generic masks and normalize
    # inheritance flags when storing a DACL. Exercise those raw descriptors directly
    # against the exact production predicate, rather than claiming the OS retained them.
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($checkerPath,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'Checker parse failed' }
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-WebViewNetworkAce'},$true)
    if (!$definition) { throw 'Missing production ACE predicate' }
    . ([scriptblock]::Create($definition.Extent.Text))
    $principal=[Security.Principal.SecurityIdentifier]::new($capability)
    $anchorPath=Join-Path $root 'webview\EBWebView\Default\Cache'
    $rawCases=@(
        @{mask=0x1301bf;flags=0;dir=$true;child=$false;pass=$true},
        @{mask=-536805376;flags=11;dir=$true;child=$false;pass=$true},
        @{mask=0x1301bf;flags=16;dir=$true;child=$true;pass=$true},
        @{mask=-536805376;flags=27;dir=$true;child=$true;pass=$true},
        @{mask=0x1301bf;flags=16;dir=$false;child=$true;pass=$true},
        @{mask=(0x1301bf -bor 0x1000000);flags=0;dir=$true;child=$false;pass=$false},
        @{mask=-536805376;flags=0;dir=$true;child=$false;pass=$false},
        @{mask=-536805376;flags=19;dir=$true;child=$true;pass=$false},
        @{mask=-536805376;flags=27;dir=$false;child=$true;pass=$false}
    )
    foreach ($flags in @(1,2,3,4,8,16,27)) { $rawCases+=@{mask=0x1301bf;flags=$flags;dir=$true;child=$false;pass=$false} }
    foreach ($case in $rawCases) {
        $ace=[Security.AccessControl.CommonAce]::new($case.flags,'AccessAllowed',$case.mask,$principal,$false,$null)
        $dacl=[Security.AccessControl.RawAcl]::new(2,1); $dacl.InsertAce(0,$ace)
        $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new('DiscretionaryAclPresent',$user,$user,$null,$dacl)
        $bytes=New-Object byte[] $descriptor.BinaryLength; $descriptor.GetBinaryForm($bytes,0)
        $roundTrip=[Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)
        $path=if($case.child){Join-Path $anchorPath 'child'}else{$anchorPath}
        if ((Test-WebViewNetworkAce $roundTrip.DiscretionaryAcl[0] $path $root $case.dir) -ne $case.pass) { throw "Raw descriptor mismatch: $($case|ConvertTo-Json -Compress)" }
    }
    $callback=[Security.AccessControl.CommonAce]::new(0,'AccessAllowed',0x1301bf,$principal,$true,$null)
    $object=[Security.AccessControl.ObjectAce]::new(0,'AccessAllowed',0x1301bf,$principal,'ObjectAceTypePresent',[guid]::NewGuid(),[guid]::Empty,$false,$null)
    foreach($ace in @($callback,$object)) { if(Test-WebViewNetworkAce $ace $anchorPath $root $true){throw 'Unexpected ACE type accepted'} }
    foreach($suffix in @('..\Cache', '.\child', 'child\..\other', '\child')) {
        if(Test-WebViewNetworkAce ([Security.AccessControl.CommonAce]::new(16,'AccessAllowed',0x1301bf,$principal,$false,$null)) ($anchorPath+'\'+$suffix) $root $true){throw 'Unnormalized path accepted'}
    }
    Case 'reparse directory' 'webview\EBWebView\Default\Cache' {
        param($p)
        [IO.Directory]::Delete($p)
        $destination=Join-Path $base 'junction-destination'; [void][IO.Directory]::CreateDirectory($destination)
        $script:junctions += $p
        & cmd.exe /c mklink /J $p $destination | Out-Null
        if($LASTEXITCODE -ne 0){throw 'Cannot construct owned junction fixture'}
    }
    $tokenOwner=[Security.Principal.WindowsIdentity]::GetCurrent().Owner
    if($tokenOwner.Value -ne $user.Value) {
        Case 'root must be user-owned even with an elevated token' '' { param($p) $d=[IO.DirectoryInfo]::new($p);$a=$d.GetAccessControl();$a.SetOwner($tokenOwner);$d.SetAccessControl($a) }
    }
    Case 'unprotected root' '' { param($p) $d=[IO.DirectoryInfo]::new($p);$a=$d.GetAccessControl();$a.SetAccessRuleProtection($false,$true);$d.SetAccessControl($a) }
    Write-Output "Windows QA ACL fixtures passed: $count actual checker invocations; $($rawCases.Count + 2) raw descriptor cases"
} finally {
    $env:MYTHRA_QA_OWNER_PATH=$previous[0];$env:MYTHRA_QA_CHECK_TREE=$previous[1];$env:MYTHRA_QA_REQUIRE_PROTECTED=$previous[2]
    # Only roots atomically created by this fixture, never application/user profiles.
    foreach($junction in $junctions){if(Test-Path -LiteralPath $junction){[IO.Directory]::Delete($junction)}}
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
}
