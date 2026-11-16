const {validateReceipt, validateRecoveredTransaction, receiptFee}=require('./receipt-security.cjs');
const crypto=require('node:crypto');
const {Contract,Interface,formatUnits,keccak256,getAddress,ZeroAddress}=require('ethers');
const {CONFIG,addr,units,integer,cleanError,rpcUrl,RpcPool}=require('./runtime.cjs');
const {Monitor}=require('./monitor.cjs');
const DEX=require('./dex.cjs');
const CONTRACTS=require('../contract-artifacts.cjs');
const {TaskWindow}=require('./task-window.cjs');
const {performance}=require('node:perf_hooks');
const OPEN=new Set(['prepared','pending','unknown']);
const ACTIVE=new Set(['armed','running','stopping']);
const WRITE_CONTEXT=new Set(['network.select','journal.refresh','journal.diagnose','journal.recover','wallets.list','rpc.test','contract.inspect','wallets.import','wallets.importFile','wallets.lock','vault.unlock','task.preview','task.start']);
async function mapLimit(items,limit,fn){const results=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const i=next++;if(i>=items.length)return;results[i]=await fn(items[i],i);}}));return results;}
function normalize(raw={},chain=CONFIG){
 const c={...raw,chainId:chain.chainId};c.rpcUrls=[...new Set((Array.isArray(c.rpcUrls)?c.rpcUrls:[]).map(x=>rpcUrl(x)))];if(!c.rpcUrls.length||c.rpcUrls.length>12)throw Error('请填写 1–12 个 RPC');
 c.contractAddress=addr(c.contractAddress,'专属合约地址');
 if(!['block','time','probe','listen'].includes(c.mode))throw Error('请选择触发模式');
 c.walletLimit=integer(c.walletLimit??20,1,500,'钱包数量');c.concurrency=integer(c.concurrency??4,1,c.walletLimit,'并发数量');
 c.intervalMs=integer(c.intervalMs??250,1,3600000,'发送间隔');c.probeIntervalMs=integer(c.probeIntervalMs??250,50,3600000,'嗅探间隔');c.maxAttempts=integer(c.maxAttempts??0,0,1000000000,'发送次数');c.rpcRps=integer(c.rpcRps??20,1,1000,'每节点请求上限');
 c.startBlock=String(c.startBlock||'0');if(!/^\d+$/.test(c.startBlock)||BigInt(c.startBlock)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('区块高度无效');
 c.startTime=c.startTime||'';if(c.mode==='time'&&!Number.isFinite(Date.parse(c.startTime)))throw Error('请选择完整的本地开始日期和时间');
 c.gasMode=(c.gasMode||chain.gasMode)==='legacy'?'legacy':'eip1559';c.gasLimit=String(integer(c.gasLimit??4000000,21000,16000000,'Gas Limit'));
 c.gasPriceGwei=String(c.gasPriceGwei??'0.01');c.maxFeeGwei=String(c.maxFeeGwei??'0.1');c.maxPriorityFeeGwei=String(c.maxPriorityFeeGwei??'0.001');
 const gasPrice=units(c.gasPriceGwei,9,'Gas Price'),maxFee=units(c.maxFeeGwei,9,'费用上限'),tip=units(c.maxPriorityFeeGwei,9,'优先费');
 if(c.gasMode==='legacy'&&!gasPrice||c.gasMode==='eip1559'&&(!maxFee||tip>maxFee))throw Error('Gas 费率应大于 0，优先费不能超过费用上限');
 c.gasBudgetEth=String(c.gasBudgetEth??'0.01');units(c.gasBudgetEth,18,'累计执行 Gas 预算');
 c.delaySeconds=integer(c.delaySeconds??0,0,86400,'监听延迟秒数');
 c.listenFeed=c.listenFeed==='flashblocks'?'flashblocks':'pending';if(c.listenFeed==='flashblocks'&&chain.chainId!==8453)throw Error('Flashblocks 仅支持 Base');
 c.listenLiquidity=c.listenLiquidity===true;c.followLiquidityGas=c.followLiquidityGas===true;
 c.liquidityFrom=c.liquidityFrom?addr(c.liquidityFrom,'流动性添加者'):'';
 c.liquidityRouter=c.liquidityRouter?addr(c.liquidityRouter,'流动性路由'):chain.v4.positionManager;
 c.liquidityToken=c.liquidityToken?addr(c.liquidityToken,'监听 Token'):'';
 c.customActions=(c.customActions||[]).map(r=>{const from=r.from?addr(r.from,'动作来源'):'';const to=r.to?addr(r.to,'动作目标'):'';const selector=String(r.selector||'').trim().toLowerCase();const match=r.match==='selector'?'selector':'contains';if(selector&&(!/^0x(?:[a-f0-9]{2})+$/.test(selector)||(match==='selector'&&selector.length!==10)))throw Error('动作需要 0x 开头的十六进制；严格选择器必须 4 字节');if(!from&&!to&&!selector)throw Error('自定义监听规则不能全部为空');const gasPriceGwei=String(r.gasPriceGwei||'0');units(gasPriceGwei,9,'动作 Gas Price');return{from,to,selector,match,gasPriceGwei};});
 if(c.customActions.length>100)throw Error('自定义动作最多 100 条');
 if(c.mode==='listen'){c.monitorRpc=rpcUrl(c.monitorRpc,true);if(!c.listenLiquidity&&!c.customActions.length)throw Error('监听模式至少需要一个监听条件');}
 else c.monitorRpc=c.monitorRpc?rpcUrl(c.monitorRpc,true):'';
 return c;
}
class Engine{
 constructor({store,vault,artifact,providerFactory,monitorFactory,onEvent=()=>{},openExternal=()=>{},copyText=()=>{throw Error('本机剪贴板不可用');},importFile}={}){
  this.store=store;this.vault=vault;
  this.artifact=artifact||CONTRACTS.rebuiltArtifact;
  this.iface=new Interface(this.artifact.abi);
  this.providerFactory=providerFactory;this.monitorFactory=monitorFactory;this.emit=onEvent;this.openExternal=openExternal;this.copyText=copyText;this.importFile=importFile;
  this.rootData=require('./network-state.cjs').migrate(store?.read?.()||{},store,'trigger');this.chain=CONFIG.forChain(this.rootData.selectedChainId);const data={...(this.rootData.networks[this.chain.chainId]||{}),journal:this.rootData.journal};this.config=data.config||{};this.closed=false;this.journal=(data.journal||[]).map(r=>({...r,chainId:r.chainId??8453})).map(r=>r.status==='prepared'?{...r,status:'unknown'}:r.status==='superseded'&&!r.blockNumber?{...r,feeUnverified:true}:r);this.contract=null;this.pool=null;this.walletCache=new Map();this.contextBusy=false;this.pollBusy=false;this.run=null;this.startGeneration=0;
  this.task=data.task?{...data.task,status:'stopped',reason:'程序重启后不会自动恢复签名，请核对未确认交易后手动开始'}:{status:'idle',counters:{attempts:0,submitted:0,confirmed:0,reverted:0,pending:0}};
  this.pollTimer=setInterval(()=>this.poll().catch(e=>this.log('状态检查失败：'+cleanError(e),'warn')),1000);this.pollTimer.unref?.();
 }
 log(message,level='info'){this.emit({type:'log',message,level});}
 persist(){const keep=new Set([...this.journal.slice(-2000),...this.journal.filter(r=>OPEN.has(r.status)||r.feeUnverified)]);for(const r of this.journal)if(!keep.has(r)&&r.taskId===this.task.id){const a=this.task.archived||(this.task.archived={attempts:0,submitted:0,confirmed:0,reverted:0,executionFee:'0'});a.attempts++;if(r.accepted)a.submitted++;if(r.status==='confirmed')a.confirmed++;if(r.status==='reverted')a.reverted++;a.executionFee=String(BigInt(a.executionFee)+BigInt(r.executionFee||0));}this.journal=this.journal.filter(r=>keep.has(r));this.rootData.networks[this.chain.chainId]={config:this.config,task:this.task};this.rootData.selectedChainId=this.chain.chainId;this.rootData.journal=this.journal;this.store?.write?.(this.rootData);}
 publicJournal(){return this.journal.map(({tx,...r})=>r);}
 publicWallets(){return this.vault.list().map(w=>({...w,...this.walletCache.get(w.address.toLowerCase()),pending:this.journal.some(r=>(r.chainId??8453)===this.chain.chainId&&r.from.toLowerCase()===w.address.toLowerCase()&&OPEN.has(r.status))}));}
 info(){return{version:require('../../package.json').version,chainId:this.chain.chainId,network:this.chain.network,nativeSymbol:this.chain.nativeSymbol,wrappedSymbol:this.chain.wrappedSymbol,explorer:this.chain.explorer,networks:CONFIG.list(),gasMode:this.chain.gasMode,config:this.config,wallets:this.publicWallets(),vault:this.vault.info(),contract:this.contract,task:this.task,journal:this.publicJournal()};}
 active(){return !!this.run?.active;}
 canSend(run){if(!run?.active)return false;if(run.window.expired()){this.stop('本轮有效期已到，本机停止签名和提交；链上执行仍以合约时间为准').catch(e=>this.log(cleanError(e),'error'));return false;}return true;}
 scheduleExpiry(run){clearTimeout(run.expiryTimer);if(!run.active)return;run.expiryTimer=setTimeout(()=>{if(this.canSend(run))this.scheduleExpiry(run);},Math.max(1,Math.min(60000,run.window.remainingMs())));run.expiryTimer.unref?.();}
 async invoke(method,args={}){
  if(this.closed)throw Error('程序已关闭');const generation=this.startGeneration,chain=this.chain;
  const context=WRITE_CONTEXT.has(method);
  if(context&&(this.contextBusy||(!['network.select','journal.refresh','journal.diagnose','journal.recover','wallets.list'].includes(method)&&(this.active()||this.run?.operations?.size>0))))throw Error('任务或操作正在进行，请停止后再更改钱包、节点或合约');
  if(context)this.contextBusy=true;
  try{
   switch(method){
    case'network.select':return await this.selectNetwork(args.chainId,true);
    case'app.info':return this.info();
    case'rpc.test':return await this.connect(args.urls,args.rps);
    case'contract.inspect':return await this.inspect(args.address);
    case'wallets.import':{const result=this.vault.import(args.text);this.walletCache.clear();this.emit({type:'wallets',wallets:this.publicWallets()});return{...result,wallets:this.publicWallets(),vault:this.vault.info()};}
    case'wallets.importFile':{const text=await this.importFile();if(text==null)return{cancelled:true,wallets:this.publicWallets()};const result=this.vault.import(text);this.walletCache.clear();return{...result,wallets:this.publicWallets(),vault:this.vault.info()};}
    case'wallets.list':await this.refreshWallets();return this.publicWallets();
    case'wallets.copyAddresses':{const addresses=this.vault.list().map(w=>w.address);if(!addresses.length)throw Error('请先导入钱包');await this.copyText(addresses.join('\n'));return{count:addresses.length};}
    case'wallets.lock':this.vault.lock();this.walletCache.clear();this.emit({type:'wallets',wallets:[]});return this.vault.info();
    case'vault.save':await this.vault.save(args.password);return this.vault.info();
    case'vault.unlock':await this.vault.unlock(args.password);this.walletCache.clear();return{wallets:this.publicWallets(),vault:this.vault.info()};
    case'task.preview':return await this.preview(args.config);
    case'task.start':return await this.start(args.config);
    case'task.stop':return await this.stop('本机已停止提交；链上本轮仍需结束或等到期');
    case'journal.refresh':await this.poll();return this.publicJournal();
    case'journal.diagnose':return await this.diagnose(args.hash);
    case'journal.recover':return await this.recover(args.hash);
    case'app.openExternal':{const url=new URL(args.url);if(url.protocol!=='https:'||!['basescan.org','etherscan.io','bscscan.com'].includes(url.hostname))throw Error('只允许所支持网络的区块浏览器链接');return this.openExternal(url.href);}
    default:throw Error('不支持的操作');
   }
  }catch(e){const message=cleanError(e);this.log(message,'error');throw Error(message);}finally{if(context)this.contextBusy=false;}
 }
 async selectNetwork(id,locked=false){
  const next=CONFIG.forChain(id);if(!locked&&(this.contextBusy||this.pollBusy))throw Error('已有网络操作正在处理');
  if(next.chainId===this.chain.chainId)return this.info();
  this.switchingNetwork=true;try{let stopError;try{await this.stop('切换网络，本地任务停止；已广播交易仍保留在原链记录');}catch(e){stopError=e;}if(this.run)await Promise.allSettled([...this.run.operations]);if(stopError)throw stopError;
  while(this.pollBusy)await new Promise(r=>setTimeout(r,10));
  this.persist();
  const data=this.rootData.networks[next.chainId]||{},config=data.config||{gasMode:next.gasMode,chainId:next.chainId};
  const task=data.task?{...data.task,status:'stopped',reason:'切链后请重新核对并启动'}:{status:'idle',counters:{}};
  const root={...this.rootData,selectedChainId:next.chainId,networks:{...this.rootData.networks,[next.chainId]:{config,task}},journal:this.journal};
  this.store?.write?.(root);
  const previousPool=this.pool;
  this.rootData=root;this.chain=next;this.config=config;this.task=task;
  this.startGeneration++;this.pool=null;this.contract=null;this.run=null;this.walletCache.clear();
  try{previousPool?.destroy();}catch{}
  return this.info();}finally{this.switchingNetwork=false;}
 }
 async connect(urls,rps=20){
  const generation=this.startGeneration,chain=this.chain;rps=integer(rps??20,1,1000,'每节点请求上限');
  const pool=new RpcPool({factory:this.providerFactory,rps,chainId:chain.chainId,onError:e=>this.log(e,'warn')});let committed=false;
  try{
   const endpoints=await pool.connect(urls||[]),blockNumber=await pool.read('getBlockNumber'),fees=await pool.fees();
   if(this.closed||generation!==this.startGeneration||chain!==this.chain)throw Error('连接上下文变化，丢弃旧 RPC');
   const config={...this.config,rpcUrls:pool.urls,rpcRps:rps};
   const root={...this.rootData,selectedChainId:chain.chainId,networks:{...this.rootData.networks,[chain.chainId]:{config,task:this.task}},journal:this.journal};
   this.store?.write?.(root);
   const previousPool=this.pool;
   pool.installLimiters();this.rootData=root;this.config=config;this.pool=pool;committed=true;this.contract=null;
   try{previousPool?.destroy();}catch{}
   return{chainId:chain.chainId,blockNumber,endpoints,fees};
  }finally{if(!committed)pool.destroy();}
 }
 requirePool(){if(!this.pool)throw Error('请先测试连接当前网络 RPC');return this.pool;}
 async contractAt(raw){
  const pool=this.requirePool(),target=addr(raw,'专属合约地址');
  const code=await pool.read('getCode',target),matched=CONTRACTS.identifyExecutor(code,this.artifact);
  if(!matched)throw Error('该地址的运行时代码与支持的执行合约不匹配');
  const contract=new Contract(target,matched.artifact.abi,pool.primary);
  Object.defineProperties(contract,{
   verifiedVersion:{value:matched.version},
   strictTriggerLimits:{value:matched.strictTriggerLimits===true}
  });
  await DEX.validateDependencies(contract,pool.primary,matched.helpers,{},this.chain);
  return contract;
 }
 async inspect(raw){const generation=this.startGeneration,pool=this.pool;const c=await this.contractAt(raw);const [owner,executed,armed,epoch,policy,s,block]=await Promise.all([c.owner(),c.executed(),c.triggerArmed(),c.triggerEpoch(),c.getTriggerPolicy(),c.getSettings(),this.pool.read('getBlock','latest')]);const contract={address:await c.getAddress(),owner,executed,triggerArmed:armed,triggerEpoch:String(epoch),policy:{amountIn:String(policy.amountIn),slippageBps:Number(policy.slippageBps),notBefore:Number(policy.notBefore),expiresAt:Number(policy.expiresAt)},settings:{tokenIn:s.tokenIn,tokenOut:s.tokenOut,recipient:s.recipient,priceMode:Number(s.priceMode),minBuyAmount:String(s.minBuyAmount)},supported:true,strictTriggerLimits:c.strictTriggerLimits,version:'执行器 '+(c.verifiedVersion||'0.5.0'),...await DEX.policy(c),blockTimestamp:block.timestamp,blockObservedAt:Date.now()};if(this.closed||generation!==this.startGeneration||pool!==this.pool)throw Error('合约读取上下文变化');this.contract=contract;this.config={...this.config,contractAddress:this.contract.address,v4Pools:this.contract.v4Pools||[],lockedPoolId:this.contract.lockedPoolId||require('ethers').ZeroHash};return this.contract;}
 async refreshWallets(){if(!this.pool)return;const c=this.contract?new Contract(this.contract.address,this.artifact.abi,this.pool.primary):null;await mapLimit(this.vault.list(),4,async w=>{try{const [balance,authorized]=await Promise.all([this.pool.read('getBalance',w.address),c?c.isTriggerWallet(w.address):null]);this.walletCache.set(w.address.toLowerCase(),{balance:formatUnits(balance,18),authorized});}catch(e){this.walletCache.set(w.address.toLowerCase(),{error:cleanError(e)});}});this.emit({type:'wallets',wallets:this.publicWallets()});}
 async prepare(raw){const config=normalize(raw,this.chain);if(!this.pool||JSON.stringify(this.pool.urls)!==JSON.stringify(config.rpcUrls)||this.pool.rps!==config.rpcRps)await this.connect(config.rpcUrls,config.rpcRps);const contract=await this.inspect(config.contractAddress);
  if(config.mode==='listen'&&config.listenLiquidity){config.liquidityDex=contract.dex===2?'PancakeSwap':'Uniswap';config.liquidityToken=config.liquidityToken||contract.settings.tokenOut;config.liquidityTargets=[];}
  if(contract.strictTriggerLimits&&(BigInt(contract.policy.amountIn)<=0n||
     BigInt(contract.settings.minBuyAmount)<=0n||contract.policy.slippageBps!==10000)){
    throw Error('新版合约须由管理员设置正数投入金额和固定最低实收后开启本轮');
   }
  // Never trust candidate keys supplied by renderer/local configuration.
  config.v4Pools=contract.v4Pools||[];config.lockedPoolId=contract.lockedPoolId||require('ethers').ZeroHash;
  if(config.mode==='listen'&&config.listenLiquidity&&config.v4Pools.length){const v=this.chain.v4,inf=v.infinity;config.liquidityTargets.push(...[v.positionManager,...(inf?[inf.clPositionManager,inf.binPositionManager]:[])]);}
  if(!contract.triggerArmed)throw Error('合约尚未武装；请在部署工具中由所有者授权钱包并设置触发参数');if(contract.executed)throw Error('合约已经完成本轮买入，请先由所有者保存新设置并重新武装');const block=await this.pool.read('getBlock','latest'),observedMonotonic=performance.now(),observedAt=Date.now();if(!Number.isSafeInteger(contract.policy.expiresAt)||contract.policy.expiresAt<=0)throw Error('合约必须配置有效的链上截止时间');if(config.mode==='time'&&Date.parse(config.startTime)>=contract.policy.expiresAt*1000)throw Error('定时开始必须早于本轮链上截止时间');if(contract.policy.expiresAt<=block.timestamp)throw Error('触发授权已到期，需要所有者重新武装');const all=this.vault.list();if(!all.length)throw Error('请在本机导入或解锁触发钱包');if(config.walletLimit>all.length)throw Error(`只导入了 ${all.length} 个钱包，请调整钱包数量`);const selected=all.slice(0,config.walletLimit);const c=new Contract(contract.address,this.artifact.abi,this.pool.primary);const cap=BigInt(config.gasLimit)*(config.gasMode==='legacy'?units(config.gasPriceGwei,9):units(config.maxFeeGwei,9));
  const details=await mapLimit(selected,4,async w=>{const [authorized,balance]=await Promise.all([c.isTriggerWallet(w.address),this.pool.read('getBalance',w.address)]);const pending=this.journal.some(r=>(r.chainId??8453)===this.chain.chainId&&OPEN.has(r.status)&&r.from.toLowerCase()===w.address.toLowerCase());const detail={address:w.address,authorized,balance:formatUnits(balance,18),pending,ready:authorized&&balance>=cap&&!pending};this.walletCache.set(w.address.toLowerCase(),detail);return detail;});
  const ready=details.filter(w=>w.ready);if(!ready.length)throw Error('没有可用触发钱包：检查链上授权、原生币余额和未确认交易');
  config.liquidityToken=config.liquidityToken||contract.settings.tokenOut;
  return{config,contract,details,ready,cap,block,observedMonotonic,observedAt};
 }
 async preview(raw){const p=await this.prepare(raw);this.config=p.config;this.persist();return{canStart:true,contract:p.contract,wallets:p.details,selectedWalletCount:p.details.length,authorizedWalletCount:p.details.filter(w=>w.authorized).length,readyWalletCount:p.ready.length,perTransactionGasEth:formatUnits(p.cap,18),maxPendingGasEth:formatUnits(p.cap*BigInt(Math.min(p.config.concurrency,p.ready.length)),18),gasBudgetEth:p.config.gasBudgetEth,mode:p.config.mode,summary:'预览只读取状态，不会签名或发送交易。Gas 金额为执行费用上限，不包含 L1 等额外费用。'};}
 async start(raw){const generation=++this.startGeneration;const p=await this.prepare(raw);if(generation!==this.startGeneration)throw Error('启动已取消');const window=new TaskWindow(p.contract.policy,p.block,{observedMonotonic:p.observedMonotonic,observedAt:p.observedAt});if(window.expired())throw Error('启动准备期间本轮已到期，请重新设置有效期');const config=p.config;this.config=config;const id=crypto.randomUUID();this.run={id,active:true,config,contract:p.contract,epoch:p.contract.triggerEpoch,wallets:p.details.filter(w=>w.authorized).map(w=>w.address),cursor:0,busyWallets:new Set(),busyReserve:0n,preparing:0,operations:new Set(),gate:config.mode==='block'&&BigInt(config.startBlock)===0n,nextAt:Date.now(),nextProbe:0,matched:null,window,chainTime:p.block.timestamp,blockNumber:p.block.number,warningAt:0};
  this.task={id,chainId:this.chain.chainId,status:'armed',mode:config.mode,startedAt:new Date().toISOString(),contractAddress:config.contractAddress,epoch:p.contract.triggerEpoch,reason:'等待触发条件',counters:{attempts:0,submitted:0,confirmed:0,reverted:0,pending:0},executionGasSpentEth:'0',executionGasReservedEth:'0'};this.persist();this.updateTask();this.scheduleExpiry(this.run);
  try{if(config.mode==='listen'){const args={url:config.monitorRpc,feed:config.listenFeed,pool:this.pool,config,onMatch:m=>{const run=this.run;if(!run?.active||run.id!==id||run.matched)return;run.matched=m;run.nextAt=Date.now()+config.delaySeconds*1000;run.gate=true;this.log(m.reason+'，按设定延迟开始触发','info');run.monitor.stop();},onLog:(m,l)=>this.log(m,l),onFatal:e=>this.fail(e)};this.run.monitor=this.monitorFactory?this.monitorFactory(args):new Monitor(args);await this.run.monitor.start();}
   if(!this.run.active)return this.task;this.run.timer=setInterval(()=>this.tick().catch(e=>this.fail(e)),Math.min(50,config.intervalMs,config.probeIntervalMs));this.run.timer.unref?.();await this.tick();return this.task;
  }catch(e){if(this.run?.id===id&&!this.run.active)return this.task;await this.stop('启动失败：'+cleanError(e),'error');throw e;}
 }
 feeFields(run){const c=run.config;let gasPrice=units(c.gasPriceGwei,9),maxFee=units(c.maxFeeGwei,9),tip=units(c.maxPriorityFeeGwei,9);const m=run.matched;if(m&&(m.followGas||units(m.gasPriceGwei||'0',9)>0n)){const tx=m.tx||{};const fixed=units(m.gasPriceGwei||'0',9);const observed=BigInt(tx.maxFeePerGas??tx.gasPrice??0);const observedTip=BigInt(tx.maxPriorityFeePerGas??tx.gasPrice??0);if(c.gasMode==='legacy'){const desired=fixed||observed;if(desired>0n)gasPrice=desired<gasPrice?desired:gasPrice;}else{const desired=fixed||observed;if(desired>0n)maxFee=desired<maxFee?desired:maxFee;tip=fixed||observedTip;if(tip>maxFee)tip=maxFee;}}
  return c.gasMode==='legacy'?{type:0,gasPrice}:{type:2,maxFeePerGas:maxFee,maxPriorityFeePerGas:tip};
 }
 budgetUsed(run){const records=this.journal.filter(r=>r.taskId===run.id);let spent=BigInt(this.task.id===run.id?this.task.archived?.executionFee||0:0),reserved=run.busyReserve,unverified=0n;for(const r of records){if(OPEN.has(r.status)||r.feeUnverified)reserved+=BigInt(r.reserveFee||0);else spent+=BigInt(r.executionFee||0);if(r.feeUnverified)unverified+=BigInt(r.reserveFee||0);}return{spent,reserved,unverified};}
 updateTask(){const run=this.run;if(run){const records=this.journal.filter(r=>r.taskId===run.id),a=this.task.archived||{};this.task.counters={attempts:(a.attempts||0)+records.length,submitted:(a.submitted||0)+records.filter(r=>r.accepted).length,confirmed:(a.confirmed||0)+records.filter(r=>r.status==='confirmed').length,reverted:(a.reverted||0)+records.filter(r=>r.status==='reverted').length,pending:records.filter(r=>OPEN.has(r.status)).length,feesUnverified:records.filter(r=>r.feeUnverified).length};const b=this.budgetUsed(run);this.task.executionGasSpentEth=formatUnits(b.spent,18);this.task.executionGasReservedEth=formatUnits(b.reserved,18);this.task.executionGasUnverifiedEth=formatUnits(b.unverified,18);this.task.nextAt=run.nextAt;Object.assign(this.task,run.window.state());}this.emit({type:'task',task:this.task});}
 async tick(){const run=this.run;if(!run?.active||run.tickBusy)return;run.tickBusy=true;
  try{const c=run.config;const now=Date.now();if(!this.canSend(run))return;if(run.chainTime<run.contract.policy.notBefore)return;
   if(!run.gate){if(c.mode==='block')run.gate=BigInt(run.blockNumber)>=BigInt(c.startBlock);else if(c.mode==='time')run.gate=now>=Date.parse(c.startTime);else if(c.mode==='probe'&&now>=run.nextProbe){run.nextProbe=now+c.probeIntervalMs;const w=run.wallets.find(a=>!this.walletPending(a));if(w){try{await this.pool.read('call',{to:c.contractAddress,from:w,data:this.iface.encodeFunctionData('trigger',[run.epoch]),gasLimit:BigInt(c.gasLimit)});run.gate=true;this.log('当前状态嗅探可执行，开始发送','info');}catch(e){if(now-run.warningAt>10000){this.log('尚不可买入，继续嗅探：'+cleanError(e),'info');run.warningAt=now;}}}}
    if(!run.gate)return;
   }
   if(!this.canSend(run)||now<run.nextAt)return;
   const count=(this.task.archived?.attempts||0)+this.journal.filter(r=>r.taskId===run.id).length;
   if(c.maxAttempts&&count+(run.preparing||0)>=c.maxAttempts){if(count>=c.maxAttempts){if(run.operations.size){this.task.status='stopping';this.task.reason='次数已达，等待已签名请求完成提交';this.updateTask();}else await this.stop('已达到设置的发送次数');}return;}
   const occupied=new Set([...run.busyWallets,...run.wallets.filter(a=>this.walletPending(a))]);if(occupied.size>=c.concurrency)return;
   let wallet;for(let i=0;i<run.wallets.length;i++){const candidate=run.wallets[run.cursor++%run.wallets.length];if(!occupied.has(candidate)){wallet=candidate;break;}}if(!wallet)return;
   const fees=this.feeFields(run);const reserve=BigInt(c.gasLimit)*(fees.gasPrice??fees.maxFeePerGas);const b=this.budgetUsed(run);const budget=units(c.gasBudgetEth);
   if(budget&&b.spent+b.reserved+reserve>budget){if(b.reserved===0n)await this.stop('执行 Gas 预算不足以启动下一笔交易');else{this.task.reason=b.unverified>0n?'已消耗 nonce 的交易费用尚未核实，保留最坏费用预算并等待回执':'等待已提交交易确认并释放预算';this.updateTask();}return;}
   run.busyWallets.add(wallet);run.busyReserve+=reserve;run.preparing=(run.preparing||0)+1;const ticket={reserved:true,preparing:true,reserve};run.nextAt=now+c.intervalMs;this.task.status='running';this.task.reason='多钱包轮换触发';
   const operation=this.sendOne(run,wallet,fees,ticket).catch(e=>{this.log(cleanError(e),'warn');}).finally(()=>{if(ticket.reserved)run.busyReserve-=reserve;if(ticket.preparing)run.preparing--;run.busyWallets.delete(wallet);run.operations.delete(operation);this.emit({type:'wallets',wallets:this.publicWallets()});this.updateTask();});run.operations.add(operation);this.updateTask();
  }finally{run.tickBusy=false;}
 }
 walletPending(address){return this.journal.some(r=>(r.chainId??8453)===this.chain.chainId&&OPEN.has(r.status)&&r.from.toLowerCase()===address.toLowerCase());}
 async sendOne(run,from,fees,ticket){const p=this.pool,c=run.config;const [latest,pending,balance,block]=await Promise.all([p.read('getTransactionCount',from,'latest'),p.read('getTransactionCount',from,'pending'),p.read('getBalance',from),p.read('getBlock','latest')]);run.window.observe(block);run.chainTime=run.window.chainTimestamp;if(!this.canSend(run))return;if(pending!==latest){this.walletCache.set(from.toLowerCase(),{...this.walletCache.get(from.toLowerCase()),error:'该钱包存在其他待确认 nonce，轮换跳过'});return;}if(balance<ticket.reserve){this.walletCache.set(from.toLowerCase(),{...this.walletCache.get(from.toLowerCase()),error:'ETH 不足以覆盖本次 Gas 上限'});return;}if(block.baseFeePerGas!=null&&(fees.gasPrice??fees.maxFeePerGas)<block.baseFeePerGas){if(Date.now()-run.warningAt>5000){this.log('设置的费率上限低于当前网络基础费，暂缓提交','warn');run.warningAt=Date.now();}return;}
  const transaction={chainId:this.chain.chainId,to:c.contractAddress,value:0n,data:this.iface.encodeFunctionData('trigger',[run.epoch]),nonce:pending,gasLimit:BigInt(c.gasLimit),...fees};
  const raw=await this.vault.getSigner(from).signTransaction(transaction);if(!this.canSend(run))return;
  const hash=keccak256(raw);const serializable=Object.fromEntries(Object.entries(transaction).map(([k,v])=>[k,typeof v==='bigint'?String(v):v]));
  const record={hash,chainId:this.chain.chainId,taskId:run.id,epoch:run.epoch,from,to:c.contractAddress,nonce:pending,status:'prepared',accepted:false,reserveFee:String(ticket.reserve),executionFee:'0',createdAt:new Date().toISOString(),tx:serializable};this.journal.push(record);if(ticket.preparing){run.preparing--;ticket.preparing=false;}
  try{this.persist();}catch(e){record.status='notBroadcast';this.fail(Error('无法持久保存交易记录，已停止且没有广播此笔交易'));return;}
  run.busyReserve-=ticket.reserve;ticket.reserved=false;
  try{const response=await p.broadcast(raw,run.cursor%p.providers.length,()=>this.canSend(run));if(response.hash.toLowerCase()!==hash.toLowerCase())throw Error('RPC 返回了不匹配的交易哈希');record.accepted=true;record.rpcAttempts=response.attempts||[];if(OPEN.has(record.status))record.status='pending';}catch(e){record.rpcAttempts=e.attempts||[];if(OPEN.has(record.status)){record.status=e.cancelledBeforeSend===true||e.code==='STOPPED_BEFORE_BROADCAST'&&!record.rpcAttempts.length?'notBroadcast':'unknown';record.error=cleanError(e);}if(record.status==='notBroadcast')this.log('已停止：此笔请求在实际发送前取消，不会占用钱包 nonce','info');else if(OPEN.has(record.status))this.log('发送结果未知，已保留本地计算的哈希；该钱包暂停，其他钱包继续','warn');}
  this.persist();this.emit({type:'journal',journal:this.publicJournal()});
 }
 async poll(){if(this.switchingNetwork||this.pollBusy||!this.pool)return;this.pollBusy=true;try{
  let changed=false;const records=this.journal.filter(r=>(r.chainId??8453)===this.chain.chainId&&(OPEN.has(r.status)||r.feeUnverified));await mapLimit(records,4,async r=>{
   if(r.feeUnverified&&Date.now()<(r.nextReceiptCheckAt||0))return;
   try{const receipt=this.pool.receipt?await this.pool.receipt(r.hash,r):await this.pool.read('getTransactionReceipt',r.hash);if(receipt){
     validateReceipt(receipt,r.hash,r);
     r.accepted=true;r.status=receipt.status===1?(r.replacement?'replaced':'confirmed'):'reverted';r.blockNumber=receipt.blockNumber;
     const measuredFee=receiptFee(receipt,r);const feeKnown=measuredFee!==null;r.feeUnverified=!feeKnown;
     if(feeKnown){r.gasUsed=String(receipt.gasUsed);r.executionFee=String(measuredFee);delete r.error;delete r.lastCheckError;delete r.receiptCheckFailures;delete r.nextReceiptCheckAt;}
     else r.error='已取得区块回执，但 Gas 字段缺失或超出本地签名上限，继续保留最坏费用预算';
     changed=true;if(r.status==='confirmed'&&this.run&&this.run.id===r.taskId)await this.stop('合约买入交易已确认，停止后续提交','completed');
    }else if(OPEN.has(r.status)&&Date.now()-Date.parse(r.createdAt)>15000){const consumed=await this.pool.read('getTransactionCount',r.from,'latest');if(consumed>r.nonce){r.status='superseded';r.feeUnverified=true;r.error='nonce 已消耗但回执尚未找到；继续保留最坏费用预算，不再重发此 nonce';changed=true;}}
   }catch(e){r.lastCheckError=cleanError(e);}
   if(r.feeUnverified){r.receiptCheckFailures=(r.receiptCheckFailures||0)+1;r.nextReceiptCheckAt=Date.now()+Math.min(30000,1000*2**Math.min(r.receiptCheckFailures,5));changed=true;}
   if(OPEN.has(r.status)&&!r.feeUnverified&&r.status!=='prepared'&&this.run?.active&&this.run.id===r.taskId&&Date.now()>=(r.nextRetry||Date.parse(r.createdAt)+5000)){const retryRun=this.run;const operation=this.retryRecord(r,retryRun);retryRun.operations.add(operation);try{await operation;}finally{retryRun.operations.delete(operation);}changed=true;}});
  const run=this.run;if(run?.active){const c=new Contract(run.config.contractAddress,this.artifact.abi,this.pool.primary);const [executed,epoch,block]=await Promise.all([c.executed(),c.triggerEpoch(),this.pool.read('getBlock','latest')]);if(run.active){run.window.observe(block);run.chainTime=run.window.chainTimestamp;run.blockNumber=block.number;if(executed)await this.stop('链上已完成买入，停止后续提交','completed');else if(String(epoch)!==run.epoch)await this.stop('链上本轮已结束或已更换；旧任务停止');else this.canSend(run);}}
  if(changed){this.persist();this.emit({type:'journal',journal:this.publicJournal()});this.emit({type:'wallets',wallets:this.publicWallets()});}this.updateTask();
 }finally{this.pollBusy=false;}}
 async retryRecord(r,run){const pool=this.pool;if(r.retrying||r.feeUnverified||!OPEN.has(r.status)||!this.canSend(run)||!this.vault.has(r.from))return;if(BigInt(r.tx?.chainId??0)!==BigInt(this.chain.chainId)){r.error='重试记录链标识不符，停止签名';await this.stop(r.error,'error');return;}r.retrying=true;try{const raw=await this.vault.getSigner(r.from).signTransaction(r.tx);if(!this.canSend(run))return;if(keccak256(raw).toLowerCase()!==r.hash.toLowerCase())return;const response=await pool.broadcast(raw,run.cursor%pool.providers.length,()=>this.canSend(run));if(OPEN.has(r.status)){r.accepted=true;r.status='pending';}r.rpcAttempts=[...(r.rpcAttempts||[]),...(response.attempts||[])].slice(-20);}catch(e){r.rpcAttempts=[...(r.rpcAttempts||[]),...(e.attempts||[])].slice(-20);if(OPEN.has(r.status))r.error=cleanError(e);}finally{r.retrying=false;r.retries=(r.retries||0)+1;r.nextRetry=Date.now()+Math.min(60000,2000*2**Math.min(r.retries,5));this.persist();}}
 async recover(hash){if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('请填写交易哈希');const tx=await this.requirePool().read('getTransaction',hash);if(!tx)throw Error('节点尚未找到交易');validateRecoveredTransaction(tx,hash,this.chain.chainId);const r=this.journal.find(r=>(r.chainId??8453)===this.chain.chainId&&(OPEN.has(r.status)||r.feeUnverified)&&r.from.toLowerCase()===tx.from.toLowerCase()&&r.nonce===tx.nonce);if(!r)throw Error('交易与待确认的钱包和 nonce 不匹配');r.previousHash=r.hash;r.hash=hash;r.receiptTo=tx.to;r.receiptGasLimit=String(tx.gasLimit);r.receiptFeeCapWei=String(tx.maxFeePerGas??tx.gasPrice);const replacementReserve=tx.gasLimit*(tx.maxFeePerGas??tx.gasPrice);if(replacementReserve>BigInt(r.reserveFee))r.reserveFee=String(replacementReserve);r.replacement=String(tx.to||'').toLowerCase()!==r.to.toLowerCase()||tx.data!==r.tx.data||tx.value!==0n;r.status=r.feeUnverified?'superseded':'pending';r.nextReceiptCheckAt=0;r.accepted=true;this.persist();await this.poll();return this.publicJournal();}
 async stop(reason='用户停止',status='stopped'){this.startGeneration++;const run=this.run;if(run){run.active=false;clearInterval(run.timer);clearTimeout(run.expiryTimer);run.monitor?.stop();}this.task.status=status;this.task.reason=reason;this.task.stoppedAt=new Date().toISOString();this.persist();this.updateTask();return this.task;}
 async diagnose(hash){if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('交易哈希格式无效');const pool=this.requirePool();const nodes=await pool.lookup(hash);const record=this.journal.find(r=>(r.chainId??8453)===this.chain.chainId&&r.hash.toLowerCase()===hash.toLowerCase());return{hash,nodes,rpcAttempts:record?.rpcAttempts||[]};}
 fail(error){this.log(cleanError(error),'error');this.stop(cleanError(error),'error').catch(()=>{});}
 async close(){this.closed=true;this.startGeneration++;try{await this.stop('程序退出，已停止新提交');}finally{clearInterval(this.pollTimer);try{if(this.run)await Promise.allSettled([...this.run.operations]);}finally{try{this.pool?.destroy();}finally{this.vault.lock();}}}}
}
module.exports={Engine,normalize,mapLimit,OPEN};

