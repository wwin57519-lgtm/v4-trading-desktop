'use strict';
const {performance}=require('node:perf_hooks');
// Poll receipts directly: a cached initial height followed by a missed block
// subscription must not hide a mined transaction on a quiet node/local fork.
async function waitReceipt(provider,hash,{timeoutMs=120000,pollMs=1000,stopped=()=>false}={}){
 const deadline=performance.now()+timeoutMs;
 for(;;){
  if(stopped())return null;
  try{
   const receipt=await provider.getTransactionReceipt(hash);
   if(receipt){
    // Invalid responses go to the caller's strict receipt validator; they
    // cannot silently become a successful confirmation or release a lock.
    if(!Number.isSafeInteger(receipt.blockNumber)||receipt.blockNumber<0)return receipt;
    const height=await provider.getBlockNumber();
    if(Number.isSafeInteger(height)&&height>=receipt.blockNumber)return receipt;
   }
  }catch{}
  const left=deadline-performance.now();if(left<=0||stopped())return null;
  await new Promise(r=>setTimeout(r,Math.min(pollMs,left)));
 }
}
module.exports={waitReceipt};
