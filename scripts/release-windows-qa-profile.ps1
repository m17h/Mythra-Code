# OS-only companion for NEW coordinator-owned disposable QA profiles.
# This script provisions or inspects; it never deletes, repairs an existing ACL,
# launches a candidate, changes policy, or touches an installed application profile.
param([ValidateSet('provision','inspect')][string]$Action, [string]$Root, [string]$ProfileId,
      [int]$HostPid = 0, [string]$Executable = '')
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$self=Get-Process -Id $PID
$cursor=[IO.DirectoryInfo]::new($Root).Parent
while($cursor){if($cursor.Exists -and ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked ancestor'};$cursor=$cursor.Parent}
if($Action -eq 'provision') {
    if(Test-Path -LiteralPath $Root){throw 'Refusing pre-existing profile'}
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User);$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($identity.User.Value,'S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    [void][IO.Directory]::CreateDirectory($Root,$acl)
    $marker=[IO.File]::Open((Join-Path $Root '.mythra-release-qa.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes((@{schemaVersion=1;purpose='mythra-release-qa';profileId=$ProfileId}|ConvertTo-Json -Compress));$marker.Write($bytes,0,$bytes.Length);$marker.Flush($true)}finally{$marker.Dispose()}
}
# Inspect ownership of the process doing the operation; no inherited identity claim.
$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$udf=[IO.Path]::Combine($Root,'webview','EBWebView')
$owned=@();$ambiguous=@();$matching=@()
foreach($process in $all) {
    $sameImage=$Executable -and $process.ExecutablePath -and $process.ExecutablePath.Equals($Executable,[StringComparison]::OrdinalIgnoreCase)
    if($sameImage){$matching += $process}
    if($process.Name -ine 'msedgewebview2.exe' -or $process.SessionId -ne $self.SessionId){continue}
    if(!$process.CommandLine){$ambiguous += $process.ProcessId;continue}
    $match=[regex]::Match($process.CommandLine,'--user-data-dir=(?:"([^"]+)"|([^\s]+))')
    if(!$match.Success){$ambiguous += $process.ProcessId;continue}
    $dataPath=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    if($dataPath.TrimEnd('\').Equals($udf.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){$matching += $process}
}
if($HostPid -gt 0) {
    $hostProcess=@($all|Where-Object{$_.ProcessId -eq $HostPid})
    if($hostProcess.Count -ne 1 -or !$hostProcess[0].ExecutablePath -or !$hostProcess[0].ExecutablePath.Equals($Executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate identity unavailable'}
    $owner=Invoke-CimMethod -InputObject $hostProcess[0] -MethodName GetOwnerSid -ErrorAction Stop
    if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $identity.User.Value -or $hostProcess[0].SessionId -ne $self.SessionId){throw 'Candidate user/session mismatch'}
    $pids=@($HostPid)
    do{$new=@($all|Where-Object{$_.ParentProcessId -in $pids -and $_.ProcessId -notin $pids}|Select-Object -ExpandProperty ProcessId);$pids+=$new}while($new.Count)
    $owned=@($all|Where-Object{$_.ProcessId -in $pids})
    if(@($owned|Where-Object{!$_.ExecutablePath -or !$_.CreationDate}).Count){throw 'Owned process identity unavailable'}
    if(!@($matching|Where-Object{$_.Name -ieq 'msedgewebview2.exe'}).Count){throw 'Persistent WebView writer not captured'}
}
$records=@($owned+$matching|Sort-Object ProcessId -Unique|ForEach-Object{
    @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;sessionId=[int]$_.SessionId;executablePath=$_.ExecutablePath;processStart=$_.CreationDate.ToUniversalTime().ToString('o');udfBound=($_.Name -ieq 'msedgewebview2.exe' -and $_ -in $matching)}
})
@{schemaVersion=1;sid=$identity.User.Value;sessionId=$self.SessionId;udf=$udf;processes=$records;ambiguousWebviewPids=$ambiguous;
  inventory=@($all|Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='processStart';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}});rootExists=[IO.Directory]::Exists($Root)}|ConvertTo-Json -Depth 6 -Compress
