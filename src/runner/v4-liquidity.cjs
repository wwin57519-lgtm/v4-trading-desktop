'use strict';
const {Interface,AbiCoder,ZeroHash}=require('ethers');
const CONFIG=require('./config.cjs'),V4=require('./v4-pools.cjs'),coder=AbiCoder.defaultAbiCoder();
const lower=x=>String(x||'').toLowerCase();
const uni=new Interface(['function modifyLiquidities(bytes unlockData,uint256 deadline) payable','function modifyLiquiditiesWithoutUnlock(bytes actions,bytes[] params) payable','function multicall(bytes[] data) payable',`function getPoolAndPositionInfo(uint256 tokenId) view returns(${V4.uniKey} poolKey,uint256 info)`]);
const infinity=new Interface(['function modifyLiquidities(bytes payload,uint256 deadline) payable','function modifyLiquiditiesWithoutLock(bytes actions,bytes[] params) payable','function multicall(bytes[] data) payable',`function getPoolAndPositionInfo(uint256 tokenId) view returns(${V4.infinityKey} poolKey,uint256 info)`]);
// The frozen 0x3D31... deployed manager uses the 2025 ABI. Main's September 2026
// minLiquidities field belongs to a newer implementation at a different address.
const binParams=`tuple(${V4.infinityKey} poolKey,uint128 amount0,uint128 amount1,uint128 amount0Max,uint128 amount1Max,uint256 activeIdDesired,uint256 idSlippage,int256[] deltaIds,uint256[] distributionX,uint256[] distributionY,address to,bytes hookData)`;
const binDeltaParams=`tuple(${V4.infinityKey} poolKey,uint128 amount0Max,uint128 amount1Max,uint256 activeIdDesired,uint256 idSlippage,int256[] deltaIds,uint256[] distributionX,uint256[] distributionY,address to,bytes hookData)`;
const clEvent=new Interface(['event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)']);
const binEvent=new Interface(['event Mint(bytes32 indexed id,address indexed sender,uint256[] ids,bytes32 salt,bytes32[] amounts,bytes32 compositionFeeAmount,bytes32 feeAmountToProtocol)']);
function saved(config){return(config.v4Pools||[]).filter(p=>!config.lockedPoolId||config.lockedPoolId===ZeroHash||lower(p.poolId)===lower(config.lockedPoolId));}
function keyItem(config,kind,key){
 const chain=CONFIG.forChain(config.chainId??8453);
 try{const p=V4.normalize({kind,currency0:key.currency0,currency1:key.currency1,hooks:key.hooks,fee:Number(key.fee),tickSpacing:Number(key.tickSpacing??0),...(kind===10?{}:{parameters:key.parameters,manager:key.poolManager})},chain,{dex:config.liquidityDex==='PancakeSwap'?2:0});
  if(saved(config).some(x=>x.kind===kind&&lower(x.poolId)===p.poolId))return{v4:true,kind,poolId:p.poolId,manager:V4.manager(kind,chain),action:kind===10?'Uniswap V4 mint':kind===11?'Infinity CL mint':'Infinity Bin addLiquidity'};
 }catch{}return null;
}
function matches(config,item){return item.v4===true&&saved(config).some(p=>p.kind===item.kind&&lower(p.poolId)===lower(item.poolId));}
function actions(config,tx){
 if(!config.listenLiquidity||!tx?.to||!saved(config).length||config.liquidityFrom&&lower(config.liquidityFrom)!==lower(tx.from))return[];
 const chain=CONFIG.forChain(config.chainId??8453),target=lower(tx.to),v=chain.v4,inf=v.infinity;
 const kind=target===lower(v.positionManager)?10:inf&&target===lower(inf.clPositionManager)?11:inf&&target===lower(inf.binPositionManager)?12:0;
 if(!kind)return[];const iface=kind===10?uni:infinity,out=[];let visited=0;
 function decode(acts,params){const bytes=Buffer.from(acts.slice(2),'hex');if(bytes.length!==params.length||bytes.length>128)return;
  for(let i=0;i<bytes.length;i++){const a=bytes[i],data=params[i];if(typeof data!=='string'||data.length>2*1024*1024)continue;
   try{let item;if(kind!==12&&(a===2||a===5)){
    const types=[kind===10?V4.uniKey:V4.infinityKey,'int24','int24',...(a===2?['uint256']:[]),'uint128','uint128','address','bytes'];const r=coder.decode(types,data);
    if(a===2?r[3]>0n:r[3]>0n||r[4]>0n)item=keyItem(config,kind,r[0]);
   }else if(kind!==12&&(a===0||a===4)){
    const r=coder.decode(a===0?['uint256','uint256','uint128','uint128','bytes']:['uint256','uint128','uint128','bytes'],data);
    // Zero liquidity is a fee-collection/poke operation, not a pool launch.
    // Decode the full official tuple so a truncated ID-only payload cannot match.
    if(a===0?r[1]>0n:r[1]>0n||r[2]>0n)out.push({v4:true,kind,manager:target,tokenId:String(r[0]),action:kind===10?'Uniswap V4 increaseLiquidity':'Infinity CL increaseLiquidity'});
   }
   else if(kind===12&&(a===0x19||a===0x1b)){
    const [r]=coder.decode([a===0x19?binParams:binDeltaParams],data);
    const positive=a===0x19?r.amount0>0n||r.amount1>0n:r.amount0Max>0n||r.amount1Max>0n;
    if(positive&&r.deltaIds.length>0&&r.deltaIds.length===r.distributionX.length&&r.deltaIds.length===r.distributionY.length&&[...r.distributionX,...r.distributionY].some(x=>x>0n))item=keyItem(config,kind,r.poolKey);
   }
   if(item)out.push(item);
   }catch{}
  }
 }
 function visit(data,depth=0){if(depth>4||++visited>128||typeof data!=='string'||data.length>2*1024*1024)return;let call;try{call=iface.parseTransaction({data});}catch{return;}if(!call)return;
  if(call.name==='multicall'){for(const d of call.args.data)visit(d,depth+1);return;}
  if(call.name==='modifyLiquidities'){try{const [a,p]=coder.decode(['bytes','bytes[]'],call.args[0]);decode(a,p);}catch{}return;}
  decode(call.args.actions,call.args.params);
 }
 visit(tx.input||tx.data);return out;
}
async function position(config,item,pool){const iface=item.kind===10?uni:infinity;const raw=await pool.read('call',{to:item.manager,data:iface.encodeFunctionData('getPoolAndPositionInfo',[item.tokenId])});const [key]=iface.decodeFunctionResult('getPoolAndPositionInfo',raw);return keyItem(config,item.kind,key);}
function logFilter(config){if(!config.listenLiquidity||!saved(config).length)return null;const chain=CONFIG.forChain(config.chainId??8453),pools=saved(config);return{address:[...new Set(pools.map(p=>V4.manager(p.kind,chain)))],topics:[[clEvent.getEvent('ModifyLiquidity').topicHash,binEvent.getEvent('Mint').topicHash],pools.map(p=>p.poolId)]};}
function logMatch(config,log){if(log?.removed||!Array.isArray(log?.topics)||!log.topics[1])return null;const chain=CONFIG.forChain(config.chainId??8453),p=saved(config).find(p=>lower(p.poolId)===lower(log.topics[1])&&lower(V4.manager(p.kind,chain))===lower(log.address));if(!p)return null;
 try{const r=(p.kind===12?binEvent:clEvent).parseLog(log);if(p.kind===12?!r.args.amounts.some(x=>BigInt(x)>0n):r.args.liquidityDelta<=0n)return null;return{v4:true,kind:p.kind,poolId:p.poolId,manager:log.address,action:p.kind===12?'Infinity Bin Mint 事件':'V4 ModifyLiquidity 事件'};}catch{return null;}
}
module.exports={actions,matches,position,logFilter,logMatch,uni,infinity,binParams,binDeltaParams,clEvent,binEvent,keyItem};
