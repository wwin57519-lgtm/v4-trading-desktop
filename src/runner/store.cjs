const fs=require('node:fs');const path=require('node:path');
class Store{
  constructor(file,safeStorage){this.file=file;this.safeStorage=safeStorage;}
  backup(){if(fs.existsSync(this.file)&&!fs.existsSync(this.file+'.pre-multichain.bak'))fs.copyFileSync(this.file,this.file+'.pre-multichain.bak');}
  read(){if(!fs.existsSync(this.file))return{};const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(saved.encrypted){if(!this.safeStorage.isEncryptionAvailable())throw Error('无法解密本机交易记录，请使用原 Windows 用户运行');return JSON.parse(this.safeStorage.decryptString(Buffer.from(saved.encrypted,'base64')));}return saved;}
  write(data){const output=this.safeStorage.isEncryptionAvailable()?{version:1,encrypted:this.safeStorage.encryptString(JSON.stringify(data)).toString('base64')}:{version:1,schemaVersion:data.schemaVersion,selectedChainId:data.selectedChainId,networks:Object.fromEntries(Object.entries(data.networks||{}).map(([id,p])=>[id,{task:p.task||null}])),journal:data.journal||[],task:data.task||null};fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(output));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,this.file);}
}
module.exports={Store};
