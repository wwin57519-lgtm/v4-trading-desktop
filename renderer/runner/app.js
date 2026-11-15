'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const bridge = window.desktop;
  const connected = Boolean(bridge && typeof bridge.invoke === 'function');
  const ACTIVE = new Set(['armed', 'running', 'stopping']);
  const statusLabels = { idle: '未运行', armed: '等待触发', running: '运行中', stopping: '正在停止', stopped: '已停止', completed: '任务结束', error: '任务错误' };
  const state = { chainId:8453,network:'Base',nativeSymbol:'ETH',busy: false, stopRequested: false, rpc: false, contract: null, contractClock: null, taskClock: null, wallets: [], vault: { saved: false, locked: false, count: 0 }, task: { status: 'idle' }, journal: [], diagnosticHash: '', mode: 'block', logs: [], actions: [], initialised: false };
  const secrets = new Set();
  const defaults = {
    rpcUrls: [], rpcRps: 20, monitorRpc: '', contractAddress: '', mode: 'block', startBlock: '0', startTime: '',
    intervalMs: 250, probeIntervalMs: 250, maxAttempts: 0, walletLimit: 20, concurrency: 4,
    gasMode: 'eip1559', gasPriceGwei: '0.01', gasLimit: '4000000', maxFeeGwei: '0.1', maxPriorityFeeGwei: '0.001', gasBudgetEth: '0.01',
    delaySeconds: 0, listenLiquidity: false, liquidityFrom: '', liquidityRouter: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', liquidityToken: '', followLiquidityGas: false, listenFeed: 'pending', customActions: [],
  };
  const fieldIds = {
    rpcRps: 'rpc-rps',
    monitorRpc: 'monitor-rpc', contractAddress: 'contract-address', startBlock: 'start-block', startTime: 'start-time', intervalMs: 'interval-ms', probeIntervalMs: 'probe-interval', maxAttempts: 'max-attempts', walletLimit: 'wallet-limit', concurrency: 'concurrency', gasMode: 'gas-mode', gasPriceGwei: 'gas-price', gasLimit: 'gas-limit', maxFeeGwei: 'max-fee', maxPriorityFeeGwei: 'priority-fee', gasBudgetEth: 'gas-budget', delaySeconds: 'delay-seconds', liquidityFrom: 'liquidity-from', liquidityRouter: 'liquidity-router', liquidityToken: 'liquidity-token', listenFeed: 'listen-feed',
  };
  const toggles = { listenLiquidity: 'listen-liquidity', followLiquidityGas: 'follow-liquidity-gas' };
  function text(el, value) { el.textContent = value == null ? '—' : String(value); }
  function show(el, value) { el.classList.toggle('hidden', !value); }
  function badge(el, value, tone = 'neutral') { el.className = `badge ${tone}`; text(el, value); }
  function shortAddress(value) { return typeof value === 'string' && value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value || '—'; }
  function isAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || '')); }
  function address(value, label, optional = false) {
    const s = String(value || '').trim(); if (!s && optional) return '';
    if (!isAddress(s) || /^0x0{40}$/i.test(s)) throw Error(`${label}必须是有效的非零 EVM 地址。`); return s;
  }
  function dec(value, label) { const s = String(value ?? '').trim(); if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s) || s.length > 100) throw Error(`${label}请输入非负十进制数。`); return s; }
  function int(value, label, min, max = Number.MAX_SAFE_INTEGER) { const s = String(value ?? '').trim(); const n = Number(s); if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) throw Error(`${label}必须为 ${min}–${max} 之间的整数。`); return n; }
  function sanitise(value) {
    let s = String(value == null ? '' : value);
    for (const secret of secrets) if (secret) s = s.split(secret).join('[敏感值已隐藏]');
    s = s.replace(/(?<![a-fA-F0-9])(?:0x)?[a-fA-F0-9]{64}(?![a-fA-F0-9])/g, '[64 位十六进制值已隐藏]');
    return s.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[节点地址已隐藏]').slice(0, 10000);
  }
  function errorMessage(error) { return sanitise(error?.shortMessage || error?.reason || error?.message || error || '操作未完成。'); }
  function notice(message, tone = '') { $('notice').className = `notice ${tone}`; text($('notice'), sanitise(message)); }
  function log(message, level = 'info') {
    const tone = { warn: 'warning', warning: 'warning', error: 'error', success: 'success', info: 'info' }[level] || 'info';
    const row = document.createElement('div'); row.className = 'log-row';
    const time = document.createElement('span'); time.className = 'log-time'; text(time, new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    const tag = document.createElement('span'); tag.className = `log-level ${tone}`; text(tag, { info: '信息', warning: '提示', error: '错误', success: '完成' }[tone]);
    const content = document.createElement('span'); content.className = 'log-message'; text(content, sanitise(message)); row.append(time, tag, content);
    $('logs').querySelector('.empty')?.remove(); $('logs').append(row); state.logs.push(row);
    if (state.logs.length > 300) state.logs.shift().remove(); text($('log-count'), state.logs.length); $('logs').scrollTop = $('logs').scrollHeight;
  }
  async function invoke(method, args = {}) { if (!connected) throw Error('请从桌面应用打开。'); return bridge.invoke(method, args); }
  function running() { return ACTIVE.has(state.task?.status); }
  function validTimestamp(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 8640000000000 ? n : null; }
  function observeChain(previous, timestamp, observedAt, key) {
    const chain = validTimestamp(timestamp); if (chain == null) return null;
    const observed = Number(observedAt); const hasObserved = Number.isFinite(observed) && observed > 0;
    if (previous?.key === key && previous.timestamp === chain && (!hasObserved || previous.observedAt === observed)) return previous;
    return { key, timestamp: chain, observedAt: hasObserved ? observed : null, ageAtReceive: hasObserved ? Math.max(0, Date.now() - observed) : 0, receivedAt: performance.now() };
  }
  function chainEstimate(clock) {
    if (!clock) return null;
    const ageMs = clock.ageAtReceive + Math.max(0, performance.now() - clock.receivedAt);
    return { timestamp: clock.timestamp + ageMs / 1000, lastTimestamp: clock.timestamp, ageMs, stale: ageMs > 30000 };
  }
  function expiryRequirement() {
    const expiresAt = validTimestamp(state.contract?.policy?.expiresAt);
    if (expiresAt == null) return '本轮没有有效的链上截止时间，请由 owner 在部署与资金管理页面中设置有效期并武装。';
    const chain = chainEstimate(state.contractClock);
    if (!chain) return '尚未读到可核对的链上时间，请重新读取合约后开始。';
    if (chain.lastTimestamp >= expiresAt) return '最近读取的链上时间已达到本轮截止，请由 owner 设置有效期并武装新一轮。';
    if (chain.timestamp >= expiresAt) return '按最近链上时间推算已达到截止，已禁用启动；请重新读取合约核对。';
    return '';
  }
  function renderDeadline() {
    const taskDeadline = running();
    const expiresAt = validTimestamp(taskDeadline ? state.task.expiresAt : state.contract?.policy?.expiresAt);
    const chain = chainEstimate(taskDeadline ? state.taskClock : state.contractClock);
    const panel = $('task-deadline'); panel.classList.remove('expired', 'stale');
    text($('deadline-at'), expiresAt == null ? '未读取到有效截止时间' : formatPolicyTime(expiresAt));
    if (expiresAt == null) { text($('deadline-countdown'), '未设置'); text($('deadline-evidence'), '必须由 owner 在部署与资金管理页面中设置本轮有效期并武装。'); return; }
    if (!chain) { text($('deadline-countdown'), '等待链上时间'); text($('deadline-evidence'), '请读取合约核对；不能根据本机时间认定已在链上结束。'); return; }
    const remaining = Math.max(0, Math.ceil(expiresAt - chain.timestamp));
    const hours = Math.floor(remaining / 3600); const minutes = Math.floor((remaining % 3600) / 60); const seconds = remaining % 60;
    text($('deadline-countdown'), remaining ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : chain.lastTimestamp >= expiresAt ? '已达链上截止' : '预计已到期');
    panel.classList.toggle('expired', remaining === 0); panel.classList.toggle('stale', chain.stale);
    const freshness = chain.stale ? `链时已 ${Math.floor(chain.ageMs / 1000)} 秒未刷新。参考估计，请核对链上。` : '根据最近链上时间推算，实际以交易执行时的区块时间为准。';
    text($('deadline-evidence'), `${freshness}${remaining === 0 ? ' 倒计时到零不代表收到了链上撤销回执。' : ''}`);
  }
  function selectedWallets() { const n = Number($('wallet-limit').value); return state.wallets.slice(0, Math.max(0, Math.min(Number.isFinite(n) ? n : 0, 500))); }
  function requirements() {
    if (!state.rpc) return '请先测试并连接 Base RPC。';
    if (!state.contract) return '请先读取专属执行合约。';
    if (state.contract.supported !== true) return '当前合约不支持此触发器，请使用部署与资金管理页面。';
    if (state.contract.executed === true) return '本轮合约已经执行，请由 owner 配置并武装新一轮。';
    if (state.contract.triggerArmed !== true) return '合约尚未武装，请在部署与资金管理页面中由 owner 武装本轮触发。';
    const expiryReason = expiryRequirement(); if (expiryReason) return expiryReason;
    if (state.vault.locked) return '保险库已锁定，请解锁后运行。';
    if (!state.wallets.length) return '请导入至少一个执行钱包。';
    if (Number($('wallet-limit').value) > state.wallets.length) return `当前导入 ${state.wallets.length} 个钱包，请将使用钱包数量设为 1–${state.wallets.length || 500}，或继续导入。`;
    const chosen = selectedWallets();
    if (!chosen.length) return '请导入至少一个执行钱包。';
    if (!chosen.some(wallet => wallet.authorized === true)) return '本次选取的钱包尚未授权，请复制公开地址到部署与资金管理页面中授权后刷新。';
    if (!chosen.some(wallet => wallet.authorized === true && !wallet.pending)) return '已授权钱包均有待处理交易，请先刷新交易状态。';
    return '';
  }
  function sync() {
    $('network-select').disabled=state.busy;
    const active = running(); const locked = state.busy || active; const reason = requirements();
    document.body.classList.toggle('busy', state.busy); document.body.setAttribute('aria-busy', String(state.busy));
    document.querySelectorAll('input,textarea,select,.mode-tab,.remove-action').forEach(el => { el.disabled = !connected || (el.id==='network-select'?state.busy:locked); });
    const capability = {
      'rpc-test': !active, 'contract-inspect': state.rpc && !active, 'wallet-import': !active && !(state.vault.saved&&state.vault.locked), 'wallet-import-file': !active && !(state.vault.saved&&state.vault.locked),
      'wallet-refresh': !active && state.rpc, 'vault-save': !active && state.wallets.length > 0 && !state.vault.locked,
      'vault-unlock': !active && state.vault.saved && state.vault.locked, 'wallet-lock': !active && (state.wallets.length > 0 || !state.vault.locked),
      'copy-addresses': state.wallets.length > 0, 'download-addresses': state.wallets.length > 0,
      'task-preview': state.rpc && Boolean(state.contract) && !active, 'task-start': !reason && !active,
      'task-stop': ['armed', 'running'].includes(state.task?.status), 'journal-refresh': state.rpc, 'journal-recover': state.rpc && !active,
      'diagnostic-refresh': state.rpc && /^0x[a-fA-F0-9]{64}$/.test(state.diagnosticHash),
      'add-action': !active,
    };
    for (const [id, condition] of Object.entries(capability)) $(id).disabled = !connected || state.busy || !condition;
    // Stopping must remain available while a read or start request is still waiting.
    $('task-stop').disabled = !connected || state.stopRequested || !['armed', 'running'].includes(state.task?.status);
    $('clear-logs').disabled = false;
    $('diagnostic-close').disabled = false;
    document.querySelectorAll('.diagnose-record').forEach(button => { button.disabled = !connected || state.busy || !state.rpc; });
    $('delay-seconds').disabled = !connected || locked || state.mode !== 'listen';
    const liquidity = $('listen-liquidity').checked;
    ['liquidity-from', 'liquidity-router', 'liquidity-token', 'follow-liquidity-gas'].forEach(id => { $(id).disabled = !connected || locked || !liquidity; });
    show($('eip-fields'), $('gas-mode').value === 'eip1559'); show($('legacy-fields'), $('gas-mode').value === 'legacy');
    for (const button of document.querySelectorAll('.mode-tab')) { const current = button.dataset.mode === state.mode; button.classList.toggle('active', current); button.setAttribute('aria-selected', String(current)); }
    document.querySelectorAll('.mode-panel').forEach(panel => show(panel, panel.dataset.panel === state.mode));
    text($('authorized-count'), `${state.wallets.filter(wallet => wallet.authorized === true).length} / ${state.wallets.length}`);
    text($('selected-count'), `${selectedWallets().length} 个 · ${selectedWallets().filter(wallet => wallet.authorized === true && !wallet.pending).length} 个已授权且无待处理`);
    show($('start-requirements'), Boolean(reason) && !active); text($('start-requirements'), reason);
    badge($('vault-badge'), state.vault.locked ? '保险库已锁定' : state.vault.saved ? '本机保险库已解锁' : '密钥仅在内存', state.vault.locked ? 'warning' : 'neutral');
    text($('vault-detail'), state.vault.saved ? `本机已保存加密保险库。${state.vault.locked ? '先解锁原保险库再添加钱包；清除内存不会解锁或覆盖原保险库。' : `已解锁 ${state.wallets.length} 个钱包。锁定会清除内存中的可用私钥。`}` : '未保存保险库。关闭应用或清除内存后需要重新导入。');
    renderDeadline();
  }
  function applyTask(task) {
    if (!task || typeof task !== 'object') return;
    state.task = { ...state.task, ...task };
    state.taskClock = observeChain(state.taskClock, state.task.chainTimestamp, state.task.chainObservedAt, state.task.id || `${state.task.contractAddress || ''}:${state.task.epoch || ''}`);
    const status = state.task.status || 'idle'; const label = statusLabels[status] || status;
    const tone = status === 'error' ? 'error' : ['running', 'armed'].includes(status) ? 'blue' : status === 'completed' ? 'success' : 'neutral';
    badge($('task-status'), label, tone); badge($('header-status'), label, tone);
    const counters = state.task.counters || state.task;
    ['attempts', 'submitted', 'confirmed', 'reverted', 'pending'].forEach(key => text($(`metric-${key}`), counters[key] ?? 0));
    text($('metric-mined'), Number(counters.confirmed || 0) + Number(counters.reverted || 0));
    text($('task-gas-spent'), `${state.task.executionGasSpentEth ?? '0'} ${state.nativeSymbol}`);
    text($('task-gas-reserved'), `${state.task.executionGasReservedEth ?? '0'} ${state.nativeSymbol}`);
    text($('task-gas-unverified'),`${state.task.executionGasUnverifiedEth??'0'} ${state.nativeSymbol} · ${counters.feesUnverified??0} 笔`);
    text($('task-reason'), sanitise(state.task.reason || (running() ? '任务正在本机执行' : '等待配置并预览')));
    const date = state.task.nextAt ? new Date(state.task.nextAt) : null;
    text($('task-next'), date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : state.task.nextAt || '—'); sync();
  }
  function renderWallets(wallets) {
    state.wallets = Array.isArray(wallets) ? wallets.slice(0, 500).map(wallet => ({ address: wallet.address, balance: wallet.balance, authorized: wallet.authorized, pending: wallet.pending })) : [];
    $('wallet-table').replaceChildren(); badge($('wallet-count'), `${state.wallets.length} 个`, state.wallets.length ? 'blue' : 'neutral');
    state.wallets.forEach((wallet, index) => {
      const row = document.createElement('tr');
      const values = [index + 1, wallet.address || '地址未返回', wallet.balance ?? '—'];
      values.forEach((value, i) => { const cell = document.createElement('td'); text(cell, value); if (i === 1) cell.className = 'mono'; row.append(cell); });
      const permission = document.createElement('td'); const pill = document.createElement('span');
      badge(pill, wallet.authorized === true ? '已授权' : wallet.authorized === false ? '未授权' : '未核对', wallet.authorized === true ? 'success' : 'warning'); permission.append(pill); row.append(permission);
      const pending = document.createElement('td'); text(pending, wallet.pending ? (typeof wallet.pending === 'number' ? `${wallet.pending} 笔` : '有待处理') : '—'); row.append(pending); $('wallet-table').append(row);
    });
    if (!state.wallets.length) emptyRow($('wallet-table'), 5, '尚未导入钱包。支持 1–500 个，建议先使用 20–100 个。'); sync();
  }
  function emptyRow(tbody, columns, value) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = columns; cell.className = 'empty'; text(cell, value); row.append(cell); tbody.append(row); }
  function applyContract(contract) {
    state.contract = contract && isAddress(contract.address) ? contract : null;
    state.contractClock = state.contract ? observeChain(state.contractClock, contract.blockTimestamp, contract.blockObservedAt, `${contract.address}:${contract.triggerEpoch}`) : null;
    $('contract-summary').replaceChildren(); show($('contract-summary'), Boolean(state.contract)); show($('contract-warning'), false);
    if (!state.contract) { badge($('contract-status'), '未读取'); text($('contract-detail'), '本程序只负责触发，不修改 owner 设置。'); text($('trigger-epoch'), '—'); sync(); return; }
    $('contract-address').value = contract.address;
    badge($('contract-status'), contract.supported === true ? contract.triggerArmed ? '已武装' : '待武装' : '接口不兼容', contract.supported === true && contract.triggerArmed ? 'success' : 'warning');
    if(contract.dex===1){$('liquidity-router').value='0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';if(!$('liquidity-token').value)$('liquidity-token').value=contract.settings?.tokenOut||'';}
    text($('contract-detail'), `Owner：${contract.owner || '未知'} · 版本 ${contract.version || '待确认'}`); text($('trigger-epoch'), contract.triggerEpoch ?? '—');
    const settings = contract.settings || {}; const policy = contract.policy || {};
    const entries = [['交易所',contract.dex===2?'PancakeSwap Infinity CL / Bin':'Uniswap V4'],['支付代币', settings.tokenIn], ['获得代币', settings.tokenOut], ['购买收款地址（无提款权限）', settings.recipient], ['本轮状态', contract.executed ? '已经执行' : '尚未执行'], ['自动支付数量（最小单位）', String(policy.amountIn)==='0'?'使用执行时全部支付币余额':policy.amountIn==null?'未读取':`${policy.amountIn} 最小单位；不是常用显示数量`], ['固定最低购入量（最小单位）',settings.minBuyAmount==null?'未读取':`${settings.minBuyAmount} 获得币最小单位（试卖前）`], ['自动滑点', settings.priceMode===1?'已关闭（仅最小得到）':policy.slippageBps == null ? '—' : `${Number(policy.slippageBps) / 100}%`], ['链上最早时间', formatPolicyTime(policy.notBefore)], ['链上失效时间', formatPolicyTime(policy.expiresAt)]];
    if(contract.v4Pools?.length){entries.push(['已保存 V4 候选池',String(contract.v4Pools.length)],['锁定 Pool ID',contract.lockedPoolId&&/^0x0{64}$/.test(contract.lockedPoolId)?'关闭 · 自动比较':contract.lockedPoolId||'关闭']);for(const p of contract.v4Pools)entries.push([p.kind===10?'Uniswap V4 Pool ID':p.kind===11?'Infinity CL Pool ID':'Infinity Bin Pool ID',p.poolId]);}
    for (const [label, value] of entries) { const item = document.createElement('div'); item.className = 'summary-item'; const title = document.createElement('span'); text(title, label); const content = document.createElement('strong'); text(content, value ?? '—'); item.append(title, content); $('contract-summary').append(item); }
    if (contract.supported !== true) { text($('contract-warning'), '此页面只支持独立 V4 1.0.1 执行器；旧合约请使用对应旧工具。'); show($('contract-warning'), true); }
    else if (contract.executed || !contract.triggerArmed) { text($('contract-warning'), contract.executed ? '本轮已经执行。请由 owner 在部署与资金管理页面中设置并武装新一轮。' : '请在部署与资金管理页面中授权执行钱包并武装合约，无需在此导入 owner 私钥。'); show($('contract-warning'), true); }
    sync();
  }
  function formatPolicyTime(value) { if (value == null) return '—'; if (String(value) === '0') return '未限制'; const n = Number(value); const date = new Date(n < 1e12 ? n * 1000 : n); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false }); }
  function renderJournal(journal) {
    state.journal = Array.isArray(journal) ? journal : Array.isArray(journal?.records) ? journal.records : [];
    $('journal-table').replaceChildren();
    const labels = { prepared: ['本地准备，未见回执', 'neutral'], pending: ['待回执，尚未证明打包', 'warning'], unknown: ['结果未知，待核对', 'warning'], confirmed: ['已打包 · 执行成功', 'success'], reverted: ['已打包 · 执行回滚', 'error'], replaced: ['已替换', 'neutral'], superseded: ['Nonce 已消耗 · 结果未核实', 'warning'], notBroadcast: ['未广播', 'neutral'], cancelled: ['已取消', 'neutral'], signed: ['仅本地签名', 'blue'], submitting: ['正在广播，未见回执', 'blue'] };
    for (const entry of state.journal.slice(-100).reverse()) {
      const row = document.createElement('tr'); const time = document.createElement('td'); text(time, entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
      appendDetail(time, `重试 ${entry.retries ?? 0} 次`);
      const wallet = document.createElement('td'); const who = entry.from || entry.address || entry.wallet; text(wallet, shortAddress(who)); wallet.title = typeof who === 'string' ? who : ''; wallet.className = 'mono';
      const admission = document.createElement('td'); const admissionBadge = document.createElement('span');
      const attempts = Array.isArray(entry.rpcAttempts) ? entry.rpcAttempts : [];
      const accepted = entry.accepted === true || (entry.accepted == null && attempts.some(attempt => attempt.accepted === true));
      badge(admissionBadge, accepted ? '节点接收已确认' : entry.status === 'prepared' || entry.status === 'signed' ? '仅本地准备' : '无节点接收确认', accepted ? 'success' : 'warning'); admission.append(admissionBadge);
      if (attempts.length) {
        appendDetail(admission, `${attempts.length} 条广播尝试记录`);
        if (attempts.some(attempt => attempt.rateLimited || Number(attempt.httpStatus) === 429)) appendDetail(admission, '曾遇到节点限流 / 429');
        const last = attempts[attempts.length - 1]; if (last.errorCode != null || last.httpStatus != null) appendDetail(admission, `错误码 ${last.errorCode ?? '—'} · HTTP ${last.httpStatus ?? '—'}`);
      }
      const status = document.createElement('td'); const pill = document.createElement('span'); badge(pill, ...(labels[entry.status] || [sanitise(entry.status || '未知'), 'warning'])); status.append(pill);
      appendDetail(status, entry.blockNumber != null ? `区块 #${entry.blockNumber}` : '没有区块号证据');
      if (entry.gasUsed != null) appendDetail(status, `Gas Used ${entry.gasUsed}`);
      if(entry.feeUnverified===true)appendDetail(status,`费用待核实；继续预留 ${formatWei(entry.reserveFee??'0')} ETH 执行费预算，不能按零费用处理`);
      if (entry.executionFee != null && (entry.blockNumber != null || ['confirmed', 'reverted', 'replaced'].includes(entry.status))) appendDetail(status, `执行费 ${formatWei(entry.executionFee)} ${(entry.chainId??8453)===56?'BNB':'ETH'}（不含额外费用）`);
      const hash = document.createElement('td'); const value = entry.hash || entry.txHash;
      if (/^0x[a-fA-F0-9]{64}$/.test(value || '')) {
        const actions = document.createElement('div'); actions.className = 'journal-actions';
        const link = document.createElement('button'); link.className = 'text-button mono'; text(link, `${shortAddress(value)} ↗`); link.addEventListener('click', () => invoke('app.openExternal', { url: `${explorer(entry.chainId??state.chainId)}/tx/${value}` }).catch(error => log(errorMessage(error), 'error')));
        const diagnose = document.createElement('button'); diagnose.className = 'text-button diagnose-record'; text(diagnose, '诊断'); diagnose.addEventListener('click', () => diagnoseRecord(value)); actions.append(link, diagnose); hash.append(actions);
        if (!accepted) appendDetail(hash, '本地哈希 ≠ 节点接收');
      } else text(hash, '等待有效交易哈希'); row.append(time, wallet, admission, status, hash); $('journal-table').append(row);
    }
    if (!state.journal.length) emptyRow($('journal-table'), 5, '暂无交易记录。'); sync();
  }
  function appendDetail(parent, value) { const el = document.createElement('small'); el.className = 'cell-detail'; text(el, sanitise(value)); parent.append(el); }
  function formatWei(value) {
    try { const n = BigInt(value); const fraction = String(n % 1000000000000000000n).padStart(18, '0').replace(/0+$/, ''); return `${n / 1000000000000000000n}${fraction ? `.${fraction}` : ''}`; }
    catch { return '未知'; }
  }
  function endpointLabel(value, index) { return /^\d+$/.test(String(value ?? '')) ? `节点 ${value}` : value ? sanitise(value) : `节点 ${index + 1}`; }
  function diagnosticMessage(item) {
    const details = [`错误码 ${item.errorCode ?? '—'}`, `HTTP ${item.httpStatus ?? '—'}`, item.rateLimited ? '节点限流' : '', item.message ? sanitise(item.message) : ''].filter(Boolean);
    for (const error of Array.isArray(item.errors) ? item.errors.slice(0, 12) : []) details.push(sanitise(`${error.method || '查询'}：${error.errorCode ?? '—'} / HTTP ${error.httpStatus ?? '—'}${error.rateLimited ? ' · 节点限流' : ''} · ${error.message || ''}`));
    return details.join(' · ');
  }
  function renderDiagnostic(result) {
    $('diagnostic-nodes').replaceChildren(); $('diagnostic-attempts').replaceChildren();
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    nodes.forEach((node, index) => {
      const row = document.createElement('tr');
      const endpoint = document.createElement('td'); text(endpoint, endpointLabel(node.endpoint, index));
      const seen = document.createElement('td'); const seenBadge = document.createElement('span'); badge(seenBadge, node.seen === true ? '此节点可见' : node.seen === false ? '此节点未查到' : '未能核对', node.seen === true ? 'blue' : 'warning'); seen.append(seenBadge);
      const admission = document.createElement('td');
      const admissionLabels = { Known: '接收状态 Known · 节点已知', Unknown: '接收状态 Unknown · 节点未知', unsupported: '此节点不支持接收状态查询' };
      text(admission, sanitise(admissionLabels[node.admission] || (typeof node.admission === 'object' && node.admission ? JSON.stringify(node.admission) : node.admission ?? '无接收诊断结果')));
      const receipt = document.createElement('td'); const status = node.receiptStatus;
      text(receipt, status === 1 || status === '1' || status === '0x1' ? '回执成功' : status === 0 || status === '0' || status === '0x0' ? '回执回滚' : '未取得回执');
      appendDetail(receipt, node.blockNumber != null ? `区块 #${node.blockNumber}` : '未返回区块号');
      const error = document.createElement('td'); text(error, diagnosticMessage(node)); row.append(endpoint, seen, admission, receipt, error); $('diagnostic-nodes').append(row);
    });
    if (!nodes.length) emptyRow($('diagnostic-nodes'), 5, '本次未返回节点诊断结果。');
    const attempts = Array.isArray(result?.rpcAttempts) ? result.rpcAttempts : [];
    attempts.forEach((attempt, index) => {
      const row = document.createElement('tr'); const endpoint = document.createElement('td'); text(endpoint, endpointLabel(attempt.endpoint, index));
      const accepted = document.createElement('td'); const pill = document.createElement('span'); badge(pill, attempt.accepted === true ? '节点接收已确认' : '未取得接收确认', attempt.accepted === true ? 'success' : 'warning'); accepted.append(pill);
      const latency = document.createElement('td'); text(latency, attempt.latencyMs != null ? `${attempt.latencyMs} ms` : '—');
      const error = document.createElement('td'); text(error, diagnosticMessage(attempt)); row.append(endpoint, accepted, latency, error); $('diagnostic-attempts').append(row);
    });
    if (!attempts.length) emptyRow($('diagnostic-attempts'), 4, '本机没有记录到广播尝试；仅凭哈希不能证明曾被节点接收。');
  }
  async function diagnoseRecord(hash) {
    if (!connected || state.busy || !state.rpc || !/^0x[a-fA-F0-9]{64}$/.test(hash || '')) return;
    state.diagnosticHash = hash; show($('diagnostic-panel'), true); text($('diagnostic-hash'), hash);
    $('diagnostic-nodes').replaceChildren(); $('diagnostic-attempts').replaceChildren(); show($('diagnostic-loading'), true);
    $('diagnostic-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { await operation('diagnostic-refresh', '按需诊断此笔交易', async () => { renderDiagnostic(await invoke('journal.diagnose', { hash })); log('单笔节点诊断已返回。未启动针对全部钱包的额外自动诊断。', 'info'); }); }
    finally { show($('diagnostic-loading'), false); }
  }
  async function refreshInfo({ config = false, contract = true } = {}) {
    const info = await invoke('app.info');applyNetwork(info);
    if(info.rpcConnected){state.rpc=true;state.feesNeedRefresh=false;badge($('rpc-status'),'节点已连接','success');}
    if (info.vault) state.vault = { ...state.vault, ...info.vault };
    if (Array.isArray(info.wallets)) renderWallets(info.wallets);
    if (info.task) applyTask(info.task);
    if (info.journal) renderJournal(info.journal);
    if (contract) applyContract(info.contract);
    if (config && info.config) applyConfig(info.config);
    if (info.version) { text($('sidebar-version'), `版本 ${info.version}`); text($('footer-version'), `v${info.version}`); }
    sync(); return info;
  }
  async function operation(id, label, callback) {
    if (!connected || state.busy) return;
    const button = $(id); const original = button.textContent;
    state.busy = true; show($('notice'), false); sync(); text(button, '处理中…');
    try { return await callback(); }
    catch (error) { const message = errorMessage(error); notice(`${label}未完成：${message}`, 'error'); log(`${label}未完成：${message}`, 'error'); }
    finally { text(button, original); state.busy = false; sync(); }
  }
  function collectActions() {
    return [...$('custom-actions').children].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value.trim()])));
  }
  function renderActions(actions = []) {
    $('custom-actions').replaceChildren();
    for (const action of actions) {
      const row = document.createElement('div'); row.className = 'custom-action';
      const title = document.createElement('div'); title.className = 'action-title'; const number = document.createElement('span'); text(number, `监听规则 ${$('custom-actions').children.length + 1}`);
      const remove = document.createElement('button'); remove.className = 'text-button remove-action'; text(remove, '移除'); remove.addEventListener('click', () => { row.remove(); changed(); }); title.append(number, remove); row.append(title);
      const grid = document.createElement('div'); grid.className = 'grid two';
      for (const [key, label, hint] of [['from', 'From · 发送者', '留空为任意发送者'], ['to', 'To · 目标地址', '留空为任意目标'], ['selector', '动作 / 0x 十六进制', '例如 0x12345678'], ['gasPriceGwei', '动作 Gas · Gwei', '0 跟随目标交易']]) {
        const field = document.createElement('div'); field.className = 'field'; const lab = document.createElement('label'); text(lab, label); const input = document.createElement('input'); input.dataset.field = key; input.value = action[key] ?? (key === 'gasPriceGwei' ? '0' : ''); input.placeholder = hint; input.spellcheck = false; input.autocomplete = 'off'; input.className = 'mono'; input.addEventListener('input', changed); lab.append(input); field.append(lab); grid.append(field);
      }
      const field = document.createElement('div'); field.className = 'field'; const label = document.createElement('label'); text(label, '匹配方式'); const select = document.createElement('select'); select.dataset.field = 'match';
      for (const [value, name] of [['contains', 'Calldata 子串 · 与原页一致'], ['selector', '严格匹配前 4 字节 selector']]) { const option = document.createElement('option'); option.value = value; text(option, name); select.append(option); }
      select.value = action.match || 'contains'; select.addEventListener('change', changed); label.append(select); field.append(label); grid.append(field); row.append(grid); $('custom-actions').append(row);
    }
    sync();
  }
  function applyConfig(config) {
    const c = { ...defaults, ...config };
    $('rpc-urls').value = Array.isArray(c.rpcUrls) ? c.rpcUrls.join('\n') : '';
    for (const [key, id] of Object.entries(fieldIds)) {
      let value = c[key] ?? '';
      if (key === 'startTime' && value) { const date = new Date(value); if (!Number.isNaN(date.getTime())) value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
      $(id).value = value;
    }
    for (const [key, id] of Object.entries(toggles)) $(id).checked = c[key] === true;
    state.mode = ['block', 'time', 'probe', 'listen'].includes(c.mode) ? c.mode : 'block'; renderActions(c.customActions || []); sync();
  }
  function urls() {
    const values = [...new Set($('rpc-urls').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    if (!values.length) throw Error('请填写至少一个所选网络 HTTP(S) RPC。');
    if (values.length > 12) throw Error('最多可配置 12 个执行 RPC。');
    for (const value of values) { let parsed; try { parsed = new URL(value); } catch { throw Error('执行 RPC 请输入完整 URL，每行一个。'); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('执行 RPC 应为不含用户名密码的 HTTP(S) 地址。'); }
    return values;
  }
  function config() {
    const c = { ...defaults, rpcUrls: urls(), mode: state.mode };
    for (const [key, id] of Object.entries(fieldIds)) c[key] = $(id).value.trim();
    for (const [key, id] of Object.entries(toggles)) c[key] = $(id).checked;
    c.contractAddress = address(c.contractAddress, '执行合约地址');
    c.rpcRps = int(c.rpcRps, '每节点请求上限', 1, 1000);
    c.startBlock = String(int(c.startBlock, '开始区块', 0));
    c.intervalMs = int(c.intervalMs, '全局发起间隔', 1, 3600000); c.probeIntervalMs = int(c.probeIntervalMs, '模拟间隔', 50, 3600000);
    c.maxAttempts = int(c.maxAttempts, '最大尝试次数', 0, 1000000000); c.walletLimit = int(c.walletLimit, '钱包数量', 1, 500); c.concurrency = int(c.concurrency, '并发数', 1, Math.min(c.walletLimit, 100));
    if (c.walletLimit > state.wallets.length) throw Error(`只导入了 ${state.wallets.length} 个钱包，请调整使用数量。`);
    c.gasLimit = String(int(c.gasLimit, 'Gas Limit', 21000, 16000000));
    for (const key of ['gasPriceGwei', 'maxFeeGwei', 'maxPriorityFeeGwei', 'gasBudgetEth']) c[key] = dec(c[key], { gasPriceGwei: 'Gas Price', maxFeeGwei: 'Max Fee', maxPriorityFeeGwei: 'Max Priority Fee', gasBudgetEth: '累计执行 Gas 预算' }[key]);
    if (c.gasMode === 'eip1559' && Number(c.maxPriorityFeeGwei) > Number(c.maxFeeGwei)) throw Error('Max Priority Fee 不能高于 Max Fee。');
    if ((c.gasMode === 'eip1559' && Number(c.maxFeeGwei) === 0) || (c.gasMode === 'legacy' && Number(c.gasPriceGwei) === 0)) throw Error('当前模式的 Gas 费率上限必须大于 0。');
    c.delaySeconds = int(c.delaySeconds, '监听延迟', 0, 86400);
    if (c.mode === 'time') { if (!c.startTime || Number.isNaN(new Date(c.startTime).getTime())) throw Error('请选择有效的本地开始时间。'); c.startTime = new Date(c.startTime).toISOString(); }
    else c.startTime = c.startTime && !Number.isNaN(new Date(c.startTime).getTime()) ? new Date(c.startTime).toISOString() : '';
    c.customActions = collectActions();
    if (c.mode === 'listen') {
      let ws; try { ws = new URL(c.monitorRpc); } catch { throw Error('监听模式请填写有效 WSS 节点。'); }
      if (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(ws.hostname))) throw Error('远程监听节点必须使用 WSS。');
      if (c.listenLiquidity) { c.liquidityFrom = address(c.liquidityFrom, '流动性发送者', true); c.liquidityRouter = address(c.liquidityRouter, '流动性 Router'); c.liquidityToken = address(c.liquidityToken, '目标代币', true); }
      c.customActions = c.customActions.map((action, index) => {
        const result = { ...action, from: address(action.from, `规则 ${index + 1} From`, true), to: address(action.to, `规则 ${index + 1} To`, true), gasPriceGwei: dec(action.gasPriceGwei || '0', `规则 ${index + 1} Gas`) };
        if (!result.from && !result.to && !result.selector) throw Error(`监听规则 ${index + 1} 不能全部为空。`);
        if (result.selector && !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.selector)) throw Error(`规则 ${index + 1} 动作请输入 0x 开头的完整十六进制字节。`);
        if (result.match === 'selector' && !/^0x[0-9a-fA-F]{8}$/.test(result.selector)) throw Error(`规则 ${index + 1} 严格 selector 必须为 4 字节。`);
        return result;
      });
      if (!c.listenLiquidity && !c.customActions.length) throw Error('监听模式至少需要一项流动性筛选或自定义动作。');
    } else {
      c.monitorRpc = ''; c.delaySeconds = 0; c.listenLiquidity = false; c.followLiquidityGas = false;
      c.liquidityFrom = ''; c.liquidityToken = ''; c.liquidityRouter = defaults.liquidityRouter; c.customActions = [];
    }
    return c;
  }
  function changed() { show($('preview-result'), false); sync(); }
  function on(id, handler) { $(id).addEventListener('click', handler); }
  async function testRpc() {
    const result = await invoke('rpc.test', { urls: urls(), rps: int($('rpc-rps').value, '每节点请求上限', 1, 1000) });
    if (Number(result.chainId) !== state.chainId) throw Error('执行节点与当前网络不符。');
    state.rpc = true; applyContract(null); badge($('rpc-status'), state.network+' 已连接', 'success'); text($('rpc-detail'), `当前区块 ${result.blockNumber ?? '—'}`);
    $('rpc-endpoints').replaceChildren();
    (result.endpoints || []).forEach((endpoint, index) => { const tag = document.createElement('span'); badge(tag, `${sanitise(endpoint.label || `节点 ${index + 1}`)} · ${endpoint.ok ? `${endpoint.latencyMs ?? '—'} ms` : '不可用'}`, endpoint.ok ? 'success' : 'warning'); $('rpc-endpoints').append(tag); });
    if(result.fees&&state.feesNeedRefresh){for(const [key,id] of [['gasPriceGwei','gas-price'],['maxFeeGwei','max-fee'],['maxPriorityFeeGwei','priority-fee']])if(Number(result.fees[key])>0)$(id).value=result.fees[key];state.feesNeedRefresh=false;}
    if (result.fees) text($('fee-hint'), `参考 Max Fee ${result.fees.maxFeeGwei ?? '—'} / Priority ${result.fees.maxPriorityFeeGwei ?? '—'} Gwei`);
    log(`${state.network} 节点测试完成，当前区块 ${result.blockNumber ?? '—'}。`, 'info'); return result;
  }
  on('rpc-test', () => operation('rpc-test', '测试节点', async () => { state.rpc = false; try { await testRpc(); } catch (error) { badge($('rpc-status'), '测试失败', 'error'); throw error; } }));
  on('contract-inspect', () => operation('contract-inspect', '读取合约', async () => {
    const result = await invoke('contract.inspect', { address: address($('contract-address').value, '执行合约地址') }); applyContract(result);
    renderWallets(await invoke('wallets.list')); log(result.supported === true ? '已读取触发接口、武装策略和执行状态。' : '当前合约接口不兼容，请使用部署与资金管理页面。', result.supported === true ? 'info' : 'warning');
  }));
  function importFeedback(result) {
    if (!Number.isSafeInteger(result?.imported) || !Number.isSafeInteger(result?.duplicates)) throw Error('导入结果不完整，请刷新并核对公开地址列表。');
    const invalidLines = (result.invalidLines || []).filter(line => Number.isSafeInteger(line) && line > 0);
    if (invalidLines.length) throw Error(`无效行：${invalidLines.join('、')}。本批原子校验未通过，新增 0 个，整批未导入；检测到重复 ${result.duplicates} 个。已有钱包保持原样。`);
    const message = `导入完成：新增 ${result.imported} 个，重复 ${result.duplicates} 个；当前公开地址 ${state.wallets.length} 个。`;
    notice(message, 'info'); log(message, 'info');
  }
  on('wallet-import', () => operation('wallet-import', '导入钱包', async () => {
    const value = $('private-keys').value.trim(); $('private-keys').value = '';
    if (!value) throw Error('请先输入执行钱包私钥。');
    if (value.length > 100000) throw Error('导入文本过长，请限制在 500 个执行钱包内。');
    secrets.add(value); const parts = value.split(/[\s,;]+/).filter(Boolean); parts.forEach(part => secrets.add(part));
    try { const result = await invoke('wallets.import', { text: value }); await refreshInfo(); importFeedback(result); }
    catch (error) { throw Error(errorMessage(error)); }
    finally { secrets.delete(value); parts.forEach(part => secrets.delete(part)); }
  }));
  on('wallet-import-file', () => operation('wallet-import-file', '从文件导入', async () => { const result = await invoke('wallets.importFile'); if (result?.cancelled) return; await refreshInfo(); importFeedback(result); }));
  on('wallet-refresh', () => operation('wallet-refresh', '刷新钱包', async () => { renderWallets(await invoke('wallets.list')); log('已刷新公开地址、余额、授权和待处理状态。', 'info'); }));
  function publicAddresses() { return state.wallets.map(wallet => wallet.address).filter(isAddress).join('\n'); }
  on('copy-addresses', () => operation('copy-addresses', '复制公开地址', async () => {
    const result = await invoke('wallets.copyAddresses');
    if (!Number.isSafeInteger(result?.count) || result.count < 0) throw Error('复制结果未确认，请使用下载地址列表。');
    log(`已复制 ${result.count} 个公开地址，不含私钥。`, 'info');
  }));
  on('download-addresses', () => {
    const blob = new Blob([publicAddresses() + '\n'], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'Base-执行钱包公开地址.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); log('已请求下载公开地址列表，不含私钥。', 'info');
  });
  async function vaultOperation(method) {
    const password = $('vault-password').value; $('vault-password').value = '';
    if (!password) throw Error('请输入保险库密码。'); secrets.add(password);
    try { await invoke(method, { password }); await refreshInfo(); log(method === 'vault.save' ? '保险库保存操作已返回。请保管好密码。' : '保险库解锁操作已返回。', 'info'); }
    catch (error) { throw Error(errorMessage(error)); }
    finally { secrets.delete(password); }
  }
  on('vault-save', () => operation('vault-save', '保存保险库', () => vaultOperation('vault.save')));
  on('vault-unlock', () => operation('vault-unlock', '解锁保险库', () => vaultOperation('vault.unlock')));
  on('wallet-lock', () => operation('wallet-lock', '锁定钱包', async () => { $('private-keys').value = ''; $('vault-password').value = ''; await invoke('wallets.lock'); await refreshInfo(); log('内存钱包锁定操作已返回。', 'info'); }));
  on('add-action', () => { const list = collectActions(); if (list.length >= 100) { notice('最多设置 100 条监听动作。', 'warning'); return; } renderActions([...list, { from: '', to: '', selector: '', gasPriceGwei: '0', match: 'contains' }]); changed(); });
  on('task-preview', () => operation('task-preview', '预览配置', async () => {
    const result = await invoke('task.preview', { config: config() });
    const summary = typeof result === 'string' ? result : [result.summary || '预览已返回。', `选取 ${result.selectedWalletCount ?? '—'} 个 · 已授权 ${result.authorizedWalletCount ?? '—'} 个 · 当前可用 ${result.readyWalletCount ?? '—'} 个`, `单笔执行 Gas 上限 ${result.perTransactionGasEth ?? '—'} ${state.nativeSymbol}`, `同时待确认执行 Gas 上限 ${result.maxPendingGasEth ?? '—'} ${state.nativeSymbol}`, `累计执行 Gas 预算 ${result.gasBudgetEth ?? '—'} ${state.nativeSymbol}（0 为不限）`].join('\n');
    $('preview-result').className = `notice ${result?.canStart === false ? 'warning' : 'info'}`; text($('preview-result'), sanitise(summary));
    await refreshInfo(); log('预览已返回，未启动任务、未发送交易。', 'info');
  }));
  on('task-start', () => operation('task-start', '启动任务', async () => {
    const reason = requirements(); if (reason) throw Error(reason);
    const result = await invoke('task.start', { config: config() });
    if (result?.task) applyTask(result.task); else if (result?.status) applyTask(result);
    await refreshInfo(); log(`任务启动请求已返回，当前状态：${statusLabels[state.task.status] || state.task.status}。`, 'info');
  }));
  on('task-stop', async () => {
    if (!connected || state.stopRequested || !['armed', 'running'].includes(state.task?.status)) return;
    state.stopRequested = true; sync();
    try {
      const result = await invoke('task.stop'); if (result?.task) applyTask(result.task); else if (result?.status) applyTask(result);
      await refreshInfo(); notice('已停止本机提交。已发交易在截止前仍可执行；提前结束本轮，请在部署 EXE 点击“结束本轮（链上）”，由 owner 钱包提交并等待链上确认。', 'warning'); log('已停止本机提交，未撤销链上授权。已广播交易在截止前仍可能执行。', 'warning');
    } catch (error) { notice(`停止请求未完成：${errorMessage(error)}`, 'error'); log(`停止请求未完成：${errorMessage(error)}`, 'error'); }
    finally { state.stopRequested = false; sync(); }
  });
  on('journal-refresh', () => operation('journal-refresh', '刷新交易记录', async () => { renderJournal(await invoke('journal.refresh')); await refreshInfo(); log('已刷新本机记录与当前链上状态。', 'info'); }));
  on('journal-recover', () => operation('journal-recover', '核对交易哈希', async () => {
    const hash = $('recover-hash').value.trim(); if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw Error('请输入完整的交易哈希。');
    const result = await invoke('journal.recover', { hash }); if (Array.isArray(result)) renderJournal(result); await refreshInfo(); log('哈希核对请求已返回，请以交易记录显示的状态为准。', 'info');
  }));
  on('diagnostic-refresh', () => diagnoseRecord(state.diagnosticHash));
  on('diagnostic-close', () => show($('diagnostic-panel'), false));
  on('clear-logs', () => { state.logs = []; $('logs').replaceChildren(); text($('log-count'), '0'); });
  for (const button of document.querySelectorAll('.mode-tab')) button.addEventListener('click', () => { state.mode = button.dataset.mode; changed(); });
  for (const id of [...Object.values(fieldIds), ...Object.values(toggles)]) $(id).addEventListener($(id).type === 'checkbox' || $(id).tagName === 'SELECT' ? 'change' : 'input', changed);
  $('rpc-urls').addEventListener('input', () => { state.rpc = false; applyContract(null); badge($('rpc-status'), '地址已更改，待测试', 'warning'); changed(); });
  $('contract-address').addEventListener('input', () => { if (state.contract && $('contract-address').value.toLowerCase() !== state.contract.address.toLowerCase()) applyContract(null); });
  if (typeof bridge?.onEvent === 'function') bridge.onEvent(event => {
    if (!event || typeof event !== 'object') return;
    if (event.message) log(event.message, event.level || 'info');
    if (event.type === 'task' && event.task) applyTask(event.task);
    if (event.type === 'wallets' && event.wallets) renderWallets(event.wallets);
    if (event.type === 'journal' && event.journal) renderJournal(event.journal);
  });

  function explorer(id){return id===1?'https://etherscan.io':id===56?'https://bscscan.com':'https://basescan.org';}
  function applyNetwork(info){
    state.chainId=info.chainId??8453;state.network=info.network||'Base';state.nativeSymbol=info.nativeSymbol||'ETH';$('network-select').value=String(state.chainId);
    $('rpc-urls').placeholder='https://你的 '+state.network+' RPC（每行一个，最多 12 个节点）';$('monitor-rpc').placeholder='wss://你的 '+state.network+' 监听节点';
    defaults.gasMode=info.gasMode||'eip1559';if($('native-balance-title'))text($('native-balance-title'),state.nativeSymbol);
    for(const el of document.querySelectorAll('[data-native-unit]'))text(el,state.nativeSymbol);
    const flash=$('listen-feed').querySelector('option[value="flashblocks"]');flash.disabled=state.chainId!==8453;flash.hidden=state.chainId!==8453;
    if(state.chainId!==8453&&$('listen-feed').value==='flashblocks')$('listen-feed').value='pending';
  }
  $('network-select').addEventListener('change',async()=>{if(state.busy)return;state.busy=true;sync();try{
    const info=await invoke('network.select',{chainId:Number($('network-select').value)});state.rpc=false;state.feesNeedRefresh=true;state.diagnosticHash='';show($('diagnostic-panel'),false);applyNetwork(info);applyConfig(info.config||{});applyContract(null);applyTask(info.task);renderWallets(info.wallets||[]);renderJournal(info.journal||[]);badge($('rpc-status'),'网络已切换，请测试节点','neutral');show($('preview-result'),false);
  }catch(e){notice(errorMessage(e),'error');$('network-select').value=String(state.chainId);}finally{state.busy=false;sync();}});

  applyConfig(defaults);
  setInterval(() => { if (state.initialised) sync(); }, 1000);
  text($('time-help'), `本机时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || '系统本地时区'}。系统时间与节点时间可能存在偏差。`);
  if (!connected) { show($('desktop-warning'), true); sync(); return; }
  (async () => {
    state.busy = true; sync();
    try {
      const info = await refreshInfo({ config: true });
      if (info.config?.rpcUrls?.length && !info.rpcConnected && !running()) {
        try { await testRpc(); if (isAddress(info.config.contractAddress)) { applyContract(await invoke('contract.inspect', { address: info.config.contractAddress })); renderWallets(await invoke('wallets.list')); } }
        catch (error) { log(`保存的连接尚未就绪：${errorMessage(error)}`, 'warning'); }
      }
      log('本地触发服务已就绪。导入密钥默认仅驻留内存，只有开始任务后才自动签名。', 'info');
    } catch (error) { notice(`初始化失败：${errorMessage(error)}`, 'error'); log(errorMessage(error), 'error'); }
    finally { state.busy = false; state.initialised = true; sync(); }
  })();
})();

document.getElementById('show-owner').addEventListener('click',()=>window.desktop.invoke('app.page',{page:'owner'}).catch(console.error));

