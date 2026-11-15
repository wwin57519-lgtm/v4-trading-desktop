'use strict';
const {app,BrowserWindow,ipcMain,shell,safeStorage,dialog,session,clipboard}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {Engine,safeError}=require('./engine.cjs'),{LocalStore}=require('./local-store.cjs');
const {Engine:Runner}=require('./runner/engine.cjs'),{Store}=require('./runner/store.cjs'),{Vault}=require('./runner/vault.cjs');
const {Coordinator}=require('./coordinator.cjs');
const root=path.resolve(__dirname,'..'),smoke=process.argv.includes('--verify-startup')||(!app.isPackaged&&process.argv.includes('--smoke-test'));
const evidence=smoke?(app.isPackaged?fs.mkdtempSync(path.join(app.getPath('temp'),'v4-workbench-smoke-')):path.join(root,'verification')):null;
app.setPath('userData',smoke?path.join(evidence,'profile'):path.join(app.getPath('appData'),'V4TradingDesktop'));
app.setAppUserModelId('local.evm.v4.desktop');
const pages={owner:pathToFileURL(path.join(root,'renderer/index.html')).href,runner:pathToFileURL(path.join(root,'renderer/runner/index.html')).href};
let window,owner,runner,coordinator,closing=false,pageRole='owner';
function emit(role,event){if(window&&!window.isDestroyed()&&role===pageRole)window.webContents.send(role==='owner'?'desktop:event':'trigger:event',event);}
async function showPage(role){if(!Object.hasOwn(pages,role))throw Error('未知页面');if(coordinator.busy)throw Error('等待当前操作结束后再切换页面');pageRole=role;await window.loadURL(pages[role]);}
async function start(){
 await app.whenReady();session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 const data=app.getPath('userData'),stateFile=path.join(data,'workbench.json');fs.mkdirSync(data,{recursive:true});
 const shared=new LocalStore(stateFile,safeStorage);
 const selected=shared.read().selectedChainId||8453;require('./config.cjs').forChain(selected);
 const scopedStore=(store)=>({read:()=>({...store.read(),selectedChainId:selected}),write:s=>store.write(s),backup:store.backup?.bind(store)});
 owner=new Engine({store:scopedStore(new LocalStore(path.join(data,'owner-state.json'),safeStorage)),onEvent:e=>emit('owner',e),openExternal:u=>shell.openExternal(u),confirmTransaction:async d=>{
  if(closing||!window||window.isDestroyed())return false;
  const r=await dialog.showMessageBox(window,{type:'question',title:'确认管理员交易',message:d.summary,detail:`网络：${d.network} (${d.chainId})\n发送钱包：${d.from}\n目标：${d.to||'部署 V4 专用合约'}\n发送：${d.valueEth} ${d.nativeSymbol}\nNonce：${d.nonce}\nGas 上限：${d.gasLimit}\n费率上限：${d.feeCapGwei} gwei\n执行费用上限：${d.maximumExecutionFeeEth} ${d.nativeSymbol}\n${d.additionalFeeNotice}`,buttons:['取消','确认签名并发送'],defaultId:0,cancelId:0,noLink:true});return !closing&&r.response===1;
 }});
 runner=new Runner({vault:new Vault({file:path.join(data,'trigger-wallet-vault.json')}),store:scopedStore(new Store(path.join(data,'trigger-state.json'),safeStorage)),onEvent:e=>emit('runner',e),openExternal:u=>shell.openExternal(u),copyText:t=>clipboard.writeText(t),importFile:async()=>{const r=await dialog.showOpenDialog(window,{title:'导入触发钱包（本机读取）',properties:['openFile'],filters:[{name:'钱包列表',extensions:['txt','csv','json']}]});if(r.canceled)return null;const f=r.filePaths[0];if(fs.statSync(f).size>1048576)throw Error('钱包文件超过 1 MB');return fs.readFileSync(f,'utf8');}});
 coordinator=new Coordinator({owner,runner,store:shared});
 for(const role of ['owner','runner'])ipcMain.handle(role==='owner'?'desktop:invoke':'trigger:invoke',async(event,method,args)=>{
  if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url.split('#')[0]!==pages[role]||pageRole!==role)return{ok:false,error:'拒绝未知页面'};
  try{if(typeof method!=='string'||!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args).length>(role==='owner'?65536:1100000))throw Error('无效请求');
   if(method==='app.page'){await showPage(args.page);return{ok:true,value:{page:args.page}};}
   return{ok:true,value:await coordinator.invoke(role,method,args)};
  }catch(e){return{ok:false,error:safeError(e,owner.iface)};}
 });
 window=new BrowserWindow({width:1380,height:1000,minWidth:1040,minHeight:720,title:'V4 Trading Desktop',show:false,backgroundColor:'#f4f7fb',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload-unified.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false,devTools:!app.isPackaged}});
 window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.on('will-attach-webview',e=>e.preventDefault());window.once('ready-to-show',()=>{if(!smoke)window.show();});await showPage('owner');
 if(smoke)await require('./smoke.cjs').run({app,window,showPage,owner,runner,coordinator,evidence});
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.on('window-all-closed',()=>app.quit());app.on('before-quit',e=>{if(closing||!coordinator)return;e.preventDefault();closing=true;coordinator.close().catch(e=>console.error(safeError(e))).finally(()=>app.quit());});
 start().catch(e=>{if(smoke)console.error(safeError(e));else dialog.showErrorBox('启动失败',safeError(e));app.exit(1);});
}
