// deploy-testnet.mjs — deploy AgentWorkPassport + MockAgentRegistry ke BSC testnet (chain 97).
// Deployer: wallet "deploy 1" (~/.config/deploy1-wallet/wallet.json).
// DEFAULT: dry-run (estimasi gas + cek saldo), TIDAK broadcast.
// Broadcast hanya bila: node deploy-testnet.mjs --broadcast DAN env CONFIRM=DEPLOY-TESTNET.
// Di testnet registry Agent ID asli tidak ada, jadi MockAgentRegistry dipakai
// sebagai registry — perilaku gerbang identik (balanceOf > 0).
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DEPLOYER = '0x1e8d54f9178c7B9386D0C483523Ab7524c6d522d';
const RPC = 'https://bsc-testnet-rpc.publicnode.com';

const broadcast = process.argv.includes('--broadcast');
if (broadcast && process.env.CONFIRM !== 'DEPLOY-TESTNET') {
  console.error('STOP: broadcast butuh env CONFIRM=DEPLOY-TESTNET');
  process.exit(1);
}

const art = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
const mockArt = JSON.parse(readFileSync(join(root, 'artifact-mock.json'), 'utf8'));

const provider = new ethers.JsonRpcProvider(RPC);
const net = await provider.getNetwork();
if (net.chainId !== 97n) { console.error('STOP: bukan BSC testnet, chainId=' + net.chainId); process.exit(1); }

const cfg = JSON.parse(readFileSync(process.env.HOME + '/.config/deploy1-wallet/wallet.json', 'utf8'));
const signer = new ethers.Wallet(cfg.privateKey, provider);
if (signer.address.toLowerCase() !== DEPLOYER.toLowerCase()) { console.error('STOP: signer bukan deploy 1'); process.exit(1); }

const mockFactory = new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, signer);
const mainFactory = new ethers.ContractFactory(art.abi, art.bytecode, signer);

// Estimasi: deploy mock (tanpa argumen) lalu main (argumen = alamat mock hasil prediksi nonce)
const nonce = await provider.getTransactionCount(DEPLOYER);
const mockAddr = ethers.getCreateAddress({ from: DEPLOYER, nonce });
const estMock = await provider.estimateGas({ ...(await mockFactory.getDeployTransaction()), from: DEPLOYER });
const estMain = await provider.estimateGas({ ...(await mainFactory.getDeployTransaction(mockAddr)), from: DEPLOYER });
const feeData = await provider.getFeeData();
const gasPrice = feeData.gasPrice;
const totalEst = (estMock + estMain) * gasPrice;
const bal = await provider.getBalance(DEPLOYER);

console.log(JSON.stringify({
  mode: broadcast ? 'BROADCAST' : 'DRY-RUN',
  chainId: 97,
  deployer: DEPLOYER,
  mockRegistryPredicted: mockAddr,
  estGasMock: estMock.toString(),
  estGasMain: estMain.toString(),
  gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
  estCostTBNB: ethers.formatEther(totalEst),
  balanceTBNB: ethers.formatEther(bal),
  enough: bal >= totalEst,
}, null, 2));

if (!broadcast) { console.log('DRY-RUN selesai — tidak ada broadcast.'); process.exit(0); }
if (bal < totalEst) { console.error('STOP: saldo tBNB tidak cukup'); process.exit(1); }

const mock = await mockFactory.deploy();
await mock.waitForDeployment();
const mockDeployed = await mock.getAddress();
if (mockDeployed.toLowerCase() !== mockAddr.toLowerCase()) {
  console.error('STOP: alamat mock tidak cocok prediksi: ' + mockDeployed);
  process.exit(1);
}
console.log('MockAgentRegistry:', mockDeployed, 'tx:', mock.deploymentTransaction().hash);

const main = await mainFactory.deploy(mockDeployed);
await main.waitForDeployment();
const mainAddr = await main.getAddress();
console.log('AgentWorkPassport:', mainAddr, 'tx:', main.deploymentTransaction().hash);

const code = await provider.getCode(mainAddr);
console.log('kode on-chain bytes:', (code.length - 2) / 2);
console.log('registry di kontrak:', await main.agentRegistry());
console.log('totalPassports:', (await main.totalPassports()).toString());

writeFileSync(join(root, 'deployment-testnet.json'), JSON.stringify({
  chainId: 97,
  deployer: DEPLOYER,
  mockRegistry: mockDeployed,
  mockDeployTx: mock.deploymentTransaction().hash,
  address: mainAddr,
  deployTx: main.deploymentTransaction().hash,
  at: new Date().toISOString(),
}, null, 2));
console.log('deployment-testnet.json tersimpan.');
