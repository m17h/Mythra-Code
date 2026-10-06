import { describe, expect, test } from 'vitest';
import { inspectPe, inspectTar } from './release-native-integrity.mjs';

function pe() {
  const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88); bytes.writeUInt16LE(2, 156); return bytes;
}
function entry(name, type = '0', target = '') {
  const header = Buffer.alloc(512); header.write(name, 0, 100); header.write('00000000000', 124, 12);
  header.write(type, 156, 1); header.write(target, 157, 100); return header;
}
const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);
function pax(key, value) {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  while (`${length} ${body}`.length !== length) length = `${length} ${body}`.length;
  const bytes = Buffer.from(`${length} ${body}`), header = entry('PaxHeader/Mythra Code.app', 'x');
  header.write(bytes.length.toString(8).padStart(11, '0'), 124, 12);
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}
describe('final native artifact framing', () => {
  test('rejects wrong architecture and console subsystem', () => {
    expect(inspectPe(pe(), { machine: 0x8664, unsigned: true }).subsystem).toBe('WindowsGui');
    expect(() => inspectPe(pe(), { machine: 0xaa64 })).toThrow(/architecture/);
    const console = pe(); console.writeUInt16LE(3, 156);
    expect(() => inspectPe(console)).toThrow(/WindowsGui/);
  });
  test('rejects malformed PE offset and unexpected Authenticode policy', () => {
    const malformed = pe(); malformed.writeUInt32LE(0xffff, 0x3c);
    expect(() => inspectPe(malformed)).toThrow(/PE header/);
    const signed = pe(); signed.writeUInt32LE(400, 232);
    expect(() => inspectPe(signed, { unsigned: true })).toThrow(/NotSigned/);
  });
  test('allows contained framework symlinks', () => {
    expect(inspectTar(tar(entry('Mythra Code.app/', '5'), entry('Mythra Code.app/Framework/Versions/A/main'),
      entry('Mythra Code.app/Framework/Versions/Current', '2', 'A'))).entries).toBe(3);
  });
  test.each(['1', '3', '4', '6', 'g', 'L', 'K'])('rejects unsafe tar type %s before extraction', (type) => {
    expect(() => inspectTar(tar(entry('Mythra Code.app/link', type, '../../outside')))).toThrow(/entry type/);
  });
  test('accepts harmless BSD metadata but rejects extraction overrides', () => {
    expect(inspectTar(tar(pax('mtime', '1.5'), entry('Mythra Code.app/file'))).entries).toBe(1);
    for (const key of ['path', 'linkpath', 'size', 'SCHILY.filetype'])
      expect(() => inspectTar(tar(pax(key, '../../outside'), entry('Mythra Code.app/file')))).toThrow(/PAX override/);
  });
  test('rejects escaping symlinks and members below symlinks in either order', () => {
    expect(() => inspectTar(tar(entry('Mythra Code.app/link', '2', '../../outside')))).toThrow(/escapes/);
    const link = entry('Mythra Code.app/link', '2', 'Contents'), child = entry('Mythra Code.app/link/new');
    expect(() => inspectTar(tar(link, child))).toThrow(/traverses/);
    expect(() => inspectTar(tar(child, link))).toThrow(/traverses/);
  });
  test('rejects traversal, Apple metadata, duplicate members and truncated data', () => {
    for (const name of ['Mythra Code.app/../outside', 'Mythra Code.app/._file', '/Mythra Code.app/file'])
      expect(() => inspectTar(tar(entry(name)))).toThrow(/Unsafe/);
    expect(() => inspectTar(tar(entry('Mythra Code.app/file'), entry('Mythra Code.app/file')))).toThrow(/Duplicate/);
    const truncated = entry('Mythra Code.app/file'); truncated.write('00000004000', 124, 12);
    expect(() => inspectTar(truncated)).toThrow(/Truncated/);
  });
});
