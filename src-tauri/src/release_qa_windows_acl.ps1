# Embedded OS-only QA ownership check. Never load a user PowerShell profile.
$ErrorActionPreference = 'Stop'

function Reject-QaAcl([string]$Reason) {
    # Fixed reasons only: no profile content, full paths or caller-supplied text.
    [Console]::Error.WriteLine("QA ACL: $Reason")
    exit 1
}

function Test-WebViewNetworkAce($Ace, [string]$Path, [string]$Root, [bool]$Directory) {
    # Chromium Sid::FromNamedCapability hashes uppercase UTF-16LE of
    # lpacEdgeStableNetworkSandbox. This identity is channel-wide, NOT profile-specific.
    $networkSid = 'S-1-15-3-1024-3239966617-1410756637-3494353204-65451782-2225605771-3526040376-1730753648-3419555762'
    if ($Ace -isnot [Security.AccessControl.CommonAce] -or
        $Ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
        $Ace.SecurityIdentifier.Value -ne $networkSid) { return $false }
    $prefix = $Root.TrimEnd('\') + '\'
    if (!$Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $parts = $Path.Substring($prefix.Length).Split('\')
    if ($parts.Count -lt 4 -or $parts[0] -ine 'webview' -or
        $parts[1] -ine 'EBWebView' -or $parts[2] -ine 'Default' -or
        $parts[3] -notin @('Cache', 'Network', 'Shared Dictionary') -or
        @($parts | Where-Object { $_ -in @('', '.', '..') }).Count) { return $false }
    # Use raw ACEs: .NET access-rule views can merge flags and display masks signed.
    $mask = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Ace.AccessMask), 0)
    $flags = [int]$Ace.AceFlags
    if ($parts.Count -eq 4) {
        return $Directory -and (($mask -eq 0x001301bf -and $flags -eq 0) -or
            ($mask -eq [uint32]3758161920 -and $flags -eq 11)) # 0xe0010000; OI CI IO
    }
    return ($mask -eq 0x001301bf -and $flags -eq 16) -or
        ($Directory -and $mask -eq [uint32]3758161920 -and $flags -eq 27) # OI CI IO ID
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $user = $identity.User.Value
    $tokenOwner = $identity.Owner.Value
    $root = $env:MYTHRA_QA_OWNER_PATH
    $paths = @($root)
    if ($env:MYTHRA_QA_CHECK_TREE -eq '1') {
        $paths += @([IO.Directory]::EnumerateFileSystemEntries($root, '*', [IO.SearchOption]::AllDirectories))
    }
    foreach ($path in $paths) {
        $directory = [IO.Directory]::Exists($path)
        $item = if ($directory) { [IO.DirectoryInfo]::new($path) } else { [IO.FileInfo]::new($path) }
        $item.Refresh()
        if (!$item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Reject-QaAcl 'missing entry or reparse point' }
        $acl = $item.GetAccessControl()
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $protectedRoot = $env:MYTHRA_QA_REQUIRE_PROTECTED -eq '1' -and $path -eq $root
        if (($owner -ne $user -and ($protectedRoot -or $owner -ne $tokenOwner))) { Reject-QaAcl 'foreign owner' }
        if ($protectedRoot -and !$acl.AreAccessRulesProtected) { Reject-QaAcl 'unprotected root' }
        $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
        if ($null -eq $raw.DiscretionaryAcl) { Reject-QaAcl 'null DACL' }
        foreach ($ace in $raw.DiscretionaryAcl) {
            # Keep ordinary user/SYSTEM/Admin grants and deny handling unchanged.
            if ($ace -isnot [Security.AccessControl.QualifiedAce]) { Reject-QaAcl 'unknown ACE type' }
            if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
            if ($ace.SecurityIdentifier.Value -in @($user, 'S-1-5-18', 'S-1-5-32-544')) { continue }
            if (!(Test-WebViewNetworkAce $ace $path $root $directory)) { Reject-QaAcl 'unexpected allow principal, browser path, mask or flags' }
        }
    }
} catch { Reject-QaAcl 'descriptor inspection failed' }
