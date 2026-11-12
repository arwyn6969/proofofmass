const { ethers } = require('ethers');
const fs = require('fs');
const b = require('./build.json');
const dep = require('./.deployer.json');
(async () => {
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const wallet = new ethers.Wallet(dep.privateKey, provider);
  const factory = new ethers.ContractFactory(b.abi, b.bytecode, wallet);
  const c = await factory.deploy(b.owner, b.baseURI);
  console.log('deploy tx:', c.deploymentTransaction().hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log('CONTRACT DEPLOYED:', addr);
  fs.writeFileSync('deployed.json', JSON.stringify({ address: addr, chainId: 84532, owner: b.owner, baseURI: b.baseURI, abi: b.abi }, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
