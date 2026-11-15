'use strict';
const chains=require('./protocols.json');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
freeze(chains);
function forChain(id=8453){const c=chains[String(id)];if(!c)throw Error('仅支持 Base、Ethereum、BSC 主网');return c;}
function list(){return [8453,1,56].map(id=>{const c=forChain(id);return {chainId:id,network:c.network,nativeSymbol:c.nativeSymbol,wrappedSymbol:c.wrappedSymbol,dexes:c.dexes,gasMode:c.gasMode};});}
module.exports=Object.freeze({...forChain(),forChain,list});
