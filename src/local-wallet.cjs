'use strict';
const {Wallet,keccak256}=require('ethers');
// Signing material is confined to the main process and never serialized.
class LocalWallet {
  #signer=null;
  import(privateKey){
    if(typeof privateKey!=='string'||! /^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey.trim()))throw Error('请导入一个有效的 32 字节钱包私钥；不支持助记词或多个私钥');
    let next;
    try {next=new Wallet(privateKey.trim().startsWith('0x')?privateKey.trim():'0x'+privateKey.trim());}
    catch {throw Error('私钥无效，请检查后重新导入');}
    this.#signer=next;return next.address;
  }
  get address(){return this.#signer?.address||null;}
  clear(){this.#signer=null;}
  async sign(request){
    if(!this.#signer)throw Error('管理员钱包已锁定，请重新导入私钥');
    try{const raw=await this.#signer.signTransaction(request);return {raw,hash:keccak256(raw)};}
    catch {throw Error('本地签名失败，未广播交易；请检查交易参数和钱包状态');}
  }
}
module.exports={LocalWallet};
