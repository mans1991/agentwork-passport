// verify-sourcify.mjs — verifikasi AgentWorkPassport di Sourcify API v2 (chain 56).
// Membangun stdJsonInput lengkap (semua sumber termasuk OpenZeppelin sebagai
// entri sources), memastikan bytecode-nya identik dengan artifact ter-deploy,
// lalu POST /v2/verify/{chain}/{address} dan polling hasil verifikasi.
// Build asli: solc 0.8.26, optimizer 200, evmVersion shanghai.
import solc from 'solc';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const ADDRESS = '0x044F7c963C595Bf20C97731Ad1336d4C7547d0Ca';
const CHAIN = '56';
const CREATION_TX = '0xcfc04e11c05c0c8f1a07dd557e828f62d669490259658ae6016c27207bb352cb';
const UA = { 'User-Agent': 'agentwork-passport-verify/1.0 (contact: local script)' };

const src = p => readFileSync(join(root, p), 'utf8');
const stdJsonInput = {
  language: 'Solidity',
  sources: {
    'AgentWorkPassport.sol': { content: src('contracts/AgentWorkPassport.sol') },
    'MockAgentRegistry.sol': { content: src('contracts/MockAgentRegistry.sol') },
    '@openzeppelin/contracts/access/Ownable.sol': { content: src('node_modules/@openzeppelin/contracts/access/Ownable.sol') },
    '@openzeppelin/contracts/utils/Context.sol': { content: src('node_modules/@openzeppelin/contracts/utils/Context.sol') },
    '@openzeppelin/contracts/utils/ReentrancyGuard.sol': { content: src('node_modules/@openzeppelin/contracts/utils/ReentrancyGuard.sol') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(stdJsonInput)));
const errors = (out.errors || []).filter(e => e.severity === 'error');
if (errors.length) { errors.forEach(e => console.error(e.formattedMessage)); process.exit(1); }
const c = out.contracts['AgentWorkPassport.sol']['AgentWorkPassport'];
const artifact = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
const identical = '0x' + c.evm.bytecode.object === artifact.bytecode;
console.log('solc:', solc.version(), '| bytecode identik:', identical);
if (!identical) { console.error('STOP: bytecode beda'); process.exit(1); }

const res = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN}/${ADDRESS}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...UA },
  body: JSON.stringify({
    stdJsonInput,
    compilerVersion: 'v' + solc.version().split('.Emscripten')[0], // format Sourcify: v0.8.26+commit.8a97fa7a
    contractIdentifier: 'AgentWorkPassport.sol:AgentWorkPassport',
    creationTxHash: CREATION_TX,
  }),
});
console.log('POST verify HTTP', res.status);
const body = await res.json().catch(async () => ({ raw: await res.text() }));
console.log(JSON.stringify(body, null, 2));
const vid = body.verificationId;
if (vid) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const chk = await fetch(`https://sourcify.dev/server/v2/verify/${vid}`, { headers: UA });
    const st = await chk.json().catch(() => ({}));
    console.log('poll', i + 1, JSON.stringify(st).slice(0, 300));
    if (st.isJobCompleted || st.contract) break;
  }
}
const fin = await fetch(`https://sourcify.dev/server/v2/contract/${CHAIN}/${ADDRESS}?fields=abi,metadata`, { headers: UA });
console.log('GET contract HTTP', fin.status);
console.log((await fin.text()).slice(0, 400));
