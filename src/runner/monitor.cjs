const WebSocket=require('ws');
const SEC=require('./listener-security.cjs');
const V4LIQ=require('./v4-liquidity.cjs');
const {validateReceipt}=require('./receipt-security.cjs');
const {rpcUrl,cleanError,units}=require('./runtime.cjs');
const lower=x=>String(x||'').toLowerCase();
function matchTransaction(config,tx){
  if (!SEC.shape(tx)) return null;
  const input=lower(tx.input||tx.data),from=lower(tx.from),to=lower(tx.to);
  for(const action of V4LIQ.actions(config,tx))if(V4LIQ.matches(config,action))return{reason:'匹配添加流动性交易：'+action.action,followGas:config.followLiquidityGas===true,tx};
  for(const rule of config.customActions||[]){
    const needle=lower(rule.selector);
    if(!rule.from&&!rule.to&&!needle)continue;
    if(rule.from&&from!==lower(rule.from))continue;
    if(rule.to&&to!==lower(rule.to))continue;
    if(needle&&(rule.match==='selector'?input.slice(0,10)!==needle:!SEC.containsBytes(input,needle)))continue;
    return{reason:'匹配自定义监听动作',followGas:units(rule.gasPriceGwei||'0',9)===0n,gasPriceGwei:rule.gasPriceGwei||'0',tx};
  }
  return null;
}
class Monitor {
 constructor({url,feed='pending',pool,config,onMatch,onLog=()=>{},onFatal=()=>{}}){this.url=rpcUrl(url,true);this.feed=feed;this.pool=pool;this.config=config;this.onMatch=onMatch;this.log=onLog;this.onFatal=onFatal;this.requests=new Map();this.nextId=0;this.running=false;this.matched=false;this.retry=0;this.seen=new Set();this.queue=[];this.workers=0;this.positionCache=new Map();this.connectionGeneration=0;}
 async start(){this.running=true;await this.connect();}
 async connect(){
  if(!this.running)return;
  const generation=++this.connectionGeneration;
  this.subscription=null;this.logSubscription=null;this.queue=[];this.seen.clear();
  for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(Error('监听连接已更换'));}this.requests.clear();
  const previousSocket=this.socket;
  const socket=new WebSocket(this.url,{handshakeTimeout:12000,maxPayload:4*1024*1024});this.socket=socket;previousSocket?.terminate();
  const current=()=>this.running&&this.socket===socket&&generation===this.connectionGeneration;
  let heartbeat;let alive=true;socket.on('pong',()=>{alive=true;});
  socket.on('message',data=>{if(this.socket===socket)this.message(data);});socket.on('error',()=>{});
  socket.on('close',()=>{clearInterval(heartbeat);if(this.socket!==socket)return;this.connectionGeneration++;this.queue=[];this.seen.clear();this.subscription=null;this.logSubscription=null;for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(Error('监听连接中断'));}this.requests.clear();if(this.running&&!this.matched){this.log('监听连接中断，正在重连','warn');this.retryTimer=setTimeout(()=>this.connect().catch(e=>this.log(cleanError(e),'warn')),Math.min(30000,1000*2**Math.min(this.retry++,5)));}});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);socket.once('close',()=>reject(Error('监听连接在握手完成前关闭')));});
  if(!current()){socket.terminate();return;}
  heartbeat=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;if(socket.readyState===WebSocket.OPEN)socket.ping();},15000);heartbeat.unref?.();this.heartbeatTimer=heartbeat;
  try{
   const chainId=await this.request('eth_chainId',[]);if(!current())return;
   if(BigInt(chainId)!==BigInt(this.config.chainId??8453))throw Error('监听节点不是当前网络');
   if(this.feed==='flashblocks'&&(this.config.chainId??8453)!==8453)throw Error('Flashblocks 仅支持 Base');
   const subscriptionId=value=>{if(typeof value!=='string'||!value||value.length>256)throw Error('监听节点返回了无效订阅标识');return value;};
   let subscription;
   if(this.feed==='flashblocks')subscription=await this.request('eth_subscribe',['newFlashblockTransactions']);
   else{try{subscription=await this.request('eth_subscribe',['newPendingTransactions',true]);}catch(e){if(!current())return;subscription=await this.request('eth_subscribe',['newPendingTransactions']);}}
   if(!current())return;this.subscription=subscriptionId(subscription);
   const filter=V4LIQ.logFilter(this.config);
   if(filter){const logs=await this.request('eth_subscribe',['logs',filter]);if(!current())return;this.logSubscription=subscriptionId(logs);}
   this.retry=0;this.log(this.feed==='flashblocks'?'已订阅 Base 预确认交易流（交易已经排序）':'已订阅节点可见的 pending 交易','info');
  }catch(e){if(!current())return;this.running=false;clearInterval(heartbeat);socket.close();const error=Error('节点不支持所选监听方式或连接失败：'+cleanError(e));this.onFatal(error);throw error;}
 }
 request(method,params){const id=++this.nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(id);reject(Error('监听 RPC 响应超时'));},12000);this.requests.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});}
 message(raw){let data;try{data=JSON.parse(raw.toString());}catch{return;}
  if(!data||typeof data!=='object'||Array.isArray(data))return;
  if (data.id) {const r=this.requests.get(data.id);if(!r)return;clearTimeout(r.timer);this.requests.delete(data.id);data.error?r.reject(Error(typeof data.error.message==='string'?data.error.message:'订阅失败')):r.resolve(data.result);return;}
  if(!this.running||this.matched||data.method!=='eth_subscription')return;
  if(this.logSubscription&&data.params?.subscription===this.logSubscription){const event=data.params.result;if(!SEC.logShape(event)||!V4LIQ.logMatch(this.config,event))return;const key='log:'+event.transactionHash.toLowerCase()+':'+SEC.index(event);if(this.seen.has(key))return;if(this.queue.length>=2000){this.onFatal(Error('监听事件队列超过节点处理能力，已停止'));this.stop();return;}this.seen.add(key);if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value);this.queue.push({listenerLog:event,hash:key});this.pump();return;}
  // A notification is not trusted until the chain-checked subscription ID is
  // known. Ignore unsolicited frames during handshake and unrelated streams.
  if(!this.subscription||data.params?.subscription!==this.subscription)return;
  let item=data.params?.result; if(item?.transaction)item=item.transaction;
  const hash=typeof item==='string'?item:item?.hash;
  if(!SEC.hash32(hash)||(typeof item==='object'&&!SEC.shape(item)))return;
  if(hash){if(this.seen.has(hash))return;this.seen.add(hash);if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value);}
  if(typeof item!=='object'&&!/^0x[0-9a-f]{64}$/i.test(item||''))return;
  // Complete transactions that need no position lookup keep the immediate path.
  if(typeof item==='object'){const candidate=matchTransaction(this.config,item);const canonical=candidate&&SEC.signed(item,this.config.chainId??8453);const matched=canonical&&matchTransaction(this.config,canonical);if(candidate&&!matched)return;if(matched){this.matched=true;this.onMatch(matched);return;}}
  if(this.queue.length>=2000){this.onFatal(Error('监听队列超过节点处理能力，已停止；请使用提供完整交易的 WSS 节点'));this.stop();return;}
  this.queue.push(item);this.pump();
 }
 async transaction(hash){const generation=this.connectionGeneration;for(let i=0;i<3&&this.running&&!this.matched&&generation===this.connectionGeneration;i++){let tx;try{tx=await this.request('eth_getTransactionByHash',[hash]);}catch{}if(generation!==this.connectionGeneration)return null;if(tx)return SEC.bound(tx,hash);if(i<2)await new Promise(r=>setTimeout(r,100*(i+1)));}if(this.running&&!this.matched&&generation===this.connectionGeneration){const tx=await this.pool.read('getTransaction',hash);if(!this.running||generation!==this.connectionGeneration)return null;return SEC.bound(tx,hash);}return null;}
 pump(){while(this.running&&!this.matched&&this.workers<6&&this.queue.length){const item=this.queue.shift(),hash=typeof item==='string'?item:item?.hash,generation=this.connectionGeneration;this.workers++;(item?.listenerLog?this.inspectLog(item.listenerLog):(typeof item==='object'?Promise.resolve(item):this.transaction(item))).then(tx=>{if(generation!==this.connectionGeneration)return;if(item?.listenerLog){if(!this.matched)this.seen.delete(hash);return;}if(tx)return this.inspect(tx);else this.seen.delete(hash);}).catch(e=>{if(generation!==this.connectionGeneration)return;this.seen.delete(hash);this.log('监听交易读取失败：'+cleanError(e),'warn');}).finally(()=>{this.workers--;this.pump();});}}
 async inspectLog(log){
  const generation=this.connectionGeneration;
  if(!this.running||this.matched||!SEC.logShape(log))return;
  const item=V4LIQ.logMatch(this.config,log);if(!item)return;
  const active=()=>this.running&&!this.matched&&generation===this.connectionGeneration;
  const receipt=await this.pool.read('getTransactionReceipt',log.transactionHash);if(!active()||!receipt)return;
  validateReceipt(receipt,log.transactionHash);if(receipt.status!==1)return;
  const block=await this.pool.read('getBlock',receipt.blockNumber);if(!active()||!SEC.receiptHasLog(log,receipt,block))return;
  let tx={hash:log.transactionHash};
  if(this.config.liquidityFrom||this.config.followLiquidityGas){tx=SEC.signed(await this.transaction(log.transactionHash),this.config.chainId??8453);if(!active()||!tx||lower(tx.from)!==lower(receipt.from)||(this.config.liquidityFrom&&lower(tx.from)!==lower(this.config.liquidityFrom)))return;}
  if(active()){this.matched=true;this.onMatch({reason:'匹配 '+item.action+'：'+item.poolId,followGas:this.config.followLiquidityGas===true,tx,poolId:item.poolId});}
 }
 async inspect(tx){
  const generation=this.connectionGeneration;
  if(!this.running||this.matched)return;
  let matched=matchTransaction(this.config,tx);
  if(!matched){for(const item of V4LIQ.actions(this.config,tx)){if(!item.tokenId)continue;const key=item.manager+':'+item.tokenId;let resolved=this.positionCache.get(key);if(!resolved){resolved=await V4LIQ.position(this.config,item,this.pool);if(resolved){if(this.positionCache.size>=1000)this.positionCache.clear();this.positionCache.set(key,resolved);}}if(resolved&&V4LIQ.matches(this.config,resolved)){matched={reason:'匹配添加流动性交易：'+item.action,followGas:this.config.followLiquidityGas===true,tx};break;}}}
  if(this.running&&!this.matched&&generation===this.connectionGeneration&&matched){this.matched=true;this.onMatch(matched);}
 }
 stop(){this.running=false;this.connectionGeneration++;this.subscription=null;this.logSubscription=null;clearTimeout(this.retryTimer);clearInterval(this.heartbeatTimer);for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(Error('监听已停止'));}this.requests.clear();this.queue=[];this.socket?.terminate();}
}
module.exports={Monitor,matchTransaction};

