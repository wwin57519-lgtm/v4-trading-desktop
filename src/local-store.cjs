const fs = require('node:fs');
const path = require('node:path');

// RPC URLs can contain access tokens. Store them using the operating system's
// encryption service; administrator wallet keys live only in main-process memory and are never persisted.
class LocalStore {
  constructor(file, safeStorage) { this.file = file; this.safeStorage = safeStorage; }
  backup(){if(fs.existsSync(this.file)){const backup=this.file+'.pre-multichain.bak';if(!fs.existsSync(backup))fs.copyFileSync(this.file,backup);}}
  read() {
    if (!fs.existsSync(this.file)) return {};
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.rpcEncrypted && this.safeStorage.isEncryptionAvailable()) {
      try { data.rpcUrl = this.safeStorage.decryptString(Buffer.from(data.rpcEncrypted, 'base64')); }
      catch { data.rpcUrl = ''; }
    }
    for(const profile of Object.values(data.networks||{})){if(profile.rpcEncrypted&&this.safeStorage.isEncryptionAvailable())try{profile.rpcUrl=this.safeStorage.decryptString(Buffer.from(profile.rpcEncrypted,'base64'));}catch{profile.rpcUrl='';}delete profile.rpcEncrypted;}
    delete data.rpcEncrypted;
    return data;
  }
  write(data) {
    const saved = JSON.parse(JSON.stringify(data, (key,value) => /^(?:privateKey|privateKeys|secretKey|mnemonic|seed|signer|rawTransaction|rawTx|signedTransaction)$/i.test(key) ? undefined : value));
    for(const profile of Object.values(saved.networks||{})){const url=profile.rpcUrl;delete profile.rpcUrl;delete profile.transactions;if(url&&this.safeStorage.isEncryptionAvailable())profile.rpcEncrypted=this.safeStorage.encryptString(url).toString('base64');}
    delete saved.rpcUrl;
    delete saved.wallet;
    if (data.rpcUrl && this.safeStorage.isEncryptionAvailable()) {
      saved.rpcEncrypted = this.safeStorage.encryptString(data.rpcUrl).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(saved, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
}
module.exports = { LocalStore };
