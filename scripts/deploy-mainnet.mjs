// deploy-mainnet.mjs — deploy AgentWorkPassport ke BSC mainnet (chain 56).
// Deployer: hunt 1 (deploy 1 tidak ada di address book mansta, jadi gas deploy
// dikirim ke hunt 1 — pola yang sama dengan OSE/SYND/AAG).
// Registry: kontrak Agent ID resmi (SPACE ID Agent ID) — diverifikasi dalam
// skrip ini sendiri (kode ada + balanceOf(mansta)=1) sebelum deploy.
// Setelah deploy: ownership langsung dipindah ke mansta (wallet proyek).
// DEFAULT: dry-run. Broadcast hanya bila env CONFIRM=DEPLOY-MAINNET.
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DEPLOYER = '0xB063201eCA1F0b67EeBCe163D3f6f076D98Bd8bA'; // hunt 1
const MANSTA = '0x704807FCfC21B6b607aa408f9313d414a82baE91';
const REGISTRY = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'; // SPACE ID Agent ID
const RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'];
const broadcast = process.env.CONFIRM === 'DEPLOY-MAINNET';

const art = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
const provider = new ethers.JsonRpcProvider(RPCS[0]);
const provider2 = new ethers.JsonRpcProvider(RPCS[1]);
if ((await provider.getNetwork()).chainId !== 56n) { console.error('STOP: bukan BSC mainnet'); process.exit(1); }

// Verifikasi registry dari sumber on-chain langsung (bukan dari ingatan):
const regCode = await provider.getCode(REGISTRY);
if (regCode === '0x') { console.error('STOP: registry tidak ada kode'); process.exit(1); }
const regAbi = ['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)'];
const reg = new ethers.Contract(REGISTRY, regAbi, provider);
const regName = await reg.name();
const manstaIds = await reg.balanceOf(MANSTA);
console.log('registry:', REGISTRY, '| name():', regName, '| balanceOf(mansta):', manstaIds.toString());
if (manstaIds < 1n) { console.error('STOP: mansta tidak memegang Agent ID di registry ini'); process.exit(1); }

const cfg = JSON.parse(readFileSync(process.env.HOME + '/.config/hunt-wallet/wallet.json', 'utf8'));
const signer = new ethers.Wallet(cfg.privateKey, provider);
if (signer.address.toLowerCase() !== DEPLOYER.toLowerCase()) { console.error('STOP: signer bukan hunt 1'); process.exit(1); }

const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
const deployTxReq = await factory.getDeployTransaction(REGISTRY);
const est = await provider.estimateGas({ ...deployTxReq, from: DEPLOYER });
const feeData = await provider.getFeeData();
const gasPrice = feeData.gasPrice;
// + transferOwnership ±60rb gas
const totalEst = (est + 60000n) * gasPrice;
const bal = await provider.getBalance(DEPLOYER);
console.log(JSON.stringify({
  mode: broadcast ? 'BROADCAST' : 'DRY-RUN',
  deployer: DEPLOYER,
  registry: REGISTRY,
  estGasDeploy: est.toString(),
  gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
  estCostTotalBNB: ethers.formatEther(totalEst),
  balanceBNB: ethers.formatEther(bal),
  enough: bal >= totalEst,
}, null, 2));
if (!broadcast) { console.log('DRY-RUN selesai — tidak ada broadcast.'); process.exit(0); }
if (bal < totalEst) { console.error('STOP: saldo tidak cukup'); process.exit(1); }

const contract = await factory.deploy(REGISTRY);
await contract.waitForDeployment();
const addr = await contract.getAddress();
const deployTxHash = contract.deploymentTransaction().hash;
console.log('AgentWorkPassport:', addr, '| deploy tx:', deployTxHash);

const code = await provider.getCode(addr);
const code2 = await provider2.getCode(addr);
console.log('kode on-chain bytes:', (code.length - 2) / 2, '| RPC2 sama:', code === code2);
if ((code.length - 2) / 2 !== 9266) { console.error('STOP: ukuran kode tidak cocok 9266'); process.exit(1); }
console.log('agentRegistry():', await contract.agentRegistry());
console.log('owner awal:', await contract.owner());

const txOwn = await contract.transferOwnership(MANSTA);
await txOwn.wait();
console.log('transferOwnership tx:', txOwn.hash);
const ownerNow = await contract.owner();
console.log('owner sekarang:', ownerNow);
if (ownerNow.toLowerCase() !== MANSTA.toLowerCase()) { console.error('STOP: owner bukan mansta'); process.exit(1); }
console.log('isAgent(mansta):', await contract.isAgent(MANSTA));
console.log('totalPassports:', (await contract.totalPassports()).toString(), '| jobCount:', (await contract.jobCount()).toString());

writeFileSync(join(root, 'deployment.json'), JSON.stringify({
  chainId: 56,
  deployer: DEPLOYER,
  owner: MANSTA,
  registry: REGISTRY,
  address: addr,
  deployTx: deployTxHash,
  transferOwnershipTx: txOwn.hash,
  at: new Date().toISOString(),
}, null, 2));
console.log('deployment.json tersimpan.');
