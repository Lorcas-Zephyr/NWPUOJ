import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, '../static-libs/noj-code-editor');
fs.mkdirSync(output, { recursive: true });
const result = await build({ entryPoints: [path.join(root, 'src/editor.js')], bundle: true, minify: true, format: 'iife', target: ['es2020'], outfile: path.join(output, 'editor.min.js'), legalComments: 'eof', metafile: true });
fs.copyFileSync(path.join(root, 'src/bootstrap.js'), path.join(output, 'loader.js'));
const packages = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
  const match = file.match(/node_modules\/(?:@[^/]+\/)?[^/]+/);
  if (match) packages.add(match[0]);
}
const notices = [];
for (const packagePath of [...packages].sort()) {
  const location = path.resolve(root, packagePath), manifest = JSON.parse(fs.readFileSync(path.join(location, 'package.json')));
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(name => fs.existsSync(path.join(location, name)));
  if (!license) throw new Error('Missing license: ' + manifest.name);
  notices.push(manifest.name + '@' + manifest.version + '\n' + fs.readFileSync(path.join(location, license), 'utf8'));
}
fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n--------------------\n\n'));
console.log('Built editor and loader with ' + packages.size + ' dependency licenses.');
