const {validateReceipt, validateRecoveredTransaction, receiptFee}=require('./receipt-security.cjs');
const {Contract,ContractFactory,Interface,JsonRpcProvider,FetchRequest,getAddress,getCreateAddress,isAddress,parseUnits,formatUnits,toQuantity,ZeroAddress}=require('ethers');
const CONFIG=require('./config.cjs');
const DEX=require('./dex.cjs');
const CONTRACTS=require('./contract-artifacts.cjs');
const PRICE=require('./price-protection.cjs');
const {LocalWallet}=require('./local-wallet.cjs');
const publicErrors=new WeakSet();
function publicError(message,hash){const e=Error(message+(hash?' 交易哈希：'+hash:''));publicErrors.add(e);return e;}
// Derive CREATE from the locally signed sender/nonce. An RPC receipt is not
// allowed to redirect auto-loading and future deposits to an arbitrary address.
function verifiedCreationAddress(record,receipt) {
  if(record.replacement)return null;
  if(record.to!==null){if(receipt.contractAddress)throw Error('普通或缺少本地部署记录的交易回执不应返回部署地址');return null;}
  const expected=getCreateAddress({from:record.from,nonce:record.nonce});
  if(!receipt.contractAddress||!isAddress(receipt.contractAddress)||getAddress(receipt.contractAddress)!==expected)
    throw Error('部署回执地址与本地签名钱包和 nonce 推导不一致');
  return expected;
}
const TOKEN_ABI=['function symbol() view returns(string)','function name() view returns(string)','function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)'];
const MUTATIONS=new Set(['contract.deploy','contract.save','trade.buy','funds.deposit','funds.withdraw','trigger.wallets','trigger.arm','trigger.disarm']);
const CONTEXT_CHANGES=new Set(['network.select','rpc.connect','wallet.connect','wallet.import','wallet.disconnect','contract.load','contract.read','transaction.refresh','transaction.recover','trigger.read']);
const UNRESOLVED=new Set(['awaitingWallet','pending','unknown']);
const TAX_ERRORS={SellLossLimitExceeded:'试卖实际回款损耗超过卖出上限，整笔交易回滚',TaxSimulationFailed:'本次模拟无法完成，税率未知'};
const ERROR_TEXT={NotOwner:'当前钱包不是合约所有者',Reentrancy:'合约拒绝重入',InvalidConfiguration:'合约依赖配置无效',InvalidSettings:'参数无效，请检查代币、收款地址与比例',InvalidFees:'V3 费率配置无效',NotConfigured:'请先保存链上设置',AlreadyExecuted:'本轮已成功买入；保存新设置后才能再次买入',Expired:'交易或任务已过期，请核对有效期；自动任务需重新开启，过期任务手动补买前先结束本轮',InsufficientInput:'专属合约内发送 Token 余额不足',NoEligiblePool:'没有满足门槛的直接交易池',MinimumNotMet:'实际购入数量低于最低数量',BurnLimitExceeded:'实际到账损耗超过设置上限；请同时核对最小得到、滑点及累计扣税',TokenOperationFailed:'代币转账或授权失败',UnexpectedBalance:'代币余额变化异常',NativeTransferFailed:'原生币取回失败',SellProbeFailed:'测试卖出失败，整笔交易已回滚'};
function amount(value,decimals,label='数量') {
  const s=String(value??'0').trim()||'0';
  if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)||s.length>100)throw Error(label+'必须是非负十进制数字');
  try {const v=parseUnits(s,decimals);if(v>2n**256n-1n)throw Error();return v;}catch {throw Error(label+'精度或数值超出范围');}
}
function percentage(value,label) {const p=amount(value,2,label);if(p>10000n)throw Error(label+'必须在 0–100% 之间');return Number(p);}
function address(value,label='地址') {if(!isAddress(value)||getAddress(value)===ZeroAddress)throw Error(label+'不是有效地址');return getAddress(value);}
function triggerAddresses(value) {
  const values=Array.isArray(value)?value:String(value??'').split(/[\s,;，；]+/).filter(Boolean);
  if(!values.length||values.length>500)throw Error('每批请提供 1–500 个公开钱包地址；不要填写私钥');
  return [...new Set(values.map(v=>address(String(v).trim(),'触发钱包公开地址')))];
}
function runtimeMatches(code,artifact) {
  if(typeof code!=='string'||code.length!==artifact.deployedBytecode.length)return false;
  let a=code.slice(2).toLowerCase().split(''),b=artifact.deployedBytecode.slice(2).toLowerCase().split('');
  for(const refs of Object.values(artifact.immutableReferences||{}))for(const {start,length} of refs)for(let i=start*2;i<(start+length)*2;i++){a[i]='0';b[i]='0';}
  return a.join('')===b.join('');
}
function safeError(e,iface) {
  if(publicErrors.has(e))return e.message;
  let data=e?.data?.data||e?.data||e?.info?.error?.data?.result||e?.info?.error?.data;
  if(typeof data==='string'&&iface){try{const parsed=iface.parseError(data);if(parsed)return TAX_ERRORS[parsed.name]||ERROR_TEXT[parsed.name]||parsed.name;}catch{}}
  let s=e?.shortMessage||e?.reason||e?.message||'操作失败';
  if(/insufficient funds/i.test(s))s='钱包的原生币 不足以支付交易和费用';
  if(/user rejected|denied|ACTION_REJECTED/i.test(s))s='用户取消了钱包操作';
  return String(s).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC 地址已隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [隐藏]').replace(/(?:0x)?[0-9a-fA-F]{64,}/g,'[敏感十六进制数据已隐藏]').slice(0,600);
}
class Engine {
  #localWallet=new LocalWallet();
  constructor({store,confirmTransaction=async()=>false,onEvent=()=>{},openExternal=()=>{},artifact,providerFactory,taxProviderFactory,receiptTimeoutMs=120000,receiptPollMs=1000}={}) {
    this.store=store;this.confirmTransaction=confirmTransaction;this.emit=onEvent;this.openExternal=openExternal;this.closed=false;this.receiptTimeoutMs=receiptTimeoutMs;this.receiptPollMs=receiptPollMs;
    this.artifact=artifact||CONTRACTS.rebuiltArtifact;
    this.iface=new Interface(this.artifact.abi);this.providerFactory=providerFactory;this.taxProviderFactory=taxProviderFactory;this.taxInFlight=false;this.provider=null;this.wallet=null;this.contractAddress=null;this.loadedContract=null;this.busy=false;
    this.rootData=require('./network-state.cjs').migrate(store?.read?.()||{},store,'owner');this.chain=CONFIG.forChain(this.rootData.selectedChainId);this.data=this.rootData.networks[this.chain.chainId]||{};this.contextGeneration=0;this.rpcUrl=this.data.rpcUrl||'';this.transactions=(this.rootData.transactions||[]).map(t=>({...t,chainId:t.chainId??8453,status:t.status==='awaitingWallet'?'unknown':t.status}));
  }
  persist(){const retained=new Set([...this.transactions.slice(-100),...this.transactions.filter(t=>UNRESOLVED.has(t.status)||t.status==='nonceConsumed')]);this.transactions=this.transactions.filter(t=>retained.has(t));this.data={...this.data,rpcUrl:this.rpcUrl};delete this.data.transactions;this.rootData.networks[this.chain.chainId]=this.data;this.rootData.selectedChainId=this.chain.chainId;this.rootData.transactions=this.transactions;this.store?.write?.(this.rootData);}
  persistSubmitted(record){try{this.persist();}catch{throw publicError('本机交易记录保存失败，请检查磁盘空间和写入权限；交易可能已广播，请保留并补登。',record.hash);}}
  log(message,level='info'){this.emit({type:'log',level,message});}
  async invoke(method,args={}) {
    const handlers={
      'network.select':()=>this.selectNetwork(args.chainId,true),'app.info':()=>this.info(),'rpc.connect':()=>this.connectRpc(args.url),
      'wallet.connect':()=>this.connectWallet(),'wallet.import':()=>this.importWallet(args.privateKey),'wallet.disconnect':()=>this.disconnectWallet(),
      'pool.resolve':async()=>{const generation=this.contextGeneration,chain=this.chain;const provider=await this.requireProvider();const result=await require('./v4-pools.cjs').resolve(provider,chain,args,()=>generation!==this.contextGeneration||this.closed);if(generation!==this.contextGeneration||this.closed)throw Error('网络或查询上下文已切换，旧 PoolKey 结果已丢弃');return result;},'token.inspect':()=>this.tokenInfo(args.address),'tax.query':()=>this.queryTax(args),'contract.load':()=>this.loadContract(args.address,{recoveryOnly:args.recoveryOnly===true}),
      'contract.deploy':()=>this.deploy(),'contract.save':()=>this.saveSettings(args.settings),
      'contract.read':()=>this.loadContract(this.contractAddress,{recoveryOnly:this.recoveryOnly===true}),
      'quote.compare':()=>this.quote(args.amountIn),'trade.simulate':()=>this.simulate(args),
      'trade.buy':()=>this.buy(args),'funds.deposit':()=>this.deposit(args),'funds.withdraw':()=>this.withdraw(args),
      'trigger.read':()=>this.readTrigger(args.addresses),'trigger.wallets':()=>this.setTriggerWallets(args),
      'trigger.arm':()=>this.armTrigger(args),'trigger.disarm':()=>this.disarmTrigger(),
      'app.openExternal':()=>this.external(args.url),'transaction.refresh':()=>this.refreshTransactions(),
      'transaction.recover':()=>this.recoverTransaction(args.hash)
    };
    if(!Object.hasOwn(handlers,method))throw Error('不支持的操作');
    if(this.closed)throw Error('程序正在关闭，已停止操作');
    const exclusive=MUTATIONS.has(method)||CONTEXT_CHANGES.has(method);
    if(exclusive&&this.busy)throw Error('已有操作正在处理，请等待结果后再切换钱包、合约或发送交易');
    if(exclusive)this.busy=true;
    const generation=this.contextGeneration;try {const result=await handlers[method]();if(!exclusive&&(this.closed||generation!==this.contextGeneration))throw Error('钱包、RPC、合约或网络已变化，丢弃旧查询结果');return result;}catch(e){const message=safeError(e,this.iface);this.log(message,'error');throw publicError(message);}finally{if(exclusive)this.busy=false;}
  }
  info(){return {version:require('../package.json').version,chainId:this.chain.chainId,network:this.chain.network,addresses:this.chain.addresses,nativeSymbol:this.chain.nativeSymbol,wrappedSymbol:this.chain.wrappedSymbol,explorer:this.chain.explorer,gasMode:this.chain.gasMode,networks:CONFIG.list(),dexes:this.chain.dexes,v4:this.chain.v4,rpcUrl:this.rpcUrl,wallet:this.wallet,contractAddress:this.contractAddress,knownContractAddress:this.wallet&&isAddress(this.data.contracts?.[this.wallet.address.toLowerCase()])?getAddress(this.data.contracts[this.wallet.address.toLowerCase()]):null,settings:this.data.lastSettings||null,transactions:this.transactions};}
  selectNetwork(id,locked=false){
    const next=CONFIG.forChain(id);if(!locked&&this.busy)throw Error('等待正在签名或广播的操作结束后才能切换网络');
    if(next.chainId===this.chain.chainId)return this.info();
    // Publish a new chain only after its selected profile is durably saved.
    // A failed write retains the old provider, funding target and selected chain.
    this.persist();
    const data={...(this.rootData.networks[next.chainId]||{})},rpcUrl=data.rpcUrl||'';
    const root={...this.rootData,selectedChainId:next.chainId,networks:{...this.rootData.networks,[next.chainId]:data}};
    this.store?.write?.(root);
    const previousProvider=this.provider;
    this.rootData=root;this.chain=next;this.data=data;this.rpcUrl=rpcUrl;
    this.contextGeneration++;this.provider=null;this.contractAddress=null;this.recoveryOnly=false;this.loadedContract=null;
    if(this.wallet)this.wallet={...this.wallet,chainId:next.chainId};
    try{previousProvider?.destroy?.();}catch{}
    return this.info();
  }
  async connectRpc(url, implicit=false) {
    const generation=this.contextGeneration,chain=this.chain;
    const u=new URL(String(url||''));
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('请填写 HTTP(S) RPC 地址');
    if(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('远程 RPC 请使用 HTTPS');
    const request=new FetchRequest(u.toString());request.timeout=18000;
    const p=this.providerFactory?this.providerFactory(u.toString()):new JsonRpcProvider(request,undefined,{batchMaxCount:1});
    const start=Date.now();
    try {
      const n=await p.getNetwork();if(Number(n.chainId)!==chain.chainId)throw Error('节点不是所选网络 '+chain.network+' ('+chain.chainId+')');
      const blockNumber=await p.getBlockNumber();
      if(this.closed||generation!==this.contextGeneration||chain!==this.chain)throw Error('程序关闭或连接上下文已变化，丢弃旧 RPC 连接');
      // Explicit replacements invalidate all outstanding queries, including a
      // reconnect to the same URL. An implicit first attachment keeps its context.
      const data={...this.data,rpcUrl:u.toString()};delete data.transactions;
      const root={...this.rootData,selectedChainId:chain.chainId,networks:{...this.rootData.networks,[chain.chainId]:data},transactions:this.transactions};
      this.store?.write?.(root);
      const previousProvider=this.provider;
      this.rootData=root;this.data=data;this.rpcUrl=u.toString();
      if(!implicit)this.contextGeneration++;
      this.provider=p;this.contractAddress=null;this.recoveryOnly=false;this.loadedContract=null;
      try{previousProvider?.destroy?.();}catch{}
      this.log(`${this.chain.network} 节点已连接，区块 ${blockNumber}`);return {chainId:this.chain.chainId,blockNumber,latencyMs:Date.now()-start};
    } catch(e){p.destroy?.();throw e;}
  }
  async requireProvider(){const generation=this.contextGeneration,chain=this.chain;if(!this.provider){if(!this.rpcUrl)throw Error('请先填写并测试当前网络 RPC');await this.connectRpc(this.rpcUrl,true);}const p=this.provider,n=await p.getNetwork();if(this.closed||generation!==this.contextGeneration||chain!==this.chain||p!==this.provider)throw Error('RPC 或查询上下文已变化，丢弃旧连接结果');if(Number(n.chainId)!==chain.chainId)throw Error('RPC 网络已变化，已停止操作');return p;}
  async connectWallet(){throw Error('请在本程序导入管理员私钥，无需连接浏览器钱包');}
  importWallet(privateKey){
    if(this.closed)throw Error('程序正在关闭，不能导入钱包');
    const imported=this.#localWallet.import(privateKey);
    this.contextGeneration++;
    this.wallet={address:imported,chainId:this.chain.chainId};this.contractAddress=null;this.loadedContract=null;
    this.log('管理员钱包已在本机加载：'+imported);return {...this.wallet};
  }
  disconnectWallet(){this.contextGeneration++;this.#localWallet.clear();this.wallet=null;this.contractAddress=null;this.loadedContract=null;return {disconnected:true};}
  async assertWallet(){if(this.closed)throw Error('程序正在关闭，已停止交易');if(!this.wallet||!this.#localWallet.address)throw Error('请先导入管理员钱包私钥');if(this.#localWallet.address!==this.wallet.address)throw Error('管理员钱包状态已变化，请重新导入');return this.wallet.address;}
  queryTax(args){return require('./tax-query.cjs').queryTax(this,args,{address,amount,percentage,runtimeMatches,safeError});}
  async tokenInfo(raw,{walletAddress=this.wallet?.address,contractAddress=this.contractAddress}={}) {
    const p=await this.requireProvider(),a=address(raw,'Token 地址');
    if(await p.getCode(a)==='0x')throw Error('该地址在当前网络没有合约代码');
    const c=new Contract(a,TOKEN_ABI,p);
    const d=Number(await c.decimals());if(!Number.isInteger(d)||d<0||d>77)throw Error('无法使用此 Token 的 decimals，请核对合约');
    const [symbol,name,walletBalance,contractBalance]=await Promise.all([
      c.symbol().catch(()=>a.slice(0,10)),c.name().catch(()=>''),
      walletAddress?c.balanceOf(walletAddress):0n,contractAddress?c.balanceOf(contractAddress):0n
    ]);
    return {address:a,symbol:String(symbol).slice(0,80),name:String(name).slice(0,160),decimals:d,walletBalance:formatUnits(walletBalance,d),contractBalance:formatUnits(contractBalance,d),walletBalanceRaw:String(walletBalance),contractBalanceRaw:String(contractBalance)};
  }
  async validateContract(raw,{recoveryOnly=false}={}){
    const p=await this.requireProvider(),a=address(raw,'专属合约地址'),code=await p.getCode(a);
    const matched=CONTRACTS.identifyExecutor(code,this.artifact);
    if(!matched)throw Error('该地址的运行时代码与支持的执行合约不匹配');
    const c=new Contract(a,matched.artifact.abi,p);
    Object.defineProperty(c,'verifiedVersion',{value:matched.version});
    if(recoveryOnly){
      if(!c.interface.hasFunction('networkChainId')&&this.chain.chainId!==8453)throw Error('旧执行合约仅支持 Base 提款');
      if(c.interface.hasFunction('networkChainId')&&Number(await c.networkChainId())!==this.chain.chainId)throw Error('提款执行器链标识不符');
      if(getAddress(await c.wrappedNative())!==getAddress(this.chain.addresses.weth))throw Error('提款执行器包装币配置不符');
    }else await DEX.validateDependencies(c,p,matched.helpers,{},this.chain);
    return c;
  }
  commitContractContext(a,{settings,isOwner,recoveryOnly=false}={}) {
    const previousData=this.data,previousTransactions=this.transactions;
    this.data={...this.data,...(settings?{lastSettings:settings}:{}),...(isOwner?{contracts:{...(this.data.contracts||{}),[this.wallet.address.toLowerCase()]:a}}:{})};
    try{if(isOwner)this.persist();}catch(e){
      this.data=previousData;this.transactions=previousTransactions;
      this.rootData.networks[this.chain.chainId]=previousData;
      throw e;
    }
    // The funding target and its mode change only after every mandatory read
    // and required local persistence succeeded. Failed loads retain the old UI target.
    this.contextGeneration++;this.contractAddress=a;this.recoveryOnly=recoveryOnly;
  }
  async loadRecoveryContract(raw) {
    const generation=this.contextGeneration;
    const c=await this.validateContract(raw,{recoveryOnly:true}),a=await c.getAddress(),owner=getAddress(await c.owner());
    if(!this.wallet||owner!==this.wallet.address)throw Error('当前钱包不是该合约的所有者，不能加载提款模式');
    if(this.closed||generation!==this.contextGeneration)throw Error('提款加载上下文已变化，丢弃旧结果');
    // No settings, metadata, task or quote-helper reads gate recovery loading.
    const result={address:a,contractVersion:c.verifiedVersion,owner,isOwner:true,recoveryOnly:true,executed:null,settings:null,settingsReadable:false,rawSettings:null,balanceIn:null,funds:null,trigger:null,metadataWarnings:['仅加载用于提款。未读取交易依赖或任务状态；正常交易需要重新完整加载合约。']};
    this.commitContractContext(a,{isOwner:true,recoveryOnly:true});
    return this.loadedContract=result;
  }
  async loadContract(raw,{recoveryOnly=false}={}) {
    if(recoveryOnly)return this.loadRecoveryContract(raw);
    const generation=this.contextGeneration;
    const c=await this.validateContract(raw);const a=await c.getAddress();const [owner,executed,s]=await Promise.all([c.owner(),c.executed(),c.getSettings()]);
    if(this.closed||generation!==this.contextGeneration)throw Error('合约读取上下文已变化，丢弃旧结果');
    let settings=null,balanceIn=null;const metadataWarnings=[];
    const v3Fees=[];
    const dexPolicy=await DEX.policy(c);
    const maxSellLossPercent=formatUnits(await c.maxSellLossBps(),2);
    const rawSettings={tokenIn:s.tokenIn,tokenOut:s.tokenOut,recipient:s.recipient,minPoolInputRaw:'0',minBuyAmountRaw:String(s.minBuyAmount),allowV2:false,checkBurn:s.checkBurn,maxBurnPercent:formatUnits(s.maxBurnBps,2),testSell:s.testSell,testSellPercent:formatUnits(s.testSellBps,2),v3Fees};
    Object.assign(rawSettings,dexPolicy); rawSettings.maxSellLossPercent=maxSellLossPercent;
    if(s.tokenIn!==ZeroAddress){
      const results=await Promise.allSettled([this.tokenInfo(s.tokenIn,{contractAddress:a}),this.tokenInfo(s.tokenOut,{contractAddress:a})]);
      results.forEach((r,i)=>{if(r.status==='rejected')metadataWarnings.push(`${i===0?'支付':'获得'}代币信息读取失败：${safeError(r.reason,this.iface)}。仍可独立提款。`);});
      if(results.every(r=>r.status==='fulfilled')){const [input,output]=results.map(r=>r.value);settings={...this.humanSettings(s,input.decimals,output.decimals),v3Fees,maxSellLossPercent,...dexPolicy};balanceIn=input.contractBalance;}
    }
    const isOwner=!!this.wallet&&getAddress(owner)===this.wallet.address;
    // Token metadata is untrusted. It must never gate the owner's recovery entry point.
    const balances=await Promise.allSettled([this.provider.getBalance(a),new Contract(this.chain.addresses.weth,TOKEN_ABI,this.provider).balanceOf(a)]);
    const funds={native:null,nativeRaw:null,weth:null,wethRaw:null};
    balances.forEach((r,i)=>{const key=i===0?'native':'weth';if(r.status==='fulfilled'){funds[key]=formatUnits(r.value,18);funds[key+'Raw']=String(r.value);}else metadataWarnings.push(`${i===0?this.chain.nativeSymbol:this.chain.wrappedSymbol}余额暂未读到；提款权限不受影响。`);});
    let trigger=null;try{trigger=await this.readTrigger(undefined,c,a);}catch(e){metadataWarnings.push('任务状态暂未读到：'+safeError(e,this.iface));}
    // Commit the address/settings together. A failed policy read or a late
    // shutdown must not redirect the next deposit/withdrawal to a partial load.
    if(this.closed||generation!==this.contextGeneration)throw Error('合约读取上下文已变化，丢弃旧结果');
    this.commitContractContext(a,{settings,isOwner});
    return this.loadedContract={address:a,contractVersion:c.verifiedVersion,owner,isOwner,executed,settings,settingsReadable:!!settings,rawSettings,balanceIn,funds,metadataWarnings,trigger,...dexPolicy};
  }
  humanSettings(s,di,do_){return {tokenIn:s.tokenIn,tokenOut:s.tokenOut,recipient:s.recipient,minBuyAmount:formatUnits(s.minBuyAmount,do_),priceProtectionMode:Number(s.priceMode)===1?'minimum':'slippage',allowV2:false,checkBurn:s.checkBurn,maxBurnPercent:formatUnits(s.maxBurnBps,2),testSell:s.testSell,testSellPercent:formatUnits(s.testSellBps,2)};}
  async ownedContract({recoveryOnly=false}={}){if(this.recoveryOnly&&!recoveryOnly)throw Error('当前仅加载用于提款；请完整加载合约后再进行交易或设置操作');if(!this.contractAddress)throw Error('请先加载或部署专属合约');const c=await this.validateContract(this.contractAddress,{recoveryOnly});if(!this.wallet||getAddress(await c.owner())!==this.wallet.address)throw Error('当前钱包不是该合约的所有者');return c;}
  async confirmedRead(result,read,fallback={}) {
    if(result.status!=='confirmed')return result;
    try{return {...result,...await read()};}
    catch(e){
      // A failed follow-up read or local cache write cannot undo a verified receipt.
      // Preserve its hash/status, invalidate cached settings, and require a fresh read.
      const refreshWarning='交易已确认，但后续状态读取或保存失败；不要重复提交，请核对交易记录并重新读取。 '+safeError(e,this.iface);
      if(this.loadedContract)this.loadedContract={...this.loadedContract,settings:null,settingsReadable:false,trigger:null};
      this.emit({type:'settings-stale',level:'warning',message:refreshWarning});
      return {...result,...fallback,refreshWarning};
    }
  }
  async deploy() {
    const p=await this.requireProvider(),owner=await this.assertWallet();
    await Promise.all([this.chain.addresses.weth,...this.chain.v4.config].filter(a=>a!==ZeroAddress).map(async a=>{if(await p.getCode(a)==='0x')throw Error('当前 RPC 未返回 V4 官方依赖代码');}));
    const factory=new ContractFactory(this.artifact.abi,this.artifact.bytecode);
    const tx=await factory.getDeployTransaction(owner);
    const result=await this.sendTransaction(tx,'部署 '+this.chain.network+' V4 专用执行器及非托管报价辅助合约');
    if(result.status!=='confirmed'||!result.receipt?.contractAddress) return {...result,address:null};
    return this.confirmedRead(result,()=>this.loadContract(result.receipt.contractAddress),{address:null,createdContractAddress:result.receipt.contractAddress});
  }
  async saveSettings(s) {
    if(!s||typeof s!=='object')throw Error('缺少设置');const c=await this.ownedContract();
    const [input,output]=await Promise.all([this.tokenInfo(s.tokenIn),this.tokenInfo(s.tokenOut)]);
    if(input.address===output.address)throw Error('发送与获得 Token 不能相同');
    const recipient=address(s.recipient,'买入地址');if(recipient===this.contractAddress)throw Error('买入地址不能是执行合约自身');
    const next={tokenIn:input.address,tokenOut:output.address,recipient,minBuyAmount:amount(s.minBuyAmount,output.decimals,'最小购入数量'),allowV2:false===true,checkBurn:s.checkBurn===true,maxBurnBps:percentage(s.maxBurnPercent??50,'买入及转发损耗上限'),testSell:s.testSell===true,testSellBps:percentage(s.testSellPercent??1,'测试卖出比例')};
    const priceMode=PRICE.mode(s.priceProtectionMode,next.minBuyAmount>0n);next.priceMode=priceMode==='minimum'?1:0;
    if(priceMode==='slippage')next.minBuyAmount=0n;
    else if(next.minBuyAmount===0n)throw Error('最小得到模式要求数量大于 0');
    if((next.testSell||next.checkBurn)&&!next.testSellBps)throw Error('开启高税拦截或试卖时，试卖比例必须大于 0');
    const sellLossBps=percentage(s.maxSellLossPercent??10,'卖出损耗上限');
    const selected=DEX.venue(s.dex??0);
    const lockId=s.lockedPoolId||require('ethers').ZeroHash;
    const pools=require('./v4-pools.cjs').list(s.v4Pools||[],this.chain,{tokenIn:next.tokenIn,tokenOut:next.tokenOut,dex:selected},lockId);
    if(!pools.length)throw Error('请保存至少一个 V4 候选池');
    const tx=await c.setSettingsAndV4.populateTransaction(next,sellLossBps,selected,pools,lockId);
    const r=await this.sendTransaction(tx,`保存 V4 设置：${priceMode==='minimum'?'仅最小得到 '+s.minBuyAmount:'仅滑点'}；支付币 ${input.address}；获得币 ${output.address}；收款 ${recipient}；交易所 ${selected===0?'Uniswap V4':'Infinity'}；候选 ${pools.length} 个；锁定 ${lockId}；高税拦截 ${next.checkBurn?'开启':'关闭'}；结束旧任务并重置本轮`);
    return this.confirmedRead(r,()=>this.loadContract(this.contractAddress));
  }
  async quote(inputAmount='0') {
    const c=await this.ownedContract(),s=await c.getSettings();if(s.tokenIn===ZeroAddress)throw Error('请先保存链上设置');
    const [input,output]=await Promise.all([this.tokenInfo(s.tokenIn),this.tokenInfo(s.tokenOut)]);
    let n=amount(inputAmount,input.decimals,'购买金额');if(n===0n)n=BigInt(input.contractBalanceRaw);if(!n)throw Error('合约尚无发送 Token；请先充值或填写用于比较的数量');
    const [best,candidates]=await c.quoteBest.staticCall(n,{from:this.wallet.address,gasLimit:12000000n});
    const fmt=r=>({...DEX.route(r),amountOut:String(r.amountOut),amountOutFormatted:formatUnits(r.amountOut,output.decimals),poolInput:String(r.poolInput),poolInputFormatted:formatUnits(r.poolInput,input.decimals),eligible:r.amountOut>0n,error:r.amountOut>0n?undefined:Number(r.kind)>=10?'V4 池无有效报价、未初始化或未被锁定选择':r.pool===ZeroAddress?'没有直接池':'池子门槛未满足或报价失败'});
    return {amountIn:String(n),amountInFormatted:formatUnits(n,input.decimals),tokenIn:input,tokenOut:output,best:fmt(best),candidates:candidates.map(fmt),blockNumber:await this.provider.getBlockNumber(),settings:{...this.humanSettings(s,input.decimals,output.decimals),...await DEX.policy(c)}};
  }
  async buildBuy(args) {
    const c=await this.ownedContract();if(await c.executed())throw Error(ERROR_TEXT.AlreadyExecuted);
    // Bind before reading token metadata/quotes, so a concurrent settings update cannot attach an old quote to its new epoch.
    const epoch=await c.triggerEpoch();
    const saved=await c.getSettings(),priceMode=PRICE.executionMode(args.priceProtectionMode,saved.minBuyAmount);
    const q=await this.quote(args.amountIn);if(!q.best.eligible)throw Error(ERROR_TEXT.NoEligiblePool);
    const bps=priceMode==='minimum'?10000:PRICE.quoteBps(args.slippageBps??100);
    const rawMinimum=BigInt(q.best.amountOut)*BigInt(10000-bps)/10000n;const minOut=priceMode==='minimum'?0n:rawMinimum||1n;
    const block=await this.provider.getBlock('latest');const deadline=BigInt(block.timestamp+180);
    const tx=await c.buy.populateTransaction(BigInt(q.amountIn),minOut,deadline,epoch);
    return {c,q,minOut,minimum:priceMode==='minimum'?BigInt(saved.minBuyAmount):minOut,deadline,epoch,tx};
  }
  async simulate(args) {
    const {c,q,minOut,deadline,epoch,tx}=await this.buildBuy(args);
    const results=await c.buy.staticCall(BigInt(q.amountIn),minOut,deadline,epoch,{from:this.wallet.address,gasLimit:12000000n});
    const gas=await this.provider.estimateGas({...tx,from:this.wallet.address});
    return {success:true,estimatedGas:String(gas),quote:q,bought:formatUnits(results[0],q.tokenOut.decimals),received:formatUnits(results[1],q.tokenOut.decimals),testInputRecovered:formatUnits(results[2],q.tokenIn.decimals),summary:`模拟通过：预计购入 ${formatUnits(results[0],q.tokenOut.decimals)} ${q.tokenOut.symbol}，收款地址预计收到 ${formatUnits(results[1],q.tokenOut.decimals)}。仅代表当前区块模拟结果。`};
  }
  async buy(args) {
    const {c,q,minOut,minimum,deadline,epoch,tx}=await this.buildBuy(args);
    await c.buy.staticCall(BigInt(q.amountIn),minOut,deadline,epoch,{from:this.wallet.address,gasLimit:12000000n});
    const r=await this.sendTransaction(tx,`买入：花费 ${q.amountInFormatted} ${q.tokenIn.symbol}；自动选择所选交易所内的池子；最低购入 ${formatUnits(minimum,q.tokenOut.decimals)} ${q.tokenOut.symbol}（试卖前，仅一种价格保护）`);
    return this.confirmedRead(r,()=>this.loadContract(this.contractAddress));
  }
  async deposit({amount:raw,asset='ETH'}) {
    const c=await this.ownedContract();const target=await c.getAddress();let tx,summary,creditedToken;
    if(['ETH','BNB','NATIVE'].includes(asset)){creditedToken=this.chain.addresses.weth;const n=amount(raw,18,'充值数量');if(!n)throw Error('充值数量必须大于 0');tx=await c.depositNative.populateTransaction({value:n});summary=`充值 ${formatUnits(n,18)} ${this.chain.nativeSymbol}，并在合约内包装成 ${this.chain.wrappedSymbol}`;}
    else {const s=await c.getSettings();creditedToken=s.tokenIn;if(s.tokenIn===ZeroAddress)throw Error('Token 充值前请先保存设置');const info=await this.tokenInfo(s.tokenIn),n=amount(raw,info.decimals,'充值数量');if(!n)throw Error('充值数量必须大于 0');if(n>BigInt(info.walletBalanceRaw))throw Error('钱包 Token 余额不足');tx=await new Contract(info.address,TOKEN_ABI,this.provider).transfer.populateTransaction(target,n);summary=`向专属合约 ${target} 转入 ${formatUnits(n,info.decimals)} ${info.symbol}`;}
    const token=new Contract(creditedToken,TOKEN_ABI,this.provider);let before=null;
    try{before=await token.balanceOf(target);}catch{}
    const result=await this.sendTransaction(tx,summary);if(result.status!=='confirmed')return result;
    const verification={status:'unverified',receivedRaw:null,token:creditedToken,target,message:'充值交易已确认，但尚未核实执行合约实际到账；请核对合约余额，不要直接重复充值。'};
    if(before!==null)try{const delta=await token.balanceOf(target)-before;verification.receivedRaw=String(delta);verification.status=delta>0n?'observed':'no-increase';verification.message=delta>0n?`充值交易已确认，执行合约余额增加 ${delta} 最小单位；可能包含同期其他转账。`:'充值交易已确认，但未观察到执行合约余额增加；请检查代币扣税、虚假返回成功或同期交易，避免直接重复充值。';}catch{}
    if(verification.status!=='observed')this.log(verification.message,'warn');return{...result,depositVerification:verification};
  }
  async withdraw({token,address:to,rawAmount='0'}) {
    const c=await this.ownedContract({recoveryOnly:true});const recipient=to?address(to,'取回地址'):this.wallet.address;
    if(recipient===getAddress(this.contractAddress))throw Error('取回地址不能是执行合约自身');
    const n=amount(rawAmount,0,'提款原始数量');
    const native=['ETH','BNB','NATIVE'].includes(String(token).toUpperCase())||token===ZeroAddress;
    const a=native?ZeroAddress:address(token,'取回 Token 地址');
    const tokenContract=native?null:new Contract(a,TOKEN_ABI,this.provider);
    // Recovery deliberately avoids decimals/symbol and permits explicit amounts when balanceOf is broken.
    let before=null;if(tokenContract)try{before=await tokenContract.balanceOf(recipient);}catch{}
    const tx=native?await c.withdrawNative.populateTransaction(recipient,n):await c.withdrawToken.populateTransaction(a,recipient,n);
    const result=await this.sendTransaction(tx,`将合约内${n===0n?'全部':String(n)+' 最小单位'}${native?' '+this.chain.nativeSymbol:'指定 Token'}取回到 ${recipient}`);
    if(result.status!=='confirmed')return result;
    const verification={status:'unverified',receivedRaw:null,token:a,recipient,message:'提款交易已确认，尚未核实目标钱包实际到账。'};
    if(native){verification.status='observed';verification.message=`${this.chain.nativeSymbol} 提款调用已在链上成功；钱包净余额还会受交易费用影响。`;}
    else if(before!==null){try{const after=await tokenContract.balanceOf(recipient),delta=after-before;verification.receivedRaw=String(delta);verification.status=delta>0n?'observed':'no-increase';verification.message=delta>0n?`提款交易已确认，收款地址余额增加 ${delta} 最小单位。此为前后余额观察，可能包含同期其他转账。`:'提款交易已确认，但未观察到收款地址余额增加。该代币可能扣税、冻结或虚假返回成功，请勿将回执成功视为已到账。';}catch{}}
    if(verification.status!=='observed')this.log(verification.message,'warn');
    return {...result,withdrawalVerification:verification};
  }
  async readTrigger(rawAddresses,c,target=this.contractAddress) {
    if(!target)throw Error('请先加载或部署专属合约');
    c=c||await this.validateContract(target);
    const [policy,armed,epoch,executed,s,block]=await Promise.all([c.getTriggerPolicy(),c.triggerArmed(),c.triggerEpoch(),c.executed(),c.getSettings(),this.provider.getBlock('latest')]);
    let decimals=null;
    if(s.tokenIn!==ZeroAddress)try{const d=Number(await new Contract(s.tokenIn,TOKEN_ABI,this.provider).decimals());if(Number.isInteger(d)&&d>=0&&d<=77)decimals=d;}catch{}
    const known=this.data.triggerWallets?.[target.toLowerCase()]||[];
    const addresses=rawAddresses===undefined?known:triggerAddresses(rawAddresses);
    const wallets=[];
    for(let offset=0;offset<addresses.length;offset+=10){const chunk=addresses.slice(offset,offset+10);const flags=await Promise.all(chunk.map(a=>c.isTriggerWallet(a)));wallets.push(...chunk.map((a,i)=>({address:a,allowed:flags[i]})));}
    const hasMinimum=s.minBuyAmount>0n,hasQuote=policy.slippageBps<10000n;
    return {armed,epoch:String(epoch),executed,amountIn:decimals===null?null:formatUnits(policy.amountIn,decimals),amountInRaw:String(policy.amountIn),decimals,slippagePercent:formatUnits(policy.slippageBps,2),priceProtectionMode:hasMinimum?(hasQuote?'combined':'minimum'):(hasQuote?'slippage':'none'),notBefore:Number(policy.notBefore),expiresAt:Number(policy.expiresAt),blockTimestamp:block.timestamp,wallets};
  }
  async setTriggerWallets({addresses,allowed}) {
    if(typeof allowed!=='boolean')throw Error('请选择授权或撤销授权');
    const c=await this.ownedContract(),wallets=triggerAddresses(addresses);
    const r=await this.sendTransaction(await c.setTriggerWallets.populateTransaction(wallets,allowed),`${allowed?'授权':'撤销'} ${wallets.length} 个触发钱包；新版会结束旧任务，确认后需重新开启本轮`);
    return this.confirmedRead(r,async()=>{
      const key=this.contractAddress.toLowerCase(),previous=this.data.triggerWallets?.[key]||[];
      const known=[...new Set([...previous,...wallets])].slice(-500);
      this.data.triggerWallets={...(this.data.triggerWallets||{}),[key]:known};this.persist();
      return {trigger:await this.readTrigger(wallets,c)};
    });
  }
  async armTrigger(args) {
    const c=await this.ownedContract(),s=await c.getSettings();
    if(s.tokenIn===ZeroAddress)throw Error('请先保存链上设置');
    if(await c.executed())throw Error(ERROR_TEXT.AlreadyExecuted);
    const priceMode=PRICE.executionMode(args.priceProtectionMode,s.minBuyAmount);
    const info=await this.tokenInfo(s.tokenIn),n=amount(args.amountIn,info.decimals,'触发购买金额'),bps=priceMode==='minimum'?10000:PRICE.quoteBps(percentage(args.slippagePercent??1,'触发滑点'));
    const minutes=args.durationMinutes===undefined?15:Number(args.durationMinutes);
    if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('自动到期时长必须为 1–1440 分钟的整数');
    const block=await this.provider.getBlock('latest'),start=0,end=Number(block.timestamp)+minutes*60;
    const r=await this.sendTransaction(await c.armTrigger.populateTransaction(n,bps,start,end),`开启本轮自动任务：支付 ${n===0n?'合约全部余额':formatUnits(n,info.decimals)} ${info.symbol}，${priceMode==='minimum'?'仅最小得到，滑点下限关闭':'仅自动滑点 '+formatUnits(bps,2)+'%，固定最低数量关闭'}，链上截止 ${new Date(end*1000).toLocaleString()}；从准备时的链上时间计时，确认等待会占用有效期`,{expiresAt:end});
    return this.confirmedRead(r,async()=>({trigger:await this.readTrigger(undefined,c)}));
  }
  async disarmTrigger() {
    const c=await this.ownedContract({recoveryOnly:true}),r=await this.sendTransaction(await c.disarmTrigger.populateTransaction(),'撤销武装并使旧任务的触发交易失效');
    return this.confirmedRead(r,async()=>({trigger:await this.readTrigger(undefined,c)}));
  }
  async sendTransaction(tx,summary,{expiresAt}={}) {
    const p=await this.requireProvider(),from=await this.assertWallet();
    if(this.transactions.some(t=>(t.chainId??8453)===this.chain.chainId&&UNRESOLVED.has(t.status)&&t.from?.toLowerCase()===from.toLowerCase()))throw Error('此钱包有待确认或结果未知的交易。请先刷新记录或补登哈希，确认结果后再继续。');
    const gas=await p.estimateGas({...tx,from});
    const fees=await p.getFeeData(),gasLimit=gas*120n/100n+10000n;
    if(gasLimit>16000000n)throw Error('预估 Gas 过高，暂不发送');
    const nonce=await p.getTransactionCount(from,'pending');
    if(!Number.isSafeInteger(nonce)||nonce<0)throw Error('节点返回了无效 nonce，未发送交易');
    const request={chainId:this.chain.chainId,nonce,data:tx.data||'0x',value:BigInt(tx.value||0n),gasLimit};
    if(tx.to)request.to=getAddress(tx.to);
    let feeCap;
    if(this.chain.gasMode!=='legacy'&&fees.maxFeePerGas!=null){
      request.type=2;request.maxFeePerGas=BigInt(fees.maxFeePerGas);request.maxPriorityFeePerGas=BigInt(fees.maxPriorityFeePerGas||0n);
      if(request.maxPriorityFeePerGas<0n||request.maxPriorityFeePerGas>request.maxFeePerGas)throw Error('节点返回了无效 Gas 费率，未发送交易');
      feeCap=request.maxFeePerGas;
    }else if(fees.gasPrice!=null){request.type=0;request.gasPrice=BigInt(fees.gasPrice);feeCap=request.gasPrice;}
    else throw Error('无法读取 Gas 费率，未发送交易');
    if(feeCap<=0n||request.value<0n)throw Error('节点返回了无效 Gas 费率或金额，未发送交易');
    const maximumExecutionFee=gasLimit*feeCap;
    if(await p.getBalance(from,'pending')<request.value+maximumExecutionFee)throw Error('钱包的原生币 不足以支付交易和 Gas 上限');
    const details={chainId:this.chain.chainId,network:this.chain.network,nativeSymbol:this.chain.nativeSymbol,from,to:request.to||null,valueWei:String(request.value),valueEth:formatUnits(request.value,18),summary:String(summary).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,600),nonce,gasLimit:String(gasLimit),feeCapWei:String(feeCap),feeCapGwei:formatUnits(feeCap,9),maximumExecutionFeeWei:String(maximumExecutionFee),maximumExecutionFeeEth:formatUnits(maximumExecutionFee,18),additionalFeeNotice:this.chain.chainId===8453?'以上为执行 Gas 上限；Base 的 L1 等额外费用以回执为准。':'以上为交易 Gas 费用上限，实际费用以回执为准。'};
    this.emit({type:'status',message:'请在本机确认交易：'+details.summary});
    if(await this.confirmTransaction(details)!==true)throw Error('已取消本机交易确认，未签名或广播');
    // A user can wait in the native confirmation dialog. Revalidate the context and
    // simulation before signing so a stale approval cannot send from a changed wallet.
    if(await this.assertWallet()!==from)throw Error('管理员钱包已变化，未发送交易');
    await this.requireProvider();
    if(typeof p.send==='function'&&BigInt(await p.send('eth_chainId',[]))!==BigInt(this.chain.chainId))throw Error('RPC 网络已变化，已停止操作');
    if(expiresAt!==undefined&&Number((await p.getBlock('latest')).timestamp)>=expiresAt)throw Error('本轮有效期已在确认期间结束，未发送交易；请重新开启本轮');
    if(await p.getTransactionCount(from,'pending')!==nonce)throw Error('钱包 nonce 已变化，未发送交易；请刷新记录后重试');
    if(await p.estimateGas({...tx,from})>gasLimit)throw Error('确认期间所需 Gas 已超过确认上限，未发送交易；请重试');
    if(await p.getBalance(from,'pending')<request.value+maximumExecutionFee)throw Error('确认期间钱包原生币余额不足，未发送交易');
    const {raw,hash}=await this.#localWallet.sign(request);
    if(this.closed)throw Error('程序正在关闭，未广播交易');
    const record={hash,chainId:this.chain.chainId,summary:details.summary,status:'unknown',createdAt:new Date().toISOString(),from,to:request.to||null,nonce,data:request.data,value:toQuantity(request.value),gasLimit:String(gasLimit),feeCapWei:String(feeCap)};
    this.transactions.push(record);
    // Durably publish the deterministic hash BEFORE handing signed bytes to an RPC.
    // An interrupted request can then be recovered without sending a fresh nonce.
    try{this.persist();}catch{record.status='notBroadcast';throw Error('本机交易记录保存失败，已停止广播；请检查磁盘空间和写入权限');}
    try{
      const response=await p.broadcastTransaction(raw);
      if(!response?.hash||response.hash.toLowerCase()!==hash.toLowerCase())throw Error('invalid broadcast response');
    }catch{
      this.persistSubmitted(record);
      this.emit({type:'transaction',txHash:hash,message:'广播结果未知，已保留本地交易哈希；请刷新查询，不要重复提交',level:'warn'});
      return {txHash:hash,status:'unknown'};
    }
    record.status='pending';this.persistSubmitted(record);
    this.emit({type:'transaction',txHash:hash,message:'交易已提交，等待链上回执',level:'info'});
    let receipt;
    try{receipt=await require('./wait-confirmation.cjs').waitReceipt(p,hash,{timeoutMs:this.receiptTimeoutMs,pollMs:this.receiptPollMs,stopped:()=>this.closed});}catch{record.status='pending';this.persistSubmitted(record);this.log('交易仍待确认，请在区块浏览器检查；不要重复提交。','warn');return {txHash:hash,status:'pending'};}
    if(!receipt)return {txHash:hash,status:'pending'};
    try{validateReceipt(receipt,hash,record);}catch{record.status='unknown';record.resultUnverified=true;record.verificationError='节点回执与本机交易记录不匹配';this.persistSubmitted(record);this.log('节点回执异常，保留钱包发送锁；请换可信 RPC 核对本地哈希。','warn');return {txHash:hash,status:'unknown'};}
    let created=null;
    if(receipt.status===1){try{created=verifiedCreationAddress(record,receipt);}catch{
      record.status='unknown';record.resultUnverified=true;record.verificationError='节点部署回执未通过本地地址核对';this.persistSubmitted(record);
      this.log('节点部署回执地址异常，已停止自动加载和充值引导；请换可信 RPC 核对本地交易哈希。','warn');
      return {txHash:hash,status:'unknown'};
    }}
    record.status=receipt.status===1?'confirmed':'reverted';if(created)record.contractAddress=created;
    let refreshWarning;
    try{this.persistSubmitted(record);}catch{
      refreshWarning='链上回执已核实，但本机回执保存失败；请保留交易哈希、修复写入权限后刷新记录，不要重复提交。';
      this.log(refreshWarning,'warn');
    }
    if(receipt.status!==1)throw publicError('交易已在链上回滚。',hash);
    this.emit({type:'transaction',txHash:hash,message:'交易已确认',level:'success'});
    return {txHash:hash,status:'confirmed',...(refreshWarning?{refreshWarning}:{}),receipt:{status:receipt.status,contractAddress:created,blockNumber:receipt.blockNumber,gasUsed:String(receipt.gasUsed)}};
  }
  async recoverTransaction(hash){if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('请填写完整交易哈希');const p=await this.requireProvider();const tx=await p.getTransaction(hash);if(!tx)throw Error('当前网络 RPC 尚未找到此交易');validateRecoveredTransaction(tx,hash,this.chain.chainId);const r=this.transactions.find(t=>(t.chainId??8453)===this.chain.chainId&&(UNRESOLVED.has(t.status)||t.status==='nonceConsumed')&&t.from?.toLowerCase()===tx.from.toLowerCase()&&Number(t.nonce)===tx.nonce);if(!r)throw Error('交易的发送钱包和 nonce 与待确认记录不匹配');r.previousHash=r.hash;r.hash=hash;r.receiptTo=tx.to;r.status='pending';r.replacement=String(tx.to||'').toLowerCase()!==String(r.to||'').toLowerCase()||tx.data!==r.data||tx.value!==BigInt(r.value);this.persist();return this.refreshTransactions();}
  async refreshTransactions(){
    const p=await this.requireProvider(),nonces=new Map();
    for(const r of this.transactions.filter(t=>(t.chainId??8453)===this.chain.chainId&&(UNRESOLVED.has(t.status)||t.status==='nonceConsumed'))){
      let receipt=null;if(r.hash)try{receipt=await p.getTransactionReceipt(r.hash);}catch{}
      if(receipt){
        try{validateReceipt(receipt,r.hash,r);}catch{r.status='unknown';r.resultUnverified=true;r.verificationError='节点回执与本机交易记录不匹配';continue;}
        let created=null;
        if(receipt.status===1){try{created=verifiedCreationAddress(r,receipt);}catch{
          r.status='unknown';r.resultUnverified=true;r.verificationError='节点部署回执未通过本地地址核对';delete r.contractAddress;
          this.log('回执中的部署地址与本机签名记录不一致，未自动加载该地址。','warn');continue;
        }}
        r.status=receipt.status===1?(r.replacement?'replaced':'confirmed'):'reverted';
        // A receipt updates the journal, never the current funding target.
        if(created)r.contractAddress=created;
        continue;
      }
      // A missing hash/receipt is not failure. Only a mined nonce proves this nonce cannot execute again.
      if(!isAddress(r.from)||!Number.isSafeInteger(r.nonce)||r.nonce<0)continue;
      try{
        const key=r.from.toLowerCase();if(!nonces.has(key))nonces.set(key,await p.getTransactionCount(r.from,'latest'));
        if(nonces.get(key)>r.nonce){r.status='nonceConsumed';r.nonceObservedAt=new Date().toISOString();r.resultUnverified=true;}
        else if(r.status==='nonceConsumed'){r.status='unknown';r.resultUnverified=true;}
      }catch{}
    }
    this.persist();return this.transactions;
  }
  external(url){const u=new URL(url);if(u.protocol!=='https:'||!['basescan.org','etherscan.io','bscscan.com','docs.uniswap.org','developers.uniswap.org'].includes(u.hostname))throw Error('不支持此外部链接');return this.openExternal(u.toString());}
  beginShutdown(){this.closed=true;this.disconnectWallet();}
  async close(){this.beginShutdown();this.provider?.destroy?.();}
}
Object.assign(ERROR_TEXT,{V4SwapFailed:'V4 / Infinity 兑换或结算失败；可能不兼容该代币的扣税／转账行为，整笔交易回滚',SwapFailed:'兑换调用失败，整笔交易回滚',NotTriggerWallet:'当前钱包未获得触发授权',InvalidTriggerWallets:'每批需要 1–500 个有效公开钱包地址',InvalidTriggerPolicy:'触发金额、滑点或有效期无效',TriggerNotArmed:'当前任务尚未武装或已撤销',StaleTriggerEpoch:'任务代数已变化，旧触发交易不能执行新任务',TriggerTooEarly:'尚未到达任务开始时间'});
module.exports={Engine,amount,percentage,address,triggerAddresses,runtimeMatches,safeError,ERROR_TEXT,verifiedCreationAddress};

