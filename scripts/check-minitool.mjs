#!/usr/bin/env node
// Guard run before zipping: refuses to package anything the Xiaohongshu
// mini-tool container would reject, or a page with broken references.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const ALLOWED = /\.(html|css|js|png|jpe?g|gif|webp|svg|woff2?|json)$/i;
const problems = [];

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(root, full).split(path.sep).join('/'));
  }
})(root);

for (const f of files) {
  if (!ALLOWED.test(f)) problems.push(`not an allowed file type: ${f}`);
  if (/(^|\/)\.|\.map$/.test(f)) problems.push(`should not be packaged: ${f}`);
}

const html = files.filter((f) => f.endsWith('.html'));
if (html.length !== 1 || html[0] !== 'index.html') problems.push(`need exactly one index.html at the root, found: ${html.join(', ') || 'none'}`);

const index = fs.existsSync(path.join(root, 'index.html')) ? fs.readFileSync(path.join(root, 'index.html'), 'utf8') : '';
const refs = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (/^(https?:)?\/\//.test(ref)) problems.push(`external reference: ${ref}`);
  else if (!files.includes(ref.replace(/^\.\//, ''))) problems.push(`index.html references a missing file: ${ref}`);
}
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(index)) problems.push('inline <script> in index.html');
if (/type="module"/.test(index)) problems.push('module script in index.html');

for (const css of files.filter((f) => f.endsWith('.css'))) {
  const text = fs.readFileSync(path.join(root, css), 'utf8');
  for (const m of text.matchAll(/url\(([^)]+)\)/g)) {
    const ref = m[1].replace(/["']/g, '');
    if (/^(https?:)?\/\//.test(ref)) problems.push(`external url() in ${css}: ${ref}`);
    else if (!ref.startsWith('data:') && !files.includes(path.posix.join(path.posix.dirname(css), ref).replace(/^\.\//, ''))) {
      problems.push(`${css} references a missing file: ${ref}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`Mini-tool check FAILED (${problems.length} problem(s)); zip not created.`);
  process.exit(1);
}
console.log(`✓ Mini-tool check passed: ${files.length} files, ${refs.length} references in index.html all present.`);
