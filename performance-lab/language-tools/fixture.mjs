import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mythra-language-bench-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'node' }, include: ['src/**/*.ts'] }))
  await writeFile(join(root, 'src/base.ts'), 'export const benchmarkValue = 41;\n')
  for (let index = 0; index < 12; index++) await writeFile(join(root, `src/chain${index}.ts`), `export { benchmarkValue } from './${index === 0 ? 'base' : `chain${index - 1}`}';\n`)
  const source = "import { benchmarkValue } from './chain11';\nexport const answer = benchmarkValue + 1;\n" + Array.from({ length: 150 }, (_, i) => `export function symbol${String(i).padStart(3, '0')}(value: number) { return value + ${i}; }`).join('\n') + '\n'
  const file = join(root, 'src/main.ts')
  await writeFile(file, source)
  return { root, file, uri: pathToFileURL(file).href, rootUri: `${pathToFileURL(root).href}/`, source, sourceSha256: createHash('sha256').update(await readFile(file)).digest('hex'), position: { line: 1, character: 23 } }
}
