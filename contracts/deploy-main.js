const { ethers } = require('ethers');
const fs = require('fs');
const b = require('./build.json');
const dep = require('./.deployer.json');
(async () => {
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(dep.privateKey, provider);
  const factory = new ethers.ContractFactory(b.abi, b.bytecode, wallet);
  const c = await factory.deploy(b.owner, b.baseURI);
  console.log('deploy tx:', c.deploymentTransaction().hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log('MAINNET CONTRACT:', addr);
  fs.writeFileSync('deployed-mainnet.json', JSON.stringify({ address: addr, chainId: 8453, owner: b.owner, baseURI: b.baseURI, abi: b.abi }, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
