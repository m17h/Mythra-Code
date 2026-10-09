import { createHash } from 'node:crypto';

export function safePath(path) {
  return typeof path === 'string' && Buffer.byteLength(path) > 0 && Buffer.byteLength(path) <= 512
    && path.split('/').length <= 8 && path.split('/').every((part) =>
      part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.')
      && !/[. ]$/.test(part) && !/[\p{Cc}\\:< >"|?*%#]/u.test(part)
      && !/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(part.split('.')[0]));
}

function validSnapshot(entry) {
  const fields = ['id', 'publisher', 'title', 'description', 'repository', 'path', 'revision', 'license', 'notes', 'files'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).some((key) => ![...fields, 'requirements'].includes(key))
    || fields.slice(0, -1).some((key) => typeof entry[key] !== 'string')
    || (entry.requirements !== undefined && (typeof entry.requirements !== 'string'
      || !entry.requirements.trim() || Buffer.byteLength(entry.requirements) > 2_000))
    || !/^[a-z0-9-]{1,80}$/.test(entry.id) || !/^[a-f0-9]{40}$/.test(entry.revision)
    || !['anthropic:anthropics/skills', 'openai:openai/skills', 'openai:openai/plugins'].includes(`${entry.publisher}:${entry.repository}`)
    || !safePath(entry.path.replace('/.curated/', '/curated/').replace('/.experimental/', '/experimental/'))
    || !entry.license || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 1_200) return false;
  const paths = new Set();
  let total = 0;
  for (const file of entry.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some((key) => !['path', 'sha256', 'size', 'executable'].includes(key))
      || !safePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1_048_576
      || (file.executable !== undefined && typeof file.executable !== 'boolean')
      || paths.has(file.path.toLowerCase())) return false;
    paths.add(file.path.toLowerCase());
    total += file.size;
    if (total > 48 * 1_048_576) return false;
  }
  if (!entry.files.some((file) => file.path === 'SKILL.md')) return false;
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) return false;
    }
  }
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function content(entry) {
  return {
    publisher: entry.publisher,
    repository: entry.repository,
    path: entry.path,
    license: entry.license,
    files: entry.files.map((file) => ({
      path: file.path, sha256: file.sha256, size: file.size, executable: file.executable === true,
    })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };
}

function snapshotHash(entry) {
  return hash({ ...entry, files: content(entry).files });
}

/** Preserve reviewed snapshots before replacing the active catalog.
 * Receipts never add trusted entries: all inputs are checked-in manifests.
 * Metadata may be corrected, but one ID/revision cannot identify different
 * repositories, package paths, licenses, file bytes, sizes, or executable modes.
 */
export function retainCatalogHistory(previous, history, next) {
  for (const [label, entries] of [['previous', previous], ['history', history], ['next', next]]) {
    if (!Array.isArray(entries)) throw new Error(`Catalog ${label} must be an array.`);
    const activeIds = new Set();
    for (const entry of entries) {
      if (!validSnapshot(entry)) {
        throw new Error(`Invalid catalog snapshot in ${label}.`);
      }
      if (label !== 'history' && activeIds.has(entry.id)) throw new Error(`Duplicate active catalog ID: ${entry.id}`);
      activeIds.add(entry.id);
    }
  }

  const pins = new Map();
  for (const entry of [...history, ...previous, ...next]) {
    const pin = `${entry.id}:${entry.revision}`;
    const digest = hash(content(entry));
    if (pins.has(pin) && pins.get(pin) !== digest) {
      throw new Error(`Immutable catalog content drift for ${pin}; use the actual upstream revision instead.`);
    }
    pins.set(pin, digest);
  }

  const retained = [];
  const knownSnapshots = new Set();
  const append = (entry) => {
    const digest = snapshotHash(entry);
    if (!knownSnapshots.has(digest)) {
      retained.push(entry);
      knownSnapshots.add(digest);
    }
  };
  // Keep all existing history, including entries restored to the active list.
  for (const entry of history) append(entry);
  const nextById = new Map(next.map((entry) => [entry.id, entry]));
  for (const entry of previous) {
    const replacement = nextById.get(entry.id);
    if (!replacement || entry.revision !== replacement.revision
      || snapshotHash(entry) !== snapshotHash(replacement)) append(entry);
  }
  return retained;
}
