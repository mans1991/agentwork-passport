// test-local.mjs — uji lifecycle AgentWorkPassport di EVM lokal (ganache).
// BUKAN mainnet/testnet. Skenario: gerbang Agent ID, register, job penuh,
// batal, kedaluwarsa, klaim setelah review, pause owner.
import Ganache from 'ganache';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';

const gp = Ganache.provider({ logging: { quiet: true } });
const provider = new ethers.BrowserProvider(gp);
const owner = await provider.getSigner(0);
const client = await provider.getSigner(1);   // Agent ID holder
const worker = await provider.getSigner(2);   // Agent ID holder
const outsider = await provider.getSigner(3); // BUKAN Agent ID holder

const art = JSON.parse(readFileSync(new URL('../artifact.json', import.meta.url), 'utf8'));
const mockArt = JSON.parse(readFileSync(new URL('../artifact-mock.json', import.meta.url), 'utf8'));

const mock = await new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, owner).deploy();
await mock.waitForDeployment();
await (await mock.giveAgentId(await client.getAddress())).wait();
await (await mock.giveAgentId(await worker.getAddress())).wait();

const c = await new ethers.ContractFactory(art.abi, art.bytecode, owner).deploy(await mock.getAddress());
await c.waitForDeployment();
console.log('deployed local:', await c.getAddress());

const balRaw = async (a) => BigInt(await gp.request({ method: 'eth_getBalance', params: [a, 'latest'] }));
const results = [];
const check = (name, cond) => { results.push([name, cond ? 'PASS' : 'FAIL']); if (!cond) process.exitCode = 1; };
const reverts = async (name, txPromise) => {
  try { await (await txPromise).wait(); check(name, false); }
  catch { check(name, true); }
};
const V = ethers.parseEther('0.001'); // nilai job uji

// Gerbang Agent ID
check('isAgent(client)=true', await c.isAgent(await client.getAddress()));
check('isAgent(outsider)=false', !(await c.isAgent(await outsider.getAddress())));
await reverts('register oleh non-Agent ditolak', c.connect(outsider).registerPassport());

// Register passport
await (await c.connect(client).registerPassport()).wait();
check('totalPassports=1 setelah register', (await c.totalPassports()) === 1n);
await reverts('register dua kali ditolak', c.connect(client).registerPassport());

// Job: client -> worker
await reverts('createJob ke non-Agent ditolak', c.connect(client).createJob(await outsider.getAddress(), 'ipfs://job', 3600, 86400, { value: V }));
await reverts('createJob di bawah minimum ditolak', c.connect(client).createJob(await worker.getAddress(), 'ipfs://job', 3600, 86400, { value: 1n }));
await (await c.connect(client).createJob(await worker.getAddress(), 'ipfs://job-1', 3600, 86400, { value: V })).wait();
check('jobCount=1', (await c.jobCount()) === 1n);
check('passport worker auto-terdaftar', (await c.passportOf(await worker.getAddress())).registered === true);
check('totalPassports=2 (client+worker)', (await c.totalPassports()) === 2n);

// Lifecycle penuh
await reverts('deliver sebelum accept ditolak', c.connect(worker).deliverJob(0, 'ipfs://done'));
await (await c.connect(worker).acceptJob(0)).wait();
await reverts('approve sebelum deliver ditolak', c.connect(client).approveRelease(0));
await (await c.connect(worker).deliverJob(0, 'ipfs://hasil-1')).wait();
await reverts('claimAfterReview terlalu dini ditolak', c.connect(worker).claimAfterReview(0));
const balWorkerBefore = await balRaw(await worker.getAddress());
await (await c.connect(client).approveRelease(0)).wait();
const balWorkerAfter = await balRaw(await worker.getAddress());
check('worker menerima tepat nilai job', balWorkerAfter - balWorkerBefore === V);
const pw = await c.passportOf(await worker.getAddress());
check('jobsCompleted worker=1', pw.jobsCompleted === 1n || pw.jobsCompleted === 1);
check('reputationLevel worker=1', (await c.reputationLevel(await worker.getAddress())) === 1n || (await c.reputationLevel(await worker.getAddress())) === 1);

// Job 2: batal saat Open -> refund penuh
await (await c.connect(client).createJob(await worker.getAddress(), 'ipfs://job-2', 3600, 86400, { value: V })).wait();
const balClientBefore = await balRaw(await client.getAddress());
await (await c.connect(client).cancelJob(1)).wait();
const balClientAfter = await balRaw(await client.getAddress());
check('refund batal = nilai job dikurangi gas cancel saja', balClientAfter - balClientBefore > V - ethers.parseEther('0.0002') && balClientAfter - balClientBefore <= V);

// Job 3: kedaluwarsa accept -> refundExpired oleh pihak ketiga
await (await c.connect(client).createJob(await worker.getAddress(), 'ipfs://job-3', 1, 86400, { value: V })).wait();
await gp.request({ method: 'evm_increaseTime', params: [10] });
await gp.request({ method: 'evm_mine', params: [] });
await (await c.connect(outsider).refundExpired(2)).wait();
check('job3 status Refunded', (await c.getJob(2)).status === 5n || (await c.getJob(2)).status === 5);

// Job 4: klaim setelah review (client diam)
await (await c.connect(client).createJob(await worker.getAddress(), 'ipfs://job-4', 3600, 86400, { value: V })).wait();
await (await c.connect(worker).acceptJob(3)).wait();
await (await c.connect(worker).deliverJob(3, 'ipfs://hasil-4')).wait();
await gp.request({ method: 'evm_increaseTime', params: [3 * 24 * 3600 + 60] });
await gp.request({ method: 'evm_mine', params: [] });
const bw2 = await balRaw(await worker.getAddress());
await (await c.connect(worker).claimAfterReview(3)).wait();
const bw3 = await balRaw(await worker.getAddress());
check('claimAfterReview membayar worker (dikurangi gas)', bw3 - bw2 > V - ethers.parseEther('0.0002'));
check('jobsCompleted worker=2', (await c.passportOf(await worker.getAddress())).jobsCompleted === 2n || (await c.passportOf(await worker.getAddress())).jobsCompleted === 2);

// Pause owner: blokir job baru, job lama tetap aman
await (await c.connect(owner).setPaused(true)).wait();
await reverts('createJob saat pause ditolak', c.connect(client).createJob(await worker.getAddress(), 'ipfs://x', 3600, 86400, { value: V }));
await (await c.connect(owner).setPaused(false)).wait();
await reverts('setPaused oleh non-owner ditolak', c.connect(client).setPaused(true));

// Owner tidak punya jalur menarik escrow: tidak ada fungsi withdraw di ABI
check('ABI tanpa fungsi withdraw', !art.abi.some(e => e.type === 'function' && /withdraw/i.test(e.name || '')));

console.log('\n=== HASIL UJI ===');
results.forEach(([n, r]) => console.log(r, '-', n));
console.log(results.filter(([, r]) => r === 'FAIL').length === 0 ? 'SEMUA LULUS' : 'ADA KEGAGALAN');
