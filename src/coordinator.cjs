'use strict';
const OWNER_WRITES=new Set(['contract.deploy','contract.save','trade.buy','funds.deposit','funds.withdraw','trigger.wallets','trigger.arm','trigger.disarm']);
const OWNER_CONTEXT=new Set(['network.select','rpc.connect','wallet.import','wallet.disconnect','contract.load','contract.read','transaction.refresh','transaction.recover','trigger.read']);
const RUNNER_CONTEXT=new Set(['network.select','rpc.test','contract.inspect','wallets.import','wallets.importFile','wallets.lock','vault.unlock','vault.save','wallets.list','task.preview','task.start','journal.refresh','journal.recover','journal.diagnose']);
// All keys stay in their original main-process wallet components. Coordination
// shares only network and public contract address, never a signer or private key.
class Coordinator {
 constructor({owner,runner,store}){this.owner=owner;this.runner=runner;this.store=store;this.state=store.read()||{};this.state.contracts??={};this.generation=0;this.busy=false;this.closed=false;this.ensureAligned();this.bindAddress(this.state.contracts[owner.chain.chainId]||null);}
 ensureAligned(){if(this.owner.chain.chainId!==this.runner.chain.chainId)throw Error('两个页面网络状态不一致，拒绝运行');}
 bindAddress(address){this.address=address;if(this.owner.loadedContract?.address!==address)this.owner.loadedContract=null;this.owner.contractAddress=address;this.runner.contract=null;this.runner.config={...this.runner.config,contractAddress:address||'',v4Pools:[],lockedPoolId:'0x'+'0'.repeat(64)};}
 clearContext(message){this.bindAddress(null);this.owner.recoveryOnly=false;this.generation++;this.owner.contextGeneration++;this.owner.emit({type:'context-reset',level:'warning',message});}
 commitAddress(address){
  const next={...this.state,contracts:{...this.state.contracts,[this.owner.chain.chainId]:address}};
  try{this.store.write(next);}catch{const message='两个页面的合约地址保存失败，已清空操作目标；请修复磁盘或写入权限后重新加载合约。';this.clearContext(message);throw Error(message);}
  this.state=next;this.bindAddress(address);
 }
 async drain(){await this.runner.stop('管理员或上下文操作，本地停止提交；已广播交易继续保留');if(this.runner.run)await Promise.allSettled([...this.runner.run.operations]);while(this.runner.pollBusy)await new Promise(r=>setTimeout(r,10));}
 async invoke(role,method,args={}){
  if(this.closed)throw Error('程序正在关闭');this.ensureAligned();
  const exclusive=method==='network.select'||(role==='owner'?OWNER_WRITES.has(method)||OWNER_CONTEXT.has(method):RUNNER_CONTEXT.has(method));
  if(this.busy&&method!=='app.info'&&method!=='task.stop')throw Error('正在协调管理员或网络操作，请等待完成');
  if(!exclusive){const generation=this.generation,result=await this[role].invoke(method,args);if(generation!==this.generation||this.closed)throw Error('页面上下文已变化，丢弃旧结果');if(method==='app.info')return{...result,rpcConnected:role==='owner'?!!this.owner.provider:!!this.runner.pool,localTaskActive:this.runner.active(),contract:role==='owner'?this.owner.loadedContract||null:result.contract};return result;}
  this.busy=true;this.runner.switchingNetwork=true;
  try{
   const changing=method==='network.select'||(role==='owner'&&(OWNER_WRITES.has(method)||['rpc.connect','wallet.import','wallet.disconnect','contract.load','contract.read'].includes(method)))||(role==='runner'&&['rpc.test','wallets.import','wallets.importFile','wallets.lock','vault.unlock','contract.inspect'].includes(method));
   if(changing){await this.drain();this.generation++;this.owner.contextGeneration++;}
   if(method==='network.select'){
    const previous=this.owner.chain.chainId;require('./config.cjs').forChain(args.chainId);
    try{await this.owner.invoke(method,args);await this.runner.invoke(method,args);this.ensureAligned();const next={...this.state,selectedChainId:this.owner.chain.chainId};this.store.write(next);this.state=next;this.bindAddress(null);}
    catch(e){try{if(this.owner.chain.chainId!==previous)this.owner.selectNetwork(previous,true);if(this.runner.chain.chainId!==previous)await this.runner.selectNetwork(previous,true);}finally{this.clearContext('网络切换未完成，已清空合约目标，请重新测试 RPC 并加载合约。');}throw e;}
    return this[role].info();
   }
   if(role==='runner'&&['contract.inspect','task.start','task.preview'].includes(method)){
    if(this.owner.loadedContract?.recoveryOnly&&method!=='contract.inspect')throw Error('部署页面当前仅加载用于提款；请完整加载合约后再开启触发任务');
    if(!this.address)throw Error('请先在部署与资金管理页面加载 V4 执行合约');
    if(method==='contract.inspect'){if(args.address&&args.address.toLowerCase()!==this.address.toLowerCase())throw Error('合约地址必须与部署页面相同');args={...args,address:this.address};}
    else {if(args.config?.contractAddress&&args.config.contractAddress.toLowerCase()!==this.address.toLowerCase())throw Error('触发目标与部署页面不一致');args={...args,config:{...args.config,contractAddress:this.address}};}
   }
   // Both components can be manually given the same wallet. Draining local
   // signing does not cancel a transaction already handed to an RPC, so consult
   // both journals before allowing the other role to reuse its chain/nonce lane.
   const open=new Set(['prepared','awaitingWallet','pending','unknown']),chainId=this.owner.chain.chainId;
   if(role==='owner'&&OWNER_WRITES.has(method)&&this.owner.wallet){
    const from=this.owner.wallet.address.toLowerCase();
    if(this.runner.journal.some(r=>(r.chainId??8453)===chainId&&open.has(r.status)&&r.from?.toLowerCase()===from))throw Error('管理员钱包仍有触发器已广播或结果未知的交易；请先核对触发交易回执，再发送管理员交易');
   }
   if(role==='runner'&&['task.start','task.preview'].includes(method)){
    const selected=new Set(this.runner.vault.list().slice(0,Number(args.config?.walletLimit??20)).map(w=>w.address.toLowerCase()));
    if(this.owner.transactions.some(r=>(r.chainId??8453)===chainId&&open.has(r.status)&&selected.has(r.from?.toLowerCase())))throw Error('所选触发钱包仍有管理员交易待确认或结果未知；请先核对管理员交易回执');
   }
   const previous=this.address,result=await this[role].invoke(method,args);
   try{if(role==='owner'){
    if(['contract.load','contract.read','contract.deploy'].includes(method)&&result.address)this.commitAddress(result.address);
    else if(['rpc.connect','wallet.import','wallet.disconnect'].includes(method))this.commitAddress(null);
    else if(this.owner.contractAddress!==previous)this.commitAddress(this.owner.contractAddress);
    else if(OWNER_WRITES.has(method)){this.runner.contract=null;}
   }}catch(e){if(result?.status!=='confirmed')throw e;return{...result,address:null,contextCleared:true,refreshWarning:['交易已确认，后续页面状态保存失败；不要重复提交。',result.refreshWarning,e.message].filter(Boolean).join(' ')};}
   return result;
  }finally{this.runner.switchingNetwork=false;this.busy=false;}
 }
 async close(){this.closed=true;this.generation++;this.owner.beginShutdown();try{this.owner.persist();}finally{try{await this.runner.close();}finally{await this.owner.close();}}}
}
module.exports={Coordinator};
