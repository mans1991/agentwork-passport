// compile.mjs — compile AgentWorkPassport.sol + Mock (solc, optimizer 200)
// Output: artifact.json { abi, bytecode, deployedSize } untuk kontrak utama,
// dan artifact-mock.json untuk registry tiruan (uji lokal).
import solc from 'solc';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function findImport(path) {
  const candidates = [join(root, 'node_modules', path), join(root, path)];
  for (const c of candidates) if (existsSync(c)) return { contents: readFileSync(c, 'utf8') };
  return { error: 'File not found: ' + path };
}

const input = {
  language: 'Solidity',
  sources: {
    'AgentWorkPassport.sol': { content: readFileSync(join(root, 'contracts', 'AgentWorkPassport.sol'), 'utf8') },
    'MockAgentRegistry.sol': { content: readFileSync(join(root, 'contracts', 'MockAgentRegistry.sol'), 'utf8') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    ...(process.env.EVM_VERSION ? { evmVersion: process.env.EVM_VERSION } : {}),
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
const errors = (out.errors || []).filter(e => e.severity === 'error');
const warnings = (out.errors || []).filter(e => e.severity === 'warning');
if (errors.length) {
  console.error('COMPILE ERRORS:');
  errors.forEach(e => console.error(e.formattedMessage));
  process.exit(1);
}
for (const [file, name, outFile] of [
  ['AgentWorkPassport.sol', 'AgentWorkPassport', 'artifact.json'],
  ['MockAgentRegistry.sol', 'MockAgentRegistry', 'artifact-mock.json'],
]) {
  const c = out.contracts[file][name];
  const artifact = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedSize: c.evm.deployedBytecode.object.length / 2 };
  writeFileSync(join(root, outFile), JSON.stringify(artifact, null, 2));
  console.log(name, 'COMPILE OK — deployed bytes:', artifact.deployedSize);
}
console.log('warnings:', warnings.length);
warnings.slice(0, 5).forEach(w => console.log('-', w.message));
