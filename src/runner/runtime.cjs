const {validateReceipt}=require('./receipt-security.cjs');
const {getAddress,isAddress,ZeroAddress,parseUnits,formatUnits,FetchRequest,JsonRpcProvider,WebSocketProvider,keccak256,Interface}=require('ethers');
const CONFIG=require('./config.cjs');
const taxErrors=new Interface(['error SellLossLimitExceeded(uint256,uint256)']);
function taxErrorMessage(error){
 if(error?.revert?.name==='SellLossLimitExceeded')return '卖出损耗超过设定上限，合约拒绝本次买入';
 // Decode only explicit RPC revert data, never transaction input or arbitrary messages.
 for(const data of [error?.data,error?.error?.data,error?.info?.error?.data,error?.info?.error?.data?.result]){
  if(typeof data!=='string'||!/^0x[0-9a-f]{136}$/i.test(data))continue;
  try{if(taxErrors.parseError(data)?.name==='SellLossLimitExceeded')return '卖出损耗超过设定上限，合约拒绝本次买入';}catch{}
 }
 return null;
}
function addr(value,label='地址'){if(!isAddress(value)||getAddress(value)===ZeroAddress)throw Error(label+'无效');return getAddress(value);}
function units(value,decimals=18,label='数量'){const text=String(value??'0').trim();if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)||text.length>100)throw Error(label+'请输入非负十进制数');let n;try{n=parseUnits(text,decimals);}catch{throw Error(label+'精度超出范围');}if(n>2n**256n-1n)throw Error(label+'超出范围');return n;}
function integer(value,min,max,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`${label}必须为 ${min}–${max} 的整数`);return n;}
function cleanError(error){return String(taxErrorMessage(error)||error?.shortMessage||error?.reason||error?.message||error||'操作失败').replace(/https?:\/\/[^\s"'<>]+|wss?:\/\/[^\s"'<>]+/gi,'[节点地址已隐藏]').replace(/(?:0x)?[0-9a-f]{64}/gi,'[敏感长值已隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [隐藏]').slice(0,500);}
function rpcUrl(value,wssOnly=false){let u;try{u=new URL(String(value||'').trim());}catch{throw Error('RPC 地址格式无效');}if(u.username||u.password)throw Error('RPC URL 不支持内嵌用户名密码');const allowed=wssOnly?['wss:','ws:']:['https:','http:','wss:','ws:'];if(!allowed.includes(u.protocol))throw Error(wssOnly?'监听节点必须是 WSS':'RPC 需要 HTTP(S) 或 WS(S)');if(['http:','ws:'].includes(u.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('远程节点请使用加密的 HTTPS/WSS');u.hash='';return u.toString();}
function timeout(promise,ms,message='节点请求超时'){let id;return Promise.race([promise,new Promise((_,reject)=>{id=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(id));}
function runtimeMatches(code,artifact){if(typeof code!=='string'||code.length!==artifact.deployedBytecode.length)return false;let a=code.slice(2).toLowerCase().split(''),b=artifact.deployedBytecode.slice(2).toLowerCase().split('');for(const refs of Object.values(artifact.immutableReferences||{}))for(const {start,length} of refs)for(let i=start*2;i<(start+length)*2;i++){a[i]='0';b[i]='0';}return a.join('')===b.join('');}
function rpcFailure(e){const cause=e?.info?.error??e?.error??e;const errorCode=cause?.code??e?.code??null;const message=cleanError(cause);const rawStatus=e?.status??e?.statusCode??e?.response?.status??e?.info?.responseStatus??null;const match=String(rawStatus??'').match(/^\s*(\d{3})(?:\D|$)/);const status=match?Number(match[1]):null;return{errorCode,httpStatus:status,message,rateLimited:status===429||Number(errorCode)===429||Number(errorCode)===-32005||/429|rate.?limit|too many requests|quota/i.test(message)};}
class Limiter{
 constructor(rps=20){if(!Number.isFinite(rps)||rps<=0||rps>10000)throw Error('节点每秒请求上限无效');this.interval=1000/rps;this.nextAt=0;this.blockedUntil=0;this.inFlight=0;this.queue=[];this.closed=false;}
 run(fn){if(this.closed)return Promise.reject(Error('节点连接已关闭'));if(this.queue.length>=512)return Promise.reject(Error('节点请求队列已满，请降低频率'));return new Promise((resolve,reject)=>{this.queue.push({fn,resolve,reject});this.pump();});}
 noteRateLimit(error){if(rpcFailure(error).rateLimited)this.blockedUntil=Math.max(this.blockedUntil,Date.now()+2000);}
 pump(){clearTimeout(this.timer);if(this.closed||!this.queue.length||this.inFlight>=4)return;const wait=Math.max(this.nextAt,this.blockedUntil)-Date.now();if(wait>0){this.timer=setTimeout(()=>this.pump(),wait);return;}const job=this.queue.shift();this.nextAt=Date.now()+this.interval;this.inFlight++;Promise.resolve().then(()=>{if(this.closed)throw Error('节点连接已关闭');return job.fn();}).then(result=>{for(const item of Array.isArray(result)?result:[result])if(item?.error)this.noteRateLimit(item.error);job.resolve(result);},e=>{this.noteRateLimit(e);job.reject(e);}).finally(()=>{this.inFlight--;this.pump();});this.pump();}
 close(){this.closed=true;clearTimeout(this.timer);for(const job of this.queue)job.reject(Error('节点连接已关闭'));this.queue=[];}
}
class RpcPool {
  constructor({factory,onError=()=>{},rps=20,chainId=8453}={}){this.chainId=CONFIG.forChain(chainId).chainId;this.factory=factory;this.onError=onError;this.providers=[];this.urls=[];this.closed=false;this.rps=rps;this.limiters=[];this.guards=new Map();this.directBroadcast=new WeakMap();this.limitedProviders=new WeakSet();this.unsupportedAdmission=new WeakSet();this.lookupQueues=new WeakMap();this.lookupFlights=new Map();}
  async connect(raw){const urls=[...new Set(raw.map(x=>rpcUrl(x)))];if(!urls.length||urls.length>12)throw Error('请配置 1–12 个 RPC 节点');const entries=await Promise.all(urls.map(async(url,i)=>{let p;try{if(this.factory)p=this.factory(url);else if(/^wss?:/.test(url))p=new WebSocketProvider(url);else{const req=new FetchRequest(url);req.timeout=10000;p=new JsonRpcProvider(req,undefined,{batchMaxCount:1,cacheTimeout:-1});}p.on?.('error',e=>this.onError(cleanError(e)));const start=Date.now();const n=await timeout(p.getNetwork(),12000);if(Number(n.chainId)!==this.chainId)throw Error('不是所选主网 '+this.chainId);const blockNumber=await timeout(p.getBlockNumber(),12000);return{p,url,label:`节点 ${i+1}`,ok:true,latencyMs:Date.now()-start,blockNumber};}catch(e){try{p?.destroy?.();}catch{}return{label:`节点 ${i+1}`,ok:false,error:cleanError(e)};}}));for(const e of entries)if(e.ok){this.providers.push(e.p);this.urls.push(e.url);}if(!this.providers.length)throw Error('全部节点连接失败：'+entries.map(e=>e.error).join('；'));return entries.map(({p,url,...info})=>info);}
  get primary(){if(!this.providers[0])throw Error('请先连接 RPC');return this.providers[0];}
  async read(method,...args){let last;for(const p of this.providers){try{return await timeout(p[method](...args),12000);}catch(e){last=e;}}throw last||Error('没有可用节点');}
  async receipt(hash,record){
    // Receipt indexing can lag on one node even after another accepted/mined a
    // transaction. A null from the first node is not a final absence result.
    let lastError;
    for(const p of this.providers){
      try{const receipt=await timeout(p.getTransactionReceipt(hash),12000);if(receipt){validateReceipt(receipt,hash,record);return receipt;}}
      catch(error){lastError=error;}
    }
    if(lastError)throw lastError;
    return null;
  }
  installLimiters(){this.providers.forEach(p=>{
    if(typeof p._send!=='function'||this.limitedProviders.has(p))return;
    this.limitedProviders.add(p);const original=p._send.bind(p),limiter=new Limiter(this.rps);this.limiters.push(limiter);
    p._send=payload=>{
      // Bind before queuing. A later broadcast of the same hash must not replace
      // the first call's cancellation predicate or transport evidence.
      const bindings=(Array.isArray(payload)?payload:[payload]).filter(item=>item.method==='eth_sendRawTransaction').map(item=>{
        const hash=keccak256(item.params[0]),guard=this.guards.get(hash),direct=this.directBroadcast.get(p);
        const candidates=guard?[...guard.attempts].filter(a=>a.provider===p&&!a.settled):[];
        return{guard,candidates,bound:direct?.hash===hash&&candidates.includes(direct.tracker)?direct.tracker:candidates.length===1?candidates[0]:null};
      });
      const candidatesFor=b=>b.bound?[b.bound]:b.candidates.filter(a=>!a.settled);
      // If batching obscures the owner of identical bytes, cancel conservatively
      // when any candidate stopped; never borrow another call's authorization.
      const allowed=b=>{const candidates=candidatesFor(b);return candidates.length?candidates.every(a=>a.allow()):!b.guard||b.guard.gates.size>0&&[...b.guard.gates.values()].every(fn=>fn());};
      const noteCancelled=()=>{for(const b of bindings){const candidates=candidatesFor(b);if(candidates.length===1)candidates[0].cancelled=true;}};
      let enteredTransport=false;
      return limiter.run(()=>{
        if(bindings.some(b=>this.closed||!allowed(b))){noteCancelled();const e=Error('停止后取消尚未广播的请求');e.code='STOPPED_BEFORE_BROADCAST';throw e;}
        // Entering the original transport is evidence of a handoff, not proof
        // of node admission. A throw/timeout after this point stays potentially sent.
        enteredTransport=true;
        for(const b of bindings){const candidates=candidatesFor(b);if(candidates.length===1)candidates[0].sent=true;else for(const a of candidates)a.ambiguous=true;}
        return original(payload);
      }).catch(error=>{
        if(!enteredTransport&&bindings.length&&(this.closed||bindings.some(b=>!allowed(b)))){
          noteCancelled();const cancelled=Error('停止后取消尚未广播的请求');cancelled.code='STOPPED_BEFORE_BROADCAST';throw cancelled;
        }
        throw error;
      });
    };
  });}
  async broadcast(raw,startIndex=0,canBroadcast=()=>true){
    let last;const attempts=[],hash=keccak256(raw);
    const guard=this.guards.get(hash)||{refs:0,calls:0,gates:new Map(),attempts:new Set()},callId=Symbol('broadcast');guard.calls++;guard.gates.set(callId,canBroadcast);this.guards.set(hash,guard);
    const cleanup=()=>{if(!guard.refs&&!guard.calls&&this.guards.get(hash)===guard)this.guards.delete(hash);};
    const stoppedError=()=>{const e=Error('任务已停止，取消后续节点提交');e.code='STOPPED_BEFORE_BROADCAST';e.attempts=attempts;e.cancelledBeforeSend=attempts.every(a=>a.requestSent===false);return e;};
    try{
      for(let i=0;i<this.providers.length;i++){
        if(this.closed||!canBroadcast())throw stoppedError();
        const index=(startIndex+i)%this.providers.length,p=this.providers[index],started=Date.now();guard.refs++;let pending;
        const tracker={provider:p,allow:canBroadcast,sent:false,cancelled:false,ambiguous:false,settled:false};guard.attempts.add(tracker);
        const evidence=()=>tracker.sent?true:tracker.ambiguous?null:tracker.cancelled?false:null;
        const settled=()=>{tracker.settled=true;guard.attempts.delete(tracker);guard.refs--;cleanup();};
        try{
          const prior=this.directBroadcast.get(p);this.directBroadcast.set(p,{hash,tracker});
          try{pending=Promise.resolve(p.broadcastTransaction(raw));}finally{if(prior)this.directBroadcast.set(p,prior);else this.directBroadcast.delete(p);}
          pending.finally(settled).catch(()=>{});
          const response=await timeout(pending,12000);
          if(typeof response?.hash!=='string'||response.hash.toLowerCase()!==hash.toLowerCase()){const e=Error('RPC 返回了不匹配的交易哈希');e.code='RPC_HASH_MISMATCH';throw e;}
          attempts.push({endpoint:index+1,accepted:true,requestSent:evidence(),latencyMs:Date.now()-started});return{hash,attempts};
        }catch(e){last=e;attempts.push({endpoint:index+1,accepted:false,requestSent:evidence(),latencyMs:Date.now()-started,...rpcFailure(e)});if(!pending)settled();/* Always retry identical signed bytes. */}
      }
      const failure=rpcFailure(last),error=Error(cleanError(last));error.code=failure.errorCode??last?.code;error.attempts=attempts;error.cancelledBeforeSend=error.code==='STOPPED_BEFORE_BROADCAST'&&attempts.every(a=>a.requestSent===false);throw error;
    }finally{guard.calls--;guard.gates.delete(callId);cleanup();}
  }
  async lookup(hash){
    if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('交易哈希格式无效');
    if(this.closed)throw Error('节点连接已关闭');
    hash=hash.toLowerCase();if(this.lookupFlights.has(hash))return this.lookupFlights.get(hash);
    const work=Promise.all(this.providers.map((p,index)=>{
      const before=this.lookupQueues.get(p)||Promise.resolve();
      const operation=before.catch(()=>{}).then(()=>this.lookupEndpoint(p,index,hash));
      this.lookupQueues.set(p,operation);
      return operation.finally(()=>{if(this.lookupQueues.get(p)===operation)this.lookupQueues.delete(p);});
    }));
    this.lookupFlights.set(hash,work);
    try{return await work;}finally{if(this.lookupFlights.get(hash)===work)this.lookupFlights.delete(hash);}
  }
  async lookupEndpoint(p,index,hash){
    const result={endpoint:index+1,seen:null,transactionSeen:null,receiptSeen:null,receiptStatus:null,blockNumber:null,admission:null,errorCode:null,httpStatus:null,errors:[]};
    const recordError=(method,error)=>{const details={method,...rpcFailure(error)};result.errors.push(details);if(result.errorCode===null)result.errorCode=details.errorCode;if(result.httpStatus===null)result.httpStatus=details.httpStatus;};
    if(this.closed){recordError('lookup',Error('节点连接已关闭'));return result;}
    const unsupported=this.chainId!==8453||this.unsupportedAdmission.has(p)||typeof p.send!=='function';
    const jobs=[['eth_getTransactionByHash',()=>p.getTransaction(hash)],['eth_getTransactionReceipt',()=>p.getTransactionReceipt(hash)]];
    if(unsupported)result.admission='unsupported';else jobs.push(['base_transactionStatus',()=>p.send('base_transactionStatus',[hash])]);
    const responses=await Promise.allSettled(jobs.map(([,fn])=>Promise.resolve().then(()=>{if(this.closed)throw Error('节点连接已关闭');return timeout(fn(),12000);})));
    for(let i=0;i<responses.length;i++){
      const method=jobs[i][0],response=responses[i];
      if(response.status==='rejected'){
        const failure=rpcFailure(response.reason);recordError(method,response.reason);
        if(method==='base_transactionStatus'&&(Number(failure.errorCode)===-32601||Number(failure.errorCode)===-32004||/method.{0,40}(not found|not supported|unsupported)|unsupported.{0,40}method/i.test(failure.message))){this.unsupportedAdmission.add(p);result.admission='unsupported';}
        continue;
      }
      const value=response.value;
      if(method==='base_transactionStatus'){
        const status=typeof value==='string'?value:value?.status;
        if(status==='Known'||status==='Unknown')result.admission=status;
        else recordError(method,Object.assign(Error('节点返回了无效的交易接收状态'),{code:'RPC_INVALID_RESPONSE'}));
      }else{
        if(value!=null&&value.hash&&String(value.hash).toLowerCase()!==hash){recordError(method,Object.assign(Error('节点返回了不匹配的交易哈希'),{code:'RPC_HASH_MISMATCH'}));continue;}
        if(method==='eth_getTransactionByHash')result.transactionSeen=value!=null;
        else{result.receiptSeen=value!=null;if(value!=null){const status=Number(value.status);if(value.status!=null&&(status===0||status===1))result.receiptStatus=status;else recordError(method,Object.assign(Error('节点返回了无效的回执状态'),{code:'RPC_INVALID_RESPONSE'}));if(value.blockNumber!=null)result.blockNumber=typeof value.blockNumber==='bigint'?String(value.blockNumber):value.blockNumber;}}
      }
    }
    result.seen=result.transactionSeen===true||result.receiptSeen===true||result.admission==='Known'?true:result.transactionSeen===false&&result.receiptSeen===false?false:null;
    return result;
  }
  async fees(){const f=await this.read('getFeeData');return{gasPriceGwei:formatUnits(f.gasPrice??0n,9),maxFeeGwei:formatUnits(f.maxFeePerGas??f.gasPrice??0n,9),maxPriorityFeeGwei:formatUnits(f.maxPriorityFeePerGas??0n,9)};}
  destroy(){this.closed=true;for(const l of this.limiters)l.close();for(const p of this.providers){try{p.destroy?.();}catch{}}this.providers=[];}
}
module.exports={CONFIG,addr,units,integer,cleanError,rpcUrl,timeout,runtimeMatches,RpcPool,Limiter,rpcFailure};

