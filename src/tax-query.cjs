const {Contract,FetchRequest,JsonRpcProvider,formatUnits,getAddress,toQuantity}=require('ethers');
const CONFIG=require('./config.cjs');
const DEX=require('./dex.cjs');
const CONTRACTS=require('./contract-artifacts.cjs');
const TOKEN_ABI=['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)'];
// Never search nested untrusted token errors for a forged TaxReport.
function revertData(error){
  for(const data of [error?.data?.data,error?.data,error?.info?.error?.data?.result,error?.info?.error?.data]){
    if(typeof data==='string'&&/^0x[0-9a-f]*$/i.test(data))return data;
  }
  return null;
}
function lossPercent(expected,actual){
  expected=BigInt(expected);actual=BigInt(actual);
  if(expected===0n)return null;
  if(actual>=expected)return '0';
  const bps=(expected-actual)*10000n/expected;
  return bps===0n?'<0.01':formatUnits(bps,2);
}
async function queryTax(engine,args,{address,amount,percentage,safeError}){
  const unavailable=reason=>({status:'unavailable',reason});
  if(engine.taxInFlight)return unavailable('已有税率查询正在进行，完成后可查询最新参数');
  if(engine.busy)return unavailable('正在处理管理员操作，完成后自动查询');
  if(!engine.provider||!engine.rpcUrl)return unavailable('请先连接所选网络 RPC，再自动查询税率');
  if(!engine.wallet)return unavailable('请先在本机加载管理员钱包');
  if(!engine.contractAddress)return unavailable('请先部署或加载新版执行合约；税率查询需要模拟实际买入路径');
  const owner=engine.wallet.address,target=engine.contractAddress,rpcUrl=engine.rpcUrl,chain=engine.chain||CONFIG,generation=engine.contextGeneration;
  const contextCurrent=()=>!engine.closed&&engine.contextGeneration===generation&&(engine.chain||CONFIG).chainId===chain.chainId&&engine.wallet?.address===owner&&engine.contractAddress===target&&engine.rpcUrl===rpcUrl;
  let p;engine.taxInFlight=true;
  try{
    const tokenIn=address(args.tokenIn,'支付代币地址'),tokenOut=address(args.tokenOut,'获得代币地址');
    if(tokenIn===tokenOut)throw Error('支付与获得代币不能相同');
    const recipient=address(args.recipient||owner,'最终收款地址');
    if(recipient===target)throw Error('收款地址不能是执行合约自身');
    const probeBps=percentage(args.testSellPercent??1,'模拟试卖比例');
    if(probeBps===0)throw Error('税率查询需要大于 0 的试卖比例');
    const selected=DEX.venue(args.dex??0);
    // Separate read-only connection, never part of the trigger broadcast queue.
    // Provider-side account quotas still apply to both connections.
    if(engine.taxProviderFactory)p=engine.taxProviderFactory(rpcUrl);
    else{const request=new FetchRequest(rpcUrl);request.timeout=12000;p=new JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});}
    if(BigInt((await p.getNetwork()).chainId)!==BigInt(chain.chainId))throw Error('税率查询节点不是当前网络 '+chain.network);
    const blockNumber=await p.getBlockNumber(),blockTag=toQuantity(blockNumber);
    const code=await p.getCode(target,blockNumber),matched=CONTRACTS.identifyExecutor(code,engine.artifact);
    if(!matched)throw Error('此执行合约不支持税率查询，请使用部署工具部署新合约');
    const c=new Contract(target,matched.artifact.abi,p),overrides={blockTag:blockNumber};
    if(getAddress(await c.owner(overrides))!==owner)throw Error('当前管理员不是该执行合约的所有者');
    await DEX.validateDependencies(c,p,matched.helpers,overrides,chain);

    const input=new Contract(tokenIn,TOKEN_ABI,p),output=new Contract(tokenOut,TOKEN_ABI,p);
    const [di,do_,balance]=await Promise.all([input.decimals(overrides),output.decimals(overrides),input.balanceOf(target,overrides)]);
    for(const d of [di,do_])if(d<0n||d>77n)throw Error('代币精度不支持，无法测定税率');
    let n=amount(args.amountIn,Number(di),'模拟支付数量');if(n===0n)n=balance;
    if(n===0n)throw Error('执行合约没有支付代币余额；充值后将按本轮金额自动模拟');
    if(n>balance)throw Error('执行合约支付余额不足以模拟本轮金额');
    const settings={tokenIn,tokenOut,recipient,minBuyAmount:0n,priceMode:0,checkBurn:false,maxBurnBps:10000,testSell:true,testSellBps:probeBps};
    if(!contextCurrent()||engine.busy)return unavailable('钱包、合约或操作状态已变化，等待重新查询');
    let data;const policy=await DEX.policy(c,overrides);
    if(policy.v4Pools?.length){
      const saved=await c.getSettings(overrides),V4=require('./v4-pools.cjs'),draft=V4.list(args.v4Pools||[],chain,{tokenIn,tokenOut,dex:selected},args.lockedPoolId||require('ethers').ZeroHash);
      if(getAddress(saved.tokenIn)!==tokenIn||getAddress(saved.tokenOut)!==tokenOut||getAddress(saved.recipient)!==recipient||selected!==policy.dex||JSON.stringify(draft)!==JSON.stringify(policy.v4Pools)||(args.lockedPoolId||require('ethers').ZeroHash)!==policy.lockedPoolId)throw Error('请先保存当前 V4 候选与币对，再查询真实执行路径的税率');

      data=c.interface.encodeFunctionData('simulateTaxSaved',[n,probeBps]);
    }else throw Error('请先保存 V4 候选池，再查询实际路径税率');

    const tx={from:owner,to:target,data,gas:toQuantity(12000000)};
    let parsed;
    try{await p.send('eth_call',[tx,blockTag]);throw Error('节点未返回预期的模拟回滚报告，无法测定税率');}
    catch(error){
      const data=revertData(error);if(data)try{parsed=c.interface.parseError(data);}catch{}
      if(parsed?.name==='TaxSimulationFailed'){
        let cause;try{cause=c.interface.parseError(parsed.args[0]);}catch{}
        const reasons={NoEligiblePool:'没有可报价的直接池：可能尚未加入流动性',InsufficientInput:'执行合约支付余额不足',SellProbeFailed:'本次试卖无法获得有效回款',V4SwapFailed:'V4 / Infinity 兑换或结算失败：代币可能不兼容扣税／转账行为，税率未知，不能视为零税率',UnexpectedBalance:'代币余额变化异常',MinimumNotMet:'本次模拟未获得有效代币'};
        return unavailable(reasons[cause?.name]||'本次买入、试卖或转发模拟失败；可能尚未开盘、禁止交易或节点不支持，税率未知');
      }
      if(parsed?.name!=='TaxReport')throw error;
    }
    if(!contextCurrent())return unavailable('钱包或合约已切换，旧税率结果已丢弃');
    const r=parsed.args;
    if(r.amountIn!==n||r.expectedBuy===0n||r.bought===0n||r.probeAmount===0n||r.expectedSell===0n||r.probeAmount>r.bought)throw Error('模拟报告数值异常，无法测定税率');
    let route=DEX.route(r);
    if(Number(r.kind)>=10){const [best]=await c.quoteBest.staticCall(n,{...overrides,gasLimit:16000000});if(best.kind!==r.kind||best.amountOut!==r.expectedBuy)throw Error('V4 报价与税率路径不一致');route=DEX.route(best);if(!contextCurrent())return unavailable('网络已切换，旧税率结果已丢弃');}
    return {status:'ok',blockNumber,queriedAt:new Date().toISOString(),tokenIn,tokenOut,recipient,amountIn:formatUnits(n,di),probePercent:formatUnits(probeBps,2),
      buyLossPercent:lossPercent(r.expectedBuy,r.bought),sellLossPercent:lossPercent(r.expectedSell,r.recovered),transferLossPercent:lossPercent(r.forwarded,r.received),totalBuyLossPercent:lossPercent(r.expectedRecipient,r.received),
      route,dex:selected,
      report:Object.fromEntries(['amountIn','expectedBuy','bought','probeAmount','expectedSell','recovered','forwarded','expectedRecipient','received'].map(k=>[k,String(r[k])]))};
  }catch(error){return unavailable(safeError(error,engine.iface));}
  finally{try{p?.destroy?.();}catch{}engine.taxInFlight=false;}
}
module.exports={queryTax,lossPercent,revertData};

