const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createRequire } = require('node:module');

const root = join(__dirname, '..');
const requireEvolution = createRequire(join(root, 'evolution-api', 'package.json'));
const { Linter } = requireEvolution('eslint');
const linter = new Linter();
linter.defineRule('jsx-defined', {
  create(context) {
    return {
      JSXOpeningElement(node) {
        let name = node.name;
        while (name.type === 'JSXMemberExpression') name = name.object;
        if (name.type !== 'JSXIdentifier' || (node.name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name))) return;
        let scope = context.getScope();
        while (scope) {
          if (scope.set.has(name.name)) return;
          scope = scope.upper;
        }
        context.report({ node: name, message: `JSX component '${name.name}' is not defined.` });
      },
    };
  },
});
let failures = 0;
let files = 0;

function check(directory, environment = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { check(path, environment); continue; }
    if (!/\.jsx?$/.test(entry.name)) continue;
    files++;
    const messages = linter.verify(readFileSync(path, 'utf8'), {
      env: { browser: true, es2022: true, ...environment },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      rules: {
        'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-args': 'error',
        'no-dupe-keys': 'error', 'no-dupe-else-if': 'error', 'valid-typeof': 'error', 'use-isnan': 'error',
        'jsx-defined': 'error',
      },
    }, path);
    for (const message of messages) {
      failures++;
      console.error(`${relative(root, path)}:${message.line}:${message.column} ${message.ruleId || 'parse'} ${message.message}`);
    }
  }
}

check(join(root, 'frontend', 'src'));
check(join(root, 'extension', 'src'), { webextensions: true, worker: true });
console.log(`Dashboard/extensión: ${files} archivos verificados, ${failures} errores estáticos.`);
process.exitCode = failures ? 1 : 0;
