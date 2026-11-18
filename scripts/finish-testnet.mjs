// finish-testnet.mjs — selesaikan uji testnet yang berhenti di approveRelease
// karena saldo client kurang untuk gas limit di muka (job 0 sudah Delivered).
// Worker meminjamkan 0,00001 tBNB ke client, lalu approveRelease dijalankan
// dan semua asersi akhir diverifikasi. CONFIRM=FINISH-TESTNET wajib.
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

if (process.env.CONFIRM !== 'FINISH-TESTNET') { console.error('STOP: butuh env CONFIRM=FINISH-TESTNET'); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dep = JSON.parse(readFileSync(join(root, 'deployment-testnet.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
if ((await provider.getNetwork()).chainId !== 97n) { console.error('STOP: bukan testnet'); process.exit(1); }

const cfg = JSON.parse(readFileSync(process.env.HOME + '/.config/deploy1-wallet/wallet.json', 'utf8'));
const client = new ethers.Wallet(cfg.privateKey, provider);
const worker = ethers.Wallet.fromPhrase(ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes('agentwork-test-worker'))).phrase).connect(provider);
const outsider = ethers.Wallet.fromPhrase(ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes('agentwork-test-outsider'))).phrase).connect(provider);
const c = new ethers.Contract(dep.address, art.abi, client);

const results = [];
const check = (name, cond) => { results.push([name, cond ? 'PASS' : 'FAIL']); if (!cond) process.exitCode = 1; };
const V = ethers.parseEther('0.0001');

check('isAgent(client)=true', await c.isAgent(client.address));
check('isAgent(outsider)=false', !(await c.isAgent(outsider.address)));
check('passport client terdaftar', (await c.passportOf(client.address)).registered === true);
const j0 = await c.getJob(0n);
check('job 0 status Delivered (2)', j0.status === 2n || j0.status === 2);

await (await worker.sendTransaction({ to: client.address, value: ethers.parseEther('0.00001') })).wait();
console.log('worker → client 0.00001 tBNB; saldo client:', ethers.formatEther(await provider.getBalance(client.address)));

const bw0 = await provider.getBalance(worker.address);
await (await c.approveRelease(0n)).wait();
const bw1 = await provider.getBalance(worker.address);
check('worker menerima tepat nilai job (0.0001)', bw1 - bw0 === V);
check('jobsCompleted worker=1', (await c.passportOf(worker.address)).jobsCompleted === 1n);
check('reputationLevel worker=1', (await c.reputationLevel(worker.address)) === 1n);
const j0b = await c.getJob(0n);
check('job 0 status Completed (3)', j0b.status === 3n || j0b.status === 3);
check('totalPassports=2', (await c.totalPassports()) === 2n);

console.log('\n=== HASIL AKHIR UJI TESTNET (gabungan dua run) ===');
results.forEach(([n, r]) => console.log(r, '-', n));
console.log(results.some(([, r]) => r === 'FAIL') ? 'ADA KEGAGALAN' : 'SEMUA LULUS');
