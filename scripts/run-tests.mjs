// 轻量测试入口：用 esbuild 把 TS 测试打成临时 ESM 再执行，无需额外测试框架
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const tests = [
  { entry: 'scripts/engine-test.ts', stubSolid: false },
  { entry: 'scripts/db-test.ts', stubSolid: false },
  { entry: 'scripts/store-test.ts', stubSolid: true }
];

for (const { entry, stubSolid } of tests) {
  const outName = `.${entry.split('/').pop()?.replace('.ts', '.mjs')}`;
  const outfile = join(root, outName);
  await build({
    entryPoints: [join(root, '..', entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
    alias: stubSolid
      ? {
          'solid-js': join(root, 'stubs', 'solid.js'),
          'solid-js/store': join(root, 'stubs', 'solid-store.js')
        }
      : undefined
  });
  console.log(`\n# ${entry}`);
  try {
    execFileSync(process.execPath, [outfile], { stdio: 'inherit' });
  } finally {
    rmSync(outfile, { force: true });
  }
}
