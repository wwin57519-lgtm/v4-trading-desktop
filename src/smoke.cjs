'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function run({app,window,showPage,owner,runner,coordinator,evidence}){
 const errors=[];window.webContents.on('console-message',(_e,_l,message)=>{if(/TypeError|ReferenceError|Uncaught/.test(message))errors.push(message);});
 const evalJS=s=>window.webContents.executeJavaScript(s),pause=()=>new Promise(r=>setTimeout(r,300));
 const report={version:require('../package.json').version,packaged:app.isPackaged,profile:app.getPath('userData'),errors,checks:{},screenshots:[]};
 try{
  await pause();report.owner=await evalJS(`(async()=>{const info=await desktop.invoke('app.info');let denied=false;try{await desktop.invoke('not.allowed');}catch{denied=true;}const choices=[];for(const mode of ['minimum','slippage']){const el=document.getElementById('price-mode-'+mode);el.checked=true;el.dispatchEvent(new Event('change'));choices.push({mode,minimumDisabled:document.getElementById('min-buy-amount').disabled,autoDisabled:document.getElementById('trigger-slippage').disabled});}return{info,denied,choices,independentRecoveryPresent:!!document.getElementById('contract-recovery-load'),hasV4:!!document.getElementById('v4-pool-key'),hasLegacyInputs:!!document.getElementById('min-pool-input')||!!document.getElementById('allow-v2'),nodeNotExposed:typeof require==='undefined'&&typeof process==='undefined',overflow:document.documentElement.scrollWidth>innerWidth,title:document.title};})()`);
  assert.equal(report.owner.independentRecoveryPresent,true);assert.equal(report.owner.denied,true);assert.equal(report.owner.hasV4,true);assert.equal(report.owner.hasLegacyInputs,false);assert.equal(report.owner.nodeNotExposed,true);assert.equal(report.owner.overflow,false);assert.ok(report.owner.choices.every(c=>c.minimumDisabled===(c.mode==='slippage')&&c.autoDisabled===(c.mode==='minimum')));
  // Synthetic key only, never contacts a chain or signs a transaction.
  const imported=await evalJS(`desktop.invoke('wallet.import',{privateKey:'0x'+'01'.repeat(32)})`);assert.equal(runner.vault.list().length,0);report.checks.administratorNotAddedToVault=true;
  for(const id of [1,56,8453]){await coordinator.invoke('owner','network.select',{chainId:id});assert.equal(owner.chain.chainId,runner.chain.chainId);}
  report.checks.sharedNetwork=true;await coordinator.invoke('owner','wallet.disconnect',{});
  await showPage('owner');await pause();fs.writeFileSync(path.join(evidence,'owner-preview.png'),(await window.webContents.capturePage()).toPNG());report.screenshots.push('owner-preview.png');
  await evalJS(`document.documentElement.style.scrollBehavior='auto';document.querySelector('#v4-panel details').open=true;document.getElementById('v4-panel').scrollIntoView({behavior:'instant',block:'start'})`);await pause();fs.writeFileSync(path.join(evidence,'v4-preview.png'),(await window.webContents.capturePage()).toPNG());report.screenshots.push('v4-preview.png');
  await showPage('runner');await pause();report.runner=await evalJS(`(async()=>{const info=await desktop.invoke('app.info');let roleDenied=false;try{await desktop.invoke('funds.withdraw',{});}catch{roleDenied=true;}return{info,roleDenied,hasBack:!!document.getElementById('show-owner'),contractReadonly:document.getElementById('contract-address').readOnly,nodeNotExposed:typeof require==='undefined',overflow:document.documentElement.scrollWidth>innerWidth,title:document.title};})()`);
  assert.equal(report.runner.roleDenied,true);assert.equal(report.runner.hasBack,true);assert.equal(report.runner.contractReadonly,true);assert.equal(report.runner.nodeNotExposed,true);assert.equal(report.runner.overflow,false);assert.equal(report.runner.info.wallets.length,0);assert.equal(report.runner.info.chainId,8453);
  fs.writeFileSync(path.join(evidence,'trigger-preview.png'),(await window.webContents.capturePage()).toPNG());report.screenshots.push('trigger-preview.png');assert.equal(errors.length,0);report.security=window.webContents.getLastWebPreferences();report.passed=true;
 }catch(e){report.passed=false;report.failure=e.stack;console.error(e.stack);}
 await coordinator.close();fs.writeFileSync(path.join(evidence,'electron-smoke.json'),JSON.stringify(report,null,2));console.log('V4 workbench smoke '+(report.passed?'PASS':'FAIL')+' '+evidence);app.exit(report.passed?0:1);
}
module.exports={run};
