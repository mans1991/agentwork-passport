// sweep-to-mansta.mjs — kirim SEMUA BNB (BSC mainnet) dari hunt 1 & deploy 1
// ke wallet mansta (perintah user 19 Nov 2026, obrolan hackaton binance:
// hackathon memakai wallet mansta).
// DEFAULT: dry-run. Broadcast hanya dengan env CONFIRM=SWEEP-TO-MANSTA.
// Jumlah sweep = saldo - 21000*gasPrice*1,1 (cadangan gas transfer itu sendiri).
import { ethers } from 'ethers';
import { readFileSync } from 'fs';

const MANSTA = '0x704807FCfC21B6b607aa408f9313d414a82baE91';
const RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'];
const broadcast = process.env.CONFIRM === 'SWEEP-TO-MANSTA';

const wallets = [
  { name: 'hunt 1', address: '0xB063201eCA1F0b67EeBCe163D3f6f076D98Bd8bA', keyFile: process.env.HOME + '/.config/hunt-wallet/wallet.json' },
  { name: 'deploy 1', address: '0x1e8d54f9178c7B9386D0C483523Ab7524c6d522d', keyFile: process.env.HOME + '/.config/deploy1-wallet/wallet.json' },
];

const providers = RPCS.map(u => new ethers.JsonRpcProvider(u));
for (const p of providers) {
  const net = await p.getNetwork();
  if (net.chainId !== 56n) { console.error('STOP: bukan BSC mainnet'); process.exit(1); }
}

const manstaBefore = await providers[0].getBalance(MANSTA);
const manstaBefore2 = await providers[1].getBalance(MANSTA);
console.log('mansta sebelum:', ethers.formatEther(manstaBefore), 'BNB | RPC2:', ethers.formatEther(manstaBefore2));
if (manstaBefore !== manstaBefore2) { console.error('STOP: saldo mansta beda antar RPC'); process.exit(1); }

const feeData = await providers[0].getFeeData();
const gasPrice = feeData.gasPrice;
console.log('gasPrice:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei');
const reserve = 21000n * gasPrice * 11n / 10n;

const results = [];
for (const w of wallets) {
  const b1 = await providers[0].getBalance(w.address);
  const b2 = await providers[1].getBalance(w.address);
  if (b1 !== b2) { console.error(`STOP: saldo ${w.name} beda antar RPC: ${b1} vs ${b2}`); process.exit(1); }
  const amount = b1 - reserve;
  console.log(`${w.name} (${w.address}): saldo ${ethers.formatEther(b1)} BNB → sweep ${amount > 0n ? ethers.formatEther(amount) : '0 (di bawah cadangan gas)'} BNB`);
  if (amount <= 0n) { results.push([w.name, 'SKIP — saldo 0 / tidak cukup untuk gas transfer', null]); continue; }

  const cfg = JSON.parse(readFileSync(w.keyFile, 'utf8'));
  const signer = new ethers.Wallet(cfg.privateKey, providers[0]);
  if (signer.address.toLowerCase() !== w.address.toLowerCase()) { console.error(`STOP: signer bukan ${w.name}`); process.exit(1); }

  // Rehearsal: estimasi gas transfer persis seperti yang akan dikirim
  const est = await providers[0].estimateGas({ from: w.address, to: MANSTA, value: amount });
  console.log(`  rehearsal estimateGas: ${est} (batas wajar 21000–30000)`);
  if (est > 30000n) { console.error('STOP: estimasi gas tidak wajar'); process.exit(1); }

  if (!broadcast) { results.push([w.name, `DRY-RUN — siap kirim ${ethers.formatEther(amount)} BNB`, null]); continue; }

  const tx = await signer.sendTransaction({ to: MANSTA, value: amount, gasPrice, gasLimit: 21000 });
  console.log(`  broadcast: ${tx.hash}`);
  const rc = await tx.wait();
  if (rc.status !== 1) { console.error(`STOP: tx ${w.name} gagal on-chain`); process.exit(1); }
  results.push([w.name, `TERKIRIM ${ethers.formatEther(amount)} BNB`, tx.hash]);
}

if (broadcast) {
  const manstaAfter = await providers[0].getBalance(MANSTA);
  const manstaAfter2 = await providers[1].getBalance(MANSTA);
  console.log('mansta sesudah:', ethers.formatEther(manstaAfter), 'BNB | RPC2:', ethers.formatEther(manstaAfter2));
  console.log('kenaikan mansta:', ethers.formatEther(manstaAfter - manstaBefore), 'BNB');
}
console.log('\n=== RINGKASAN ===');
results.forEach(([n, r, h]) => console.log(n, '—', r, h ? '| tx: ' + h : ''));
