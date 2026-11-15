'use strict';
const {isAddress,Transaction}=require('ethers');
const hash32=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
function invalid(){const e=Error('节点回执或交易与本地签名记录不匹配，继续保留发送锁和费用预算');e.code='RPC_INVALID_RESPONSE';return e;}
// Structural/binding validation is not a proof of inclusion. A fully dishonest
// RPC can still forge matching receipts; use a trusted independent Base node.
function validateReceipt(receipt,hash,record){
 if(!hash32(hash)||!hash32(receipt?.hash)||!same(receipt.hash,hash)||!hash32(receipt.blockHash)||!Number.isSafeInteger(receipt.blockNumber)||receipt.blockNumber<0||![0,1].includes(receipt.status)||!isAddress(receipt.from)||(receipt.to!==null&&!isAddress(receipt.to)))throw invalid();
 if(record){const expectedTo=Object.hasOwn(record,'receiptTo')?record.receiptTo:record.to;if(!same(receipt.from,record.from)||(expectedTo===null?receipt.to!==null:!same(receipt.to,expectedTo)))throw invalid();}
 return receipt;
}
// Recovery must identify a real owner-signed Base transaction. Recompute the
// hash and sender from its signature, rather than trusting RPC from/hash fields.
function validateRecoveredTransaction(tx,hash,expectedChainId=8453){
 try{const signed=Transaction.from(tx);if(!signed.isSigned()||signed.chainId!==BigInt(expectedChainId)||!same(signed.hash,hash)||!same(tx.hash,hash)||!same(signed.from,tx.from)||!Number.isSafeInteger(tx.nonce)||tx.nonce<0||signed.gasLimit<=0n||(signed.maxFeePerGas??signed.gasPrice??0n)<=0n)throw invalid();return signed;}catch{throw invalid();}
}
function receiptFee(receipt,record){
 try{const used=BigInt(receipt.gasUsed),price=BigInt(receipt.gasPrice),limit=BigInt(record.receiptGasLimit??record.gasLimit??record.tx?.gasLimit),cap=BigInt(record.receiptFeeCapWei??record.feeCapWei??record.tx?.maxFeePerGas??record.tx?.gasPrice);if(receipt.gasUsed==null||receipt.gasPrice==null||used<=0n||price<0n||limit<=0n||cap<=0n||used>limit||price>cap)return null;return used*price;}catch{return null;}
}
module.exports={validateReceipt,validateRecoveredTransaction,receiptFee};
