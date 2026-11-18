// Bundles main, preload and renderer with esbuild into dist/.
//   node scripts/build.mjs          production-shaped bundle (API base from GTH_ENV, default preview)
//   node scripts/build.mjs --dev    same, with inline source maps
// GTH_ENV=production selects the production API base; anything else selects preview.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const env = process.env.GTH_ENV === 'production' ? 'production' : 'preview';
const API_BASES = {
  preview: 'https://xkjhy36p.mindbricks.dev/connector-api',
  production: 'https://xkjhy36p.mindbricks.app/connector-api',
};
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const out = path.join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'renderer'), { recursive: true });

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'warning',
  legalComments: 'none',
  define: {
    __GTH_ENV__: JSON.stringify(env),
    __GTH_API_BASE__: JSON.stringify(API_BASES[env]),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(out, 'main/index.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(out, 'preload/index.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/renderer/main.ts')],
    outfile: path.join(out, 'renderer/renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

cpSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
cpSync(path.join(root, 'src/renderer/styles.css'), path.join(out, 'renderer/styles.css'));
console.log(`built dist/ (${env}${dev ? ', dev' : ''}) -> ${API_BASES[env]}`);
