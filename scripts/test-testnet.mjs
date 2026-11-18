// test-testnet.mjs — uji lifecycle AgentWorkPassport di BSC testnet (chain 97).
// Aktor: deploy1 = owner + client; dua wallet uji lokal (deterministik dari
// label, BUKAN wallet user) sebagai provider & outsider. Provider diberi
// Agent ID tiruan lewat MockAgentRegistry; outsider tidak.
// Broadcast hanya bila env CONFIRM=TEST-TESTNET. Butuh tBNB di deploy1
// (gas semua aktor ditanggung deploy1 kecuali provider/outsider yang
// menerima transfer tBNB kecil dari deploy1 di awal).
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

if (process.env.CONFIRM !== 'TEST-TESTNET') { console.error('STOP: butuh env CONFIRM=TEST-TESTNET'); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const RPC = 'https://bsc-testnet-rpc.publicnode.com';
const dep = JSON.parse(readFileSync(join(root, 'deployment-testnet.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
const mockArt = JSON.parse(readFileSync(join(root, 'artifact-mock.json'), 'utf8'));

const provider = new ethers.JsonRpcProvider(RPC);
if ((await provider.getNetwork()).chainId !== 97n) { console.error('STOP: bukan testnet'); process.exit(1); }

const cfg = JSON.parse(readFileSync(process.env.HOME + '/.config/deploy1-wallet/wallet.json', 'utf8'));
const client = new ethers.Wallet(cfg.privateKey, provider);
const worker = ethers.Wallet.fromPhrase(ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes('agentwork-test-worker'))).phrase).connect(provider);
const outsider = ethers.Wallet.fromPhrase(ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes('agentwork-test-outsider'))).phrase).connect(provider);

const mock = new ethers.Contract(dep.mockRegistry, mockArt.abi, client);
const c = new ethers.Contract(dep.address, art.abi, client);
const cw = c.connect(worker);
const co = c.connect(outsider);

const results = [];
const check = (name, cond) => { results.push([name, cond ? 'PASS' : 'FAIL']); if (!cond) process.exitCode = 1; };
const reverts = async (name, txPromise) => { try { await (await txPromise).wait(); check(name, false); } catch { check(name, true); } };
const V = ethers.parseEther('0.001');
const FUND = ethers.parseEther('0.01');

console.log('client/deploy1:', client.address);
console.log('worker:', worker.address);
console.log('outsider:', outsider.address);

// Beri Agent ID tiruan ke client & worker (owner mock = deploy1)
await (await mock.giveAgentId(client.address)).wait();
await (await mock.giveAgentId(worker.address)).wait();
// Danai worker & outsider untuk gas mereka sendiri
if ((await provider.getBalance(worker.address)) < FUND / 2n) await (await client.sendTransaction({ to: worker.address, value: FUND })).wait();
if ((await provider.getBalance(outsider.address)) < FUND / 2n) await (await client.sendTransaction({ to: outsider.address, value: FUND })).wait();

check('isAgent(client)=true', await c.isAgent(client.address));
check('isAgent(outsider)=false', !(await c.isAgent(outsider.address)));
await reverts('register non-Agent ditolak', co.registerPassport());
await (await c.registerPassport()).wait();
check('passport client terdaftar', (await c.passportOf(client.address)).registered === true);

await (await c.createJob(worker.address, 'ipfs://agentwork-test-job-1', 3600, 86400, { value: V })).wait();
check('jobCount>=1', (await c.jobCount()) >= 1n);
const id = (await c.jobCount()) - 1n;
await (await cw.acceptJob(id)).wait();
await (await cw.deliverJob(id, 'ipfs://agentwork-test-hasil-1')).wait();
const bw0 = await provider.getBalance(worker.address);
await (await c.approveRelease(id)).wait();
const bw1 = await provider.getBalance(worker.address);
check('worker menerima tepat nilai job', bw1 - bw0 === V);
check('jobsCompleted worker=1', (await c.passportOf(worker.address)).jobsCompleted === 1n);
check('reputationLevel worker=1', (await c.reputationLevel(worker.address)) === 1n);
console.log('job id teruji:', id.toString(), '| kontrak:', dep.address);

console.log('\n=== HASIL UJI TESTNET ===');
results.forEach(([n, r]) => console.log(r, '-', n));
console.log(results.some(([, r]) => r === 'FAIL') ? 'ADA KEGAGALAN' : 'SEMUA LULUS');
