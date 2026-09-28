const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const root = dirname(require.resolve('minio/package.json'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (version !== '8.0.7') throw new Error('Review the MinIO parser adapter before changing its version.');

for (const [file, replacements] of [
  ['dist/main/notification.js', [
    ['stream-json/jsonl/Parser.js', 'stream-json/jsonl/parser.js'],
    ['_Parser.make()', '_Parser.default.asStream()'],
  ]],
  ['dist/esm/notification.mjs', [
    ['stream-json/jsonl/Parser.js', 'stream-json/jsonl/parser.js'],
    ['jsonLineParser.make()', 'jsonLineParser.asStream()'],
  ]],
]) {
  const target = join(root, file);
  let source = readFileSync(target, 'utf8');
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error(`Unexpected MinIO source: ${file}`);
    source = source.replace(before, after);
  }
  writeFileSync(target, source);
}
