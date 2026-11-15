const {performance}=require('node:perf_hooks');

// A local stop deadline supplements the Solidity check. It can only get earlier,
// so repeated stale RPC blocks or a changed Windows clock cannot extend a run.
class TaskWindow {
  constructor(policy,block,{now=()=>performance.now(),wallNow=()=>Date.now(),observedMonotonic,observedAt}={}) {
    this.now=now;this.wallNow=wallNow;
    this.expiresAt=Number(policy.expiresAt);this.notBefore=Number(policy.notBefore||0);
    if(!Number.isSafeInteger(this.expiresAt)||this.expiresAt<=0||!Number.isSafeInteger(this.notBefore)||this.notBefore<0||this.expiresAt<=this.notBefore)throw Error('本轮必须有有效的链上截止时间');
    const timestamp=Number(block.timestamp);
    if(!Number.isSafeInteger(timestamp)||timestamp<0)throw Error('节点未返回有效链上时间');
    this.chainTimestamp=timestamp;this.chainObservedAt=observedAt??wallNow();
    this.deadline=(observedMonotonic??now())+Math.max(0,this.expiresAt-timestamp)*1000;
  }
  observe(block) {
    const timestamp=Number(block.timestamp);
    if(!Number.isSafeInteger(timestamp)||timestamp<this.chainTimestamp)return;
    this.deadline=Math.min(this.deadline,this.now()+Math.max(0,this.expiresAt-timestamp)*1000);
    if(timestamp>this.chainTimestamp){this.chainTimestamp=timestamp;this.chainObservedAt=this.wallNow();}
  }
  expired(){return this.chainTimestamp>=this.expiresAt||this.now()>=this.deadline;}
  remainingMs(){return Math.max(0,this.deadline-this.now());}
  state(){return{expiresAt:this.expiresAt,notBefore:this.notBefore,chainTimestamp:this.chainTimestamp,chainObservedAt:this.chainObservedAt};}
}
module.exports={TaskWindow};
