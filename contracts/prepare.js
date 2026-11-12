// Compile POMBadge.sol, encode constructor args, compute the CREATE2 deploy via the
// deterministic deployment proxy, and emit build.json (abi, initcode, salt, address, calldata).
const fs = require('fs'), path = require('path'), solc = require('solc');
const { ethers } = require('ethers');

const OWNER = '0x58fbda919c022bd2948f0bacec9891874cb8e4a5';
const BASE_URI = 'https://mass.arwyn.party/api/nft/';
const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const SALT = ethers.id('proofofmass-badge-v1'); // deterministic 32-byte salt

function findImports(p) {
  try { return { contents: fs.readFileSync(path.join(__dirname, 'node_modules', p), 'utf8') }; }
  catch (e) { return { error: 'not found: ' + p }; }
}

const input = {
  language: 'Solidity',
  sources: { 'POMBadge.sol': { content: fs.readFileSync(path.join(__dirname, 'POMBadge.sol'), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let fatal = false;
for (const e of (out.errors || [])) { if (e.severity === 'error') { fatal = true; console.error(e.formattedMessage); } }
if (fatal) process.exit(1);

const C = out.contracts['POMBadge.sol']['ProofOfMassBadge'];
const bytecode = '0x' + C.evm.bytecode.object;
const args = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'string'], [OWNER, BASE_URI]);
const initcode = bytecode + args.slice(2);
const initHash = ethers.keccak256(initcode);
const create2 = ethers.getCreate2Address(FACTORY, SALT, initHash);
const calldata = SALT + initcode.slice(2); // proxy: 32-byte salt ++ initcode

fs.writeFileSync(path.join(__dirname, 'build.json'), JSON.stringify({
  abi: C.abi, bytecode, initcode, salt: SALT, create2, calldata, factory: FACTORY, owner: OWNER, baseURI: BASE_URI
}, null, 2));
console.log('predicted contract address:', create2);
console.log('initcode bytes:', (initcode.length - 2) / 2, '| calldata bytes:', (calldata.length - 2) / 2);
