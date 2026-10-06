import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertPlan, containedPath, fileHash, readJson, receiptPath } from './release-state.mjs';

const CHECKER_VERSION = 'native-integrity-v1';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function inspectPe(bytes, { machine, unsigned = false } = {}) {
  ensure(bytes.length >= 256 && bytes.toString('ascii', 0, 2) === 'MZ', 'Invalid DOS executable header');
  const offset = bytes.readUInt32LE(0x3c);
  ensure(offset >= 64 && offset + 24 + 72 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', 'Invalid PE header');
  const foundMachine = bytes.readUInt16LE(offset + 4), optional = offset + 24;
  ensure(machine === undefined || foundMachine === machine, 'Executable architecture mismatch');
  const magic = bytes.readUInt16LE(optional);
  ensure(magic === 0x10b || magic === 0x20b, 'Unsupported PE optional header');
  ensure(bytes.readUInt16LE(optional + 68) === 2, 'Executable must use WindowsGui subsystem');
  const directories = optional + (magic === 0x10b ? 96 : 112), certificate = directories + 32;
  ensure(certificate + 8 <= bytes.length, 'Incomplete PE certificate directory');
  const certificateOffset = bytes.readUInt32LE(certificate), certificateBytes = bytes.readUInt32LE(certificate + 4);
  if (unsigned) ensure(certificateOffset === 0 && certificateBytes === 0, 'Current Windows release policy expects Authenticode NotSigned');
  return { machine: foundMachine, subsystem: 'WindowsGui', magic, certificateOffset, certificateBytes };
}

export function inspectTar(bytes) {
  let offset = 0, count = 0;
  const entries = [], symlinks = new Set();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const name = field(0, 100), prefix = field(345, 155), path = prefix ? `${prefix}/${name}` : name;
    const type = field(156, 1);
    const sizeText = field(124, 12).trim();
    ensure(/^[0-7]*$/.test(sizeText), 'Invalid tar size');
    const size = Number.parseInt(sizeText || '0', 8);
    ensure(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'Truncated tar entry');
    if (type === 'x') {
      // BSD tar emits per-entry timestamps and Apple's harmless provenance
      // attribute. Reject overrides of extraction paths, links, sizes or types.
      const data = bytes.subarray(offset + 512, offset + 512 + size);
      let cursor = 0;
      while (cursor < data.length) {
        const space = data.indexOf(32, cursor);
        ensure(space > cursor && /^\d+$/.test(data.subarray(cursor, space).toString('ascii')), 'Invalid PAX record length');
        const length = Number(data.subarray(cursor, space).toString('ascii'));
        ensure(Number.isSafeInteger(length) && length > space - cursor + 2 && cursor + length <= data.length && data[cursor + length - 1] === 10, 'Truncated PAX record');
        const record = data.subarray(space + 1, cursor + length - 1), equals = record.indexOf(61);
        ensure(equals > 0, 'Invalid PAX record');
        const key = record.subarray(0, equals).toString('ascii');
        ensure(['mtime', 'atime', 'ctime', 'LIBARCHIVE.xattr.com.apple.provenance', 'SCHILY.xattr.com.apple.provenance'].includes(key), `Unsupported PAX override: ${key}`);
        cursor += length;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    const parts = path.split('/');
    ensure((path === 'Mythra Code.app' || path.startsWith('Mythra Code.app/'))
      && !parts.some((part) => part === '..' || part === '__MACOSX' || part.startsWith('._')), `Unsafe archive entry: ${path}`);
    ensure(['', '0', '2', '5'].includes(type), 'Unsupported archive entry type');
    const normalized = path.replace(/\/+$/, '');
    ensure(!entries.includes(normalized), 'Duplicate archive entry');
    entries.push(normalized);
    if (type === '2') {
      const link = field(157, 100), target = posix.resolve('/', path.split('/').slice(0, -1).join('/'), link);
      ensure(link && !link.startsWith('/') && (target === '/Mythra Code.app' || target.startsWith('/Mythra Code.app/')), 'Archive symlink escapes application');
      symlinks.add(normalized);
    }
    offset += 512 + Math.ceil(size / 512) * 512; count++;
  }
  ensure(count > 0, 'Empty application archive');
  for (const entry of entries) {
    const parts = entry.split('/');
    for (let i = 1; i < parts.length; i++) ensure(!symlinks.has(parts.slice(0, i).join('/')), 'Archive entry traverses a symlink');
  }
  return { entries: count };
}

function bundleManifest(directory, prefix = '') {
  const result = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), key = prefix + name, stat = lstatSync(path);
    if (stat.isSymbolicLink()) result[key] = { link: readlinkSync(path) };
    else if (stat.isDirectory()) {
      result[key] = { directory: true, mode: stat.mode & 0o777 };
      Object.assign(result, bundleManifest(path, `${key}/`));
    } else if (stat.isFile()) result[key] = { sha256: fileHash(path), mode: stat.mode & 0o777 };
    else throw new Error(`Unsupported application entry: ${key}`);
  }
  return result;
}

export function runNativeIntegrity({ root, stateRoot, plan, check }) {
  assertPlan(plan);
  const platform = process.platform === 'darwin' ? 'darwin-aarch64' : process.platform === 'win32' ? 'windows-x86_64' : null;
  ensure(check.id === `audit:${platform}` && check.platform === platform, 'Native integrity audit must run on its matching OS');
  const startedAt = new Date().toISOString();
  const build = readJson(receiptPath(stateRoot, `build:${platform}`));
  const packagePath = containedPath(stateRoot, build.details.packagePath);
  ensure(fileHash(packagePath) === build.details.packageSha256, 'Package changed after native build');
  const stage = resolve(stateRoot, 'candidates', platform), logs = [];
  const evidenceDirectory = resolve(stateRoot, 'evidence'); mkdirSync(evidenceDirectory, { recursive: true });
  const work = mkdtempSync(join(evidenceDirectory, `native-${platform}-`));
  const run = (command, args) => {
    try {
      const output = execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
      logs.push({ command, args, output: output.trim() }); return output.trim();
    } catch (error) {
      logs.push({ command, args, exitCode: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` });
      throw new Error(`Native integrity command failed: ${command}`);
    }
  };
  let mounted = false;
  const mount = join(work, 'mount');
  let details;
  try {
    if (platform === 'darwin-aarch64') {
      const archive = join(stage, `MythraCode_${plan.version}_aarch64.app.tar.gz`);
      const rawArchive = inspectTar(gunzipSync(readFileSync(archive)));
      run('hdiutil', ['verify', packagePath]);
      run('codesign', ['--verify', '--verbose=4', packagePath]);
      run('xcrun', ['stapler', 'validate', packagePath]);
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', packagePath]);
      const extracted = join(work, 'archive'); mkdirSync(extracted); mkdirSync(mount);
      run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, packagePath]); mounted = true;
      run('tar', ['-xzf', archive, '-C', extracted]);
      ensure(JSON.stringify(readdirSync(extracted)) === JSON.stringify(['Mythra Code.app']), 'Unexpected archive root');
      const manifests = [];
      for (const app of [join(mount, 'Mythra Code.app'), join(extracted, 'Mythra Code.app')]) {
        run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
        run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
        run('xcrun', ['stapler', 'validate', app]);
        const plist = join(app, 'Contents/Info.plist');
        const value = (key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
        ensure(value('CFBundleShortVersionString') === plan.version && value('CFBundleVersion') === plan.version, 'Mac bundle version mismatch');
        ensure(value('CFBundleIdentifier') === 'com.kiwi.harness' && value('CFBundleExecutable') === 'mythra-code', 'Mac bundle identity mismatch');
        ensure(run('lipo', ['-archs', join(app, 'Contents/MacOS/mythra-code')]) === 'arm64', 'Mac application architecture mismatch');
        manifests.push(bundleManifest(app));
      }
      ensure(JSON.stringify(manifests[0]) === JSON.stringify(manifests[1]), 'DMG and updater bundles differ');
      details = { packageSha256: fileHash(packagePath), archiveSha256: fileHash(archive),
        executableSha256: fileHash(join(extracted, 'Mythra Code.app/Contents/MacOS/mythra-code')), rawArchive,
        bundleEntries: Object.keys(manifests[0]).length, codesign: 'passed', notarization: 'passed', gatekeeper: 'passed', bundleEquivalence: 'passed' };
      run('hdiutil', ['detach', mount]); mounted = false;
    } else {
      const installerPe = inspectPe(readFileSync(packagePath), { unsigned: true });
      const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
      const sevenZip = process.env.MYTHRA_RELEASE_7ZIP || run('powershell.exe', ['-NoProfile', '-Command', "$p=(Get-Command 7z.exe -ErrorAction SilentlyContinue).Source; if(-not $p){$p=Join-Path $env:ProgramFiles '7-Zip\\7z.exe'}; if(-not(Test-Path -LiteralPath $p)){throw '7-Zip is required for final NSIS payload verification'}; $p"]);
      const listing = run(sevenZip, ['l', '-slt', packagePath]).split('----------').slice(1).join('----------');
      for (const match of listing.matchAll(/^Path = (.+)$/gm)) {
        const path = match[1].trim();
        ensure(!/^(?:[A-Za-z]:|[\\/])/.test(path) && !path.split(/[\\/]/).includes('..'), 'Unsafe NSIS extraction entry');
      }
      const extracted = join(work, 'nsis'); mkdirSync(extracted);
      run(sevenZip, ['x', '-y', `-o${extracted}`, packagePath]);
      const payloads = [];
      const visit = (directory) => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name), stat = lstatSync(path);
          ensure(!stat.isSymbolicLink(), 'NSIS payload has unexpected symlink');
          if (stat.isDirectory()) visit(path);
          else if (name.toLowerCase() === 'mythra-code.exe') payloads.push(path);
        }
      }; visit(extracted);
      ensure(payloads.length === 1, 'NSIS must contain exactly one Mythra application executable');
      const executable = payloads[0], payloadPe = inspectPe(readFileSync(executable), { machine: 0x8664 });
      const version = (path) => JSON.parse(run('powershell.exe', ['-NoProfile', '-Command', `$v=(Get-Item -LiteralPath ${quote(path)}).VersionInfo; @{file=[string]$v.FileVersion;product=[string]$v.ProductVersion}|ConvertTo-Json -Compress`]));
      for (const path of [packagePath, executable]) {
        const value = version(path); ensure(value.file === plan.version && value.product === plan.version, 'Windows resource version mismatch');
      }
      details = { packageSha256: fileHash(packagePath), executableSha256: fileHash(executable), installerPe, payloadPe,
        payloadVersion: plan.version, authenticodeStatus: 'NotSigned', payloadName: basename(executable) };
    }
    ensure(fileHash(packagePath) === build.details.packageSha256, 'Package changed during native audit');
  } finally {
    if (mounted) { try { run('hdiutil', ['detach', mount]); mounted = false; } catch { /* Preserve mounted evidence for recovery. */ } }
    writeFileSync(join(evidenceDirectory, `native-integrity-${platform}.json`), `${JSON.stringify({ checkerVersion: CHECKER_VERSION, details, commands: logs }, null, 2)}\n`, { mode: 0o600 });
    if (!mounted) rmSync(work, { recursive: true, force: true });
  }
  const evidence = join(evidenceDirectory, `native-integrity-${platform}.json`);
  return { schemaVersion: 1, checkId: check.id, status: 'passed', planHash: plan.planHash, commit: plan.commit, platform,
    packageSha256: build.details.packageSha256, checkerVersion: CHECKER_VERSION, startedAt, completedAt: new Date().toISOString(),
    evidence: [{ path: relative(stateRoot, evidence).replaceAll('\\', '/'), sha256: fileHash(evidence) }], details };
}
