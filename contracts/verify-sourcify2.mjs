import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const solc = require('solc');

const ADDRESS = '0xD0B27C241C8bd5C1BbAD2DC7223E24d847805AD0';
const CHAIN = '8453';
const ver = solc.version(); // e.g. 0.8.28+commit.7893614a.Emscripten.clang
const compilerVersion = (ver.match(/\d+\.\d+\.\d+\+commit\.[0-9a-f]+/) || [ver])[0];

function readImports(p) { try { return fs.readFileSync(path.join(__dirname, 'node_modules', p), 'utf8'); } catch (e) { return null; } }
function findImports(p) { const c = readImports(p); return c ? { contents: c } : { error: 'not found: ' + p }; }

// first compile to discover the full source set (via metadata)
const base = { language: 'Solidity', sources: { 'POMBadge.sol': { content: fs.readFileSync(path.join(__dirname, 'POMBadge.sol'), 'utf8') } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['metadata'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(base), { import: findImports }));
const meta = JSON.parse(out.contracts['POMBadge.sol']['ProofOfMassBadge'].metadata);

// build a fully-inlined standard JSON input (all sources with content)
const sources = {};
for (const sp of Object.keys(meta.sources)) {
  sources[sp] = { content: sp === 'POMBadge.sol' ? base.sources['POMBadge.sol'].content : readImports(sp) };
}
const stdJsonInput = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };

const body = JSON.stringify({ stdJsonInput, compilerVersion, contractIdentifier: 'POMBadge.sol:ProofOfMassBadge' });
console.log('compiler:', compilerVersion, '| sources:', Object.keys(sources).length);
const url = `https://sourcify.dev/server/v2/verify/${CHAIN}/${ADDRESS}`;
const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
console.log('POST', url, '->', r.status);
const txt = await r.text();
console.log(txt.slice(0, 800));
