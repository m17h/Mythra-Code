[CmdletBinding()]
param(
  [switch]$Probe,
  [string]$ProbeDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Assign the native process while suspended. A post-launch assignment leaves a
# window in which npm can spawn descendants outside the owned job. The job's
# handle is not inheritable; terminating this wrapper closes it and kills the
# entire build tree, including children whose intermediate parents have exited.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class MythraReleaseBuildJob {
    const uint CREATE_SUSPENDED = 0x00000004, CREATE_NO_WINDOW = 0x08000000;
    const uint STARTF_USESTDHANDLES = 0x00000100, KILL_ON_JOB_CLOSE = 0x00002000;
    const uint INFINITE = 0xffffffff, WAIT_OBJECT_0 = 0, DUPLICATE_SAME_ACCESS = 2;

    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT_INFORMATION {
        public BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT_INFORMATION info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);

    static Exception Failure(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static string Quote(string value) {
        // Windows argv quoting, with no cmd.exe/PowerShell expansion.
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); }
            else { result.Append('\\', slashes).Append(c); }
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static IntPtr InheritStandardHandle(int kind) {
        IntPtr handle = GetStdHandle(kind), copy;
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new InvalidOperationException("Build wrapper requires inherited standard handles");
        if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out copy, 0, true, DUPLICATE_SAME_ACCESS)) throw Failure("Cannot forward build output");
        return copy;
    }

    public static int Run(string executable, string[] arguments, string directory) {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool assigned = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Failure("Cannot create native build job");
            var limits = new EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT_INFORMATION)))) throw Failure("Cannot enforce build job cleanup");
            input = InheritStandardHandle(-10); output = InheritStandardHandle(-11); error = InheritStandardHandle(-12);
            var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = input; startup.hStdOutput = output; startup.hStdError = error;
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero, directory, ref startup, out process)) throw Failure("Cannot create suspended native builder");
            if (!AssignProcessToJobObject(job, process.hProcess)) throw Failure("Cannot contain native build tree");
            assigned = true;
            if (ResumeThread(process.hThread) == uint.MaxValue) throw Failure("Cannot start contained native builder");
            if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) throw Failure("Cannot wait for native builder");
            uint code; if (!GetExitCodeProcess(process.hProcess, out code)) throw Failure("Cannot inspect native build exit");
            return unchecked((int)code);
        } finally {
            // A process that could not be assigned has never executed. Stop it
            // explicitly; successful assignments are cleaned by closing job.
            if (!assigned && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 78);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            foreach (IntPtr handle in new[] { input, output, error }) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
'@

$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
if (-not [System.IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'Native Node executable is unavailable.'
}
$repoRoot = Split-Path -Parent $PSScriptRoot

if ($Probe) {
  # Explicitly bounded no-build probe. It creates only node sleep processes and
  # PID/output evidence in a fresh, caller-owned disposable directory.
  if (-not $ProbeDirectory -or -not [System.IO.Path]::IsPathRooted($ProbeDirectory)) { throw 'Probe requires an absolute disposable directory.' }
  $probeRoot = (Resolve-Path -LiteralPath $ProbeDirectory).Path
  if (@(Get-ChildItem -LiteralPath $probeRoot -Force).Count -ne 0) { throw 'Probe directory must be empty.' }
  $env:MYTHRA_BUILD_JOB_PROBE_DIRECTORY = $probeRoot
  $probeCode = @'
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.env.MYTHRA_BUILD_JOB_PROBE_DIRECTORY;
const code="const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.MYTHRA_BUILD_JOB_PROBE_DIRECTORY,'grandchild.json'),JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000);";
const child=cp.spawn(process.execPath,['-e',code],{stdio:'inherit'});
fs.writeFileSync(path.join(root,'builder.json'),JSON.stringify({pid:process.pid,parent:process.ppid,grandchild:child.pid}));
process.stdout.write('MYTHRA_JOB_STDOUT\n');process.stderr.write('MYTHRA_JOB_STDERR\n');setInterval(()=>{},1000);
'@
  exit [MythraReleaseBuildJob]::Run($node, @('-e', $probeCode), $probeRoot)
}
if ($ProbeDirectory) { throw 'ProbeDirectory is allowed only with -Probe.' }

$npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
  $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
  $npmCli = Join-Path (Split-Path -Parent $npm) 'node_modules\npm\bin\npm-cli.js'
}
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Cannot resolve the bundled npm CLI for the fixed release build command.' }
exit [MythraReleaseBuildJob]::Run($node, @($npmCli, 'run', 'release:build'), $repoRoot)
