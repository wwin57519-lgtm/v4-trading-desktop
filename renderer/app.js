'use strict';

(() => {
  let WETH = '0x4200000000000000000000000000000000000006';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const $ = id => document.getElementById(id);
  const bridge = window.desktop;
  const available = Boolean(bridge && typeof bridge.invoke === 'function');
  const settingsKeys = ['dex', 'tokenIn', 'tokenOut', 'recipient', 'minBuyAmount', 'checkBurn', 'maxBurnPercent', 'maxSellLossPercent', 'testSell', 'testSellPercent'];
  const state = {
    chainId:8453,network:'Base',nativeSymbol:'ETH',wrappedSymbol:'WETH',rpcReady: false, wallet: null, contract: null, busy: false, action: '',
    v4Pools:[], lockedPoolId:'0x'+'0'.repeat(64), baseline: null, hasReadSettings: false, priceProtectionMode:'slippage', v3Fees: [100,500,3000,10000], quote: null, tokens: { in: null, out: null }, tokenKeys: { in: null, out: null },
    logs: [], transactions: [], pendingTransaction: false, initialised: false, triggerClock: null, triggerEnd: null, triggerFormContract: null,
    tax: { key: null, generation: 0, timer: null, inFlight: false, lastAttempt: -Infinity, queued: false, status: 'unavailable' },
  };
  const defaults = {
    dex: '0', tokenIn: WETH, tokenOut: '', recipient: '', minPoolInput: '0', minBuyAmount: '0',
    allowV2: true, checkBurn: false, maxBurnPercent: '50', maxSellLossPercent: '10', testSell: false, testSellPercent: '1', v3Fees: [100, 500, 3000, 10000],
  };
  const booleanKeys = new Set(['checkBurn', 'testSell']);
  const settingInputs = new Map(settingsKeys.map(key => [key, document.querySelector(`[data-setting="${key}"]`)]));
  const operationButtons = [...document.querySelectorAll('button')].filter(el => el.id !== 'clear-logs');
  const operationNames = {
    'rpc.connect': '连接 RPC', 'wallet.import': '导入管理员钱包', 'wallet.disconnect': '锁定管理员钱包',
    'contract.load': '加载合约', 'contract.deploy': '部署专属合约', 'contract.read': '读取链上设置',
    'contract.save': '保存设置', 'quote.compare': '比较报价', 'trade.simulate': '模拟交易',
    'trade.buy': '购买', 'funds.deposit': '充值', 'funds.withdraw': '取回资金', 'token.inspect': '查询代币',
    'transaction.refresh': '刷新交易状态', 'transaction.recover': '核对交易',
    'trigger.read': '读取触发任务', 'trigger.wallets': '更新触发授权', 'trigger.arm': '开启本轮', 'trigger.disarm': '结束本轮',
  };
  const mutationMethods = new Set(['contract.deploy', 'contract.save', 'trade.buy', 'funds.deposit', 'funds.withdraw', 'trigger.wallets', 'trigger.arm', 'trigger.disarm']);

  function text(el, value) { el.textContent = value == null ? '—' : String(value); }
  function show(el, visible) { el.classList.toggle('hidden', !visible); }
  function badge(el, message, tone = 'neutral') { el.className = `badge ${tone}`; text(el, message); }
  function briefAddress(address) { return typeof address === 'string' && address.length > 17 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address || '未连接'; }
  function addressValid(address) { return /^0x[a-fA-F0-9]{40}$/.test(String(address || '')); }
  function requireAddress(value, label, permitZero = false) {
    const result = String(value || '').trim();
    if (!addressValid(result) || (!permitZero && result.toLowerCase() === ZERO)) throw new Error(`${label}必须是有效的非零 EVM 地址。`);
    return result;
  }
  function decimal(value, label, emptyAsZero = false) {
    const result = String(value == null ? '' : value).trim();
    if (!result && emptyAsZero) return '0';
    if (!/^\d+(?:\.\d+)?$/.test(result)) throw new Error(`${label}请输入非负十进制数，不使用科学计数法。`);
    return result;
  }
  function percent(value, label) {
    const result = decimal(value, label);
    if ((result.split('.')[1] || '').length > 2) throw new Error(`${label}最多保留两位小数，例如 0.1 表示 0.1%。`);
    if (Number(result) > 100) throw new Error(`${label}不能超过 100%。`);
    return result;
  }
  function extractError(error) {
    return String(error?.shortMessage || error?.reason || error?.message || error || '操作失败，请检查运行记录。').slice(0, 6000);
  }
  function displayNotice(message, tone = '') {
    const el = $('global-notice');
    el.className = `notice ${tone}`;
    text(el, message);
  }
  function clearNotice() { show($('global-notice'), false); }
  function log(message, level = 'info', txHash) {
    const levelMap = { warn: 'warning', warning: 'warning', success: 'success', error: 'error', info: 'info' };
    const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message: String(message || '').slice(0, 6000), level: levelMap[level] || 'info', txHash };
    state.logs.push(entry);
    if (state.logs.length > 300) state.logs.shift();
    const container = $('logs');
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    container.querySelector('.log-empty')?.remove();
    const row = document.createElement('div'); row.className = 'log-row';
    const time = document.createElement('span'); time.className = 'log-time'; text(time, entry.time);
    const label = document.createElement('span'); label.className = `log-level ${entry.level}`;
    text(label, { info: '信息', warning: '提示', success: '完成', error: '错误' }[entry.level]);
    const content = document.createElement('span'); content.className = 'log-message'; text(content, entry.message);
    if (/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
      const link = document.createElement('button'); link.type = 'button'; link.className = 'text-button'; text(link, '查看链上交易 ↗');
      link.addEventListener('click', () => openExternal(`${explorer(state.chainId)}/tx/${txHash}`));
      content.append(link);
    }
    row.append(time, label, content); container.append(row);
    while (container.children.length > 300) container.firstElementChild.remove();
    text($('log-count'), state.logs.length);
    if (atBottom) container.scrollTop = container.scrollHeight;
  }
  async function openExternal(url) {
    if (!available) return;
    try { await bridge.invoke('app.openExternal', { url }); }
    catch (error) { log(extractError(error), 'error'); }
  }
  function rawSettings() {
    return { v4Pools:state.v4Pools,lockedPoolId:$('v4-lock').checked?$('v4-lock-id').value:('0x'+'0'.repeat(64)),...Object.fromEntries(settingsKeys.map(key => [key, booleanKeys.has(key) ? settingInputs.get(key).checked : settingInputs.get(key).value.trim()])), minBuyAmount:state.priceProtectionMode==='minimum'?$('min-buy-amount').value.trim():'0', priceProtectionMode:state.priceProtectionMode, v3Fees: [] };
  }
  function applySettings(settings, fromChain = false) {
    const merged = { ...defaults, ...settings };
    if (!merged.recipient && state.wallet?.address) merged.recipient = state.wallet.address;
    for (const key of settingsKeys) {
      const el = settingInputs.get(key);
      if (booleanKeys.has(key)) el.checked = merged[key] === true || merged[key] === 'true';
      else el.value = merged[key] == null ? '' : String(merged[key]);
    }
    state.priceProtectionMode=/[1-9]/.test(String(merged.minBuyAmount))?'minimum':'slippage';
    state.v3Fees = Array.isArray(merged.v3Fees) ? [...merged.v3Fees] : [...defaults.v3Fees];
    // Empty V3 fees also describe V4-only policies. Never drop saved keys or
    // silently enable V2 merely because the owner disabled the V3 candidates.
    state.v4Pools=Array.isArray(merged.v4Pools)?merged.v4Pools:[];state.lockedPoolId=merged.lockedPoolId||('0x'+'0'.repeat(64));$('v4-lock').checked=!/^0x0{64}$/.test(state.lockedPoolId);renderV4Pools();
    state.baseline = JSON.stringify(rawSettings());
    state.hasReadSettings = fromChain;
    invalidateQuote();
    resetToken('in'); resetToken('out');
    syncControls();
  }
  function dirty() { return state.baseline !== JSON.stringify(rawSettings()); }
  function validSettings() {
    const settings = rawSettings();
    settings.tokenIn = requireAddress(settings.tokenIn, '支付代币地址');
    settings.tokenOut = requireAddress(settings.tokenOut, '获得代币地址');
    settings.recipient = requireAddress(settings.recipient, '收款地址');
    if (settings.tokenIn.toLowerCase() === settings.tokenOut.toLowerCase()) throw new Error('支付代币与获得代币不能相同。');
    settings.minBuyAmount = decimal(settings.minBuyAmount, '最低买入数量');
    if(state.priceProtectionMode==='minimum'&&!/[1-9]/.test(settings.minBuyAmount))throw Error('最小得到模式要求数量大于 0。');
    settings.maxBurnPercent = percent(settings.maxBurnPercent, '最大损耗');
    settings.maxSellLossPercent = percent(settings.maxSellLossPercent, '卖出损耗上限');
    settings.testSellPercent = percent(settings.testSellPercent, '试卖比例');
    if ((settings.testSell || settings.checkBurn) && Number(settings.testSellPercent) === 0) throw new Error('开启高税拦截或同笔试卖时，试卖比例必须大于 0%。');
    return settings;
  }
  function tradeArgs() {
    validSettings();
    if (!state.hasReadSettings || dirty()) throw new Error('请先将当前设置保存到合约，或读取链上设置。');
    const amountIn = decimal($('amount-in').value, '支付数量', true);
    const slippage = state.priceProtectionMode==='minimum'?'100':quotePercent($('slippage-percent').value, '手动滑点容忍度');
    const [whole, fraction = ''] = slippage.split('.');
    return { amountIn, priceProtectionMode:state.priceProtectionMode, slippageBps: Number(whole) * 100 + Number(fraction.padEnd(2, '0')) };
  }
  function quotePercent(value,label){const p=percent(value,label);if(Number(p)>=100)throw Error('滑点须小于 100%，不能同时关闭两项价格保护。');return p;}
  function selectPriceProtection(mode){
    state.priceProtectionMode=mode;
    invalidateQuote();syncControls();
  }
  function invalidateQuote() {
    state.quote = null;
    show($('quote-empty'), true); show($('quote-result'), false); show($('simulation-result'), false);
    $('quote-candidates').replaceChildren();
  }
  function resetToken(side) {
    state.tokens[side] = null;
    state.tokenKeys[side] = null;
    text($(`token-${side}-info`), side === 'in' && $('token-in').value.toLowerCase() === WETH.toLowerCase() ? state.network+' '+state.wrappedSymbol+' · 等待查询' : '填入有效地址后自动查询名称、精度和余额');
    text($(`token-${side}-wallet`), '—'); text($(`token-${side}-contract`), '—');
    if (side === 'in') text($('amount-symbol'), $('token-in').value.toLowerCase() === WETH.toLowerCase() ? state.wrappedSymbol : '支付代币');
  }
  function tokenContextKey(side) {
    return JSON.stringify([state.rpcReady, $('rpc-url').value.trim(), state.wallet?.address?.toLowerCase(), state.contract?.address?.toLowerCase(), $(`token-${side}`).value.trim().toLowerCase()]);
  }
  function taxContextKey() {
    return JSON.stringify([state.rpcReady, $('rpc-url').value.trim(), state.wallet?.address?.toLowerCase(), state.contract?.address?.toLowerCase(), state.contract?.isOwner, rawSettings(), $('trigger-amount').value.trim()]);
  }
  function taxQueryArgs() {
    // The draft may be unsaved. Price floors are unrelated to observing transfer losses.
    const values = rawSettings();
    values.tokenIn = requireAddress(values.tokenIn, '支付代币地址');
    values.tokenOut = requireAddress(values.tokenOut, '获得代币地址');
    values.recipient = requireAddress(values.recipient, '收款地址');
    if (values.tokenIn.toLowerCase() === values.tokenOut.toLowerCase()) throw Error('支付代币与获得代币不能相同。');
    values.minBuyAmount = decimal(values.minBuyAmount, '最小得到数量', true);
    values.maxBurnPercent = percent(values.maxBurnPercent, '买入及转发损耗上限');
    values.maxSellLossPercent = percent(values.maxSellLossPercent, '卖出损耗上限');
    values.testSellPercent = percent(values.testSellPercent, '试卖比例');
    if (Number(values.testSellPercent) === 0) throw Error('税率查询需试卖，试卖比例请填写大于 0% 的数值。');
    return { ...values, amountIn: decimal($('trigger-amount').value, '本轮自动支付数量', true) };
  }
  function taxPrerequisite() {
    if (!addressValid($('token-out').value.trim()) || $('token-out').value.trim().toLowerCase() === ZERO) return '填入有效的获得代币地址后自动查询。';
    if (!state.rpcReady) return '请先连接所选网络 RPC，再自动查询。';
    if (!state.wallet) return '代币资料可查询；税率模拟需先导入管理员钱包。';
    if (!state.contract?.address) return '请先部署或加载自己的执行合约；模拟通过该合约进行。';
    if (!state.contract.isOwner) return '当前钱包不是执行合约管理员，无法进行税率模拟。';
    try { taxQueryArgs(); } catch (error) { return extractError(error); }
    return null;
  }
  function renderTaxUnknown(reason, label = '未知') {
    state.tax.status = label === '查询中' ? 'loading' : 'unavailable';
    badge($('tax-status'), label, label === '查询中' ? 'blue' : 'neutral');
    for (const id of ['tax-buy-loss', 'tax-sell-loss', 'tax-transfer-loss', 'tax-total-loss']) text($(id), '—');
    text($('tax-context'), reason);
    text($('tax-observed-at'), '未取得当前条件下的模拟结果');
  }
  function renderTaxReport(result) {
    if (!result || result.status !== 'ok') { renderTaxUnknown(result?.reason || '暂时无法测定；可能尚无可用池子、尚未开盘或节点不支持模拟。'); return; }
    state.tax.status = 'ok'; badge($('tax-status'), '模拟结果', 'blue');
    const format = value => typeof value === 'string' && /^(?:<0\.01|\d+(?:\.\d+)?)$/.test(value) ? `${value}%` : '无法测定';
    text($('tax-buy-loss'), format(result.buyLossPercent));
    text($('tax-sell-loss'), format(result.sellLossPercent));
    text($('tax-transfer-loss'), format(result.transferLossPercent));
    text($('tax-total-loss'), format(result.totalBuyLossPercent));
    const amount = result.amountIn == null ? '当前自动支付数量' : `${result.amountIn} ${state.tokens.in?.symbol || '支付代币'}`;
    text($('tax-context'), `按本轮自动支付数量 ${amount} 全额模拟买入，再试卖 ${result.probePercent ?? $('test-sell-percent').value}%。使用当前表单的收款地址与候选池设置。`);
    text($('tax-observed-at'), `区块 ${result.blockNumber ?? '未知'} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 查询；仅代表该次模拟，链上状态变化后需重新查询。`);
  }
  function scheduleTaxQuery(force = false) {
    const tax = state.tax, key = taxContextKey();
    if (force || key !== tax.key) {
      tax.key = key; tax.generation++; tax.queued = true;
      clearTimeout(tax.timer); tax.timer = null;
      renderTaxUnknown(taxPrerequisite() || '条件已更新，正在等待自动查询。');
    }
    if (!available || !tax.queued || tax.inFlight || tax.timer || state.busy || state.pendingTransaction) return;
    if (!state.rpcReady || !addressValid($('token-out').value.trim()) || $('token-out').value.trim().toLowerCase() === ZERO) return;
    // Debounce edits, coalesce in-flight changes, and cap automatic starts to one per 5 s.
    const wait = Math.max(900, tax.lastAttempt + 5000 - performance.now());
    tax.timer = setTimeout(() => { tax.timer = null; void runTaxQuery(); }, wait);
  }
  async function runTaxQuery() {
    const tax = state.tax;
    if (!tax.queued || tax.inFlight || state.busy || state.pendingTransaction) return;
    const generation = tax.generation, key = tax.key;
    tax.inFlight = true; tax.queued = false; tax.lastAttempt = performance.now();
    const current = () => generation === tax.generation && key === taxContextKey();
    try {
      for (const side of ['in', 'out']) {
        if (!current()) return;
        const address = $(`token-${side}`).value.trim();
        if (addressValid(address) && address.toLowerCase() !== ZERO && state.tokenKeys[side] !== tokenContextKey(side)) {
          try { await inspectToken(side, true); }
          catch { if (current()) text($(`token-${side}-info`), '代币资料暂时不可读；可点击查询信息重试。'); }
        }
      }
      if (!current()) return;
      const reason = taxPrerequisite();
      if (reason) { renderTaxUnknown(reason); return; }
      if (state.busy || state.pendingTransaction) { tax.queued = true; return; }
      renderTaxUnknown('后台模拟中，不签名、不广播交易，也不作为买入或触发的前置条件。', '查询中');
      const result = await invoke('tax.query', taxQueryArgs());
      if (current()) renderTaxReport(result);
    } catch (error) {
      if (current()) renderTaxUnknown(`税率暂时无法测定：${extractError(error)}`);
    } finally {
      tax.inFlight = false;
      scheduleTaxQuery();
    }
  }
  function clearContract({ keepAddress = true } = {}) {
    state.contract = null;
    state.triggerEnd = null;
    state.triggerFormContract = null;
    state.hasReadSettings = false;
    state.baseline = null;
    if (!keepAddress) $('contract-address').value = '';
    renderTrigger(null);
    renderFunds(null);
    invalidateQuote(); resetToken('in'); resetToken('out'); syncControls();
  }
  function setWallet(wallet) {
    const value = typeof wallet === 'string' ? { address: wallet, chainId: 8453 } : wallet;
    state.wallet = value && addressValid(value.address) ? { address: value.address, chainId: Number(value.chainId || 8453) } : null;
    text($('wallet-address'), state.wallet?.address || '尚未导入');
    text($('connect-wallet'), state.wallet ? briefAddress(state.wallet.address) : '导入管理员钱包');
    $('connect-wallet').title = state.wallet?.address || '导入本机管理员私钥';
    show($('disconnect-wallet'), Boolean(state.wallet));
    text($('wallet-help'), state.wallet ? '管理员已在本机载入。交易将在本机确认窗口核对后签名；锁定或退出后需重新导入。' : '私钥仅保存在本次运行内存中；锁定或退出后需重新导入。不会写入本地文件。');
    if (state.wallet && !$('recipient').value) { $('recipient').value = state.wallet.address; invalidateQuote(); }
    if (state.contract) state.contract.isOwner = Boolean(state.wallet && state.contract.owner?.toLowerCase() === state.wallet.address.toLowerCase());
    syncControls();
  }
  function syncControls() {
    $('network-select').disabled=state.busy;
    const currentWallet = state.wallet?.address?.toLowerCase();
    state.pendingTransaction = state.transactions.some(record => (record.chainId??8453)===state.chainId&&['awaitingWallet', 'pending', 'unknown'].includes(record.status)
      && (!currentWallet || !record.from || record.from.toLowerCase() === currentWallet));
    const walletReady = Boolean(state.wallet && Number(state.wallet.chainId || 8453) === state.chainId);
    const contractReady = Boolean(state.contract?.address);
    const owner = Boolean(contractReady && walletReady && state.contract.isOwner);
    const clean = state.hasReadSettings && state.contract?.settingsReadable !== false && !dirty();
    const writable = available && !state.busy;
    operationButtons.forEach(button => { button.disabled = !writable; });
    const require = (ids, condition) => ids.forEach(id => { $(id).disabled = !writable || !condition; });
    require(['v4-resolve'],!state.v4Resolving&&state.rpcReady&&$('dex').value!=='1'&&!(state.chainId===1&&$('dex').value==='2'));
    $('v4-lock').disabled=!writable||!state.v4Pools.length;
    $('v4-lock-id').disabled=!writable||!$('v4-lock').checked;
    syncV4Kind();
    require(['contract-load', 'inspect-token-in', 'inspect-token-out'], state.rpcReady);
    require(['contract-recovery-load'], state.rpcReady && walletReady);
    require(['contract-deploy'], state.rpcReady && walletReady && !state.pendingTransaction);
    require(['contract-read', 'refresh-balances'], state.rpcReady && contractReady);
    require(['contract-save', 'funds-deposit'], state.rpcReady && owner && !state.contract?.recoveryOnly && !state.pendingTransaction);
    require(['withdraw-token-button', 'withdraw-eth-button', 'withdraw-weth-button', 'withdraw-advanced-button'], state.rpcReady && owner && !state.pendingTransaction);
    require(['withdraw-input-button'], state.rpcReady && owner && !state.pendingTransaction && addressValid(state.contract?.settings?.tokenIn || state.contract?.rawSettings?.tokenIn) && (state.contract?.settings?.tokenIn || state.contract?.rawSettings?.tokenIn) !== ZERO);
    show($('withdraw-input-button'),Boolean((state.contract?.settings?.tokenIn||state.contract?.rawSettings?.tokenIn)&&![WETH.toLowerCase(),ZERO].includes((state.contract?.settings?.tokenIn||state.contract?.rawSettings?.tokenIn).toLowerCase())));
    require(['quote-compare'], state.rpcReady && owner && clean);
    require(['trade-simulate'], state.rpcReady && owner && clean && !state.contract?.executed);
    require(['trade-buy'], state.rpcReady && owner && clean && !state.contract?.executed && !state.pendingTransaction);
    require(['trigger-read', 'trigger-query'], state.rpcReady && contractReady && !state.contract?.recoveryOnly);
    require(['trigger-disarm'], state.rpcReady && owner && !state.pendingTransaction);
    require(['trigger-allow', 'trigger-revoke'], state.rpcReady && owner && !state.contract?.recoveryOnly && !state.pendingTransaction);
    require(['trigger-arm'], state.rpcReady && owner && clean && !state.contract?.executed && !state.pendingTransaction);
    require(['transaction-refresh', 'transaction-recover'], state.rpcReady);
    require(['use-wallet', 'disconnect-wallet'], walletReady);
    $('max-burn-percent').disabled = !$('check-burn').checked || state.busy;
    $('max-sell-loss-percent').disabled = !$('check-burn').checked || state.busy;
    $('test-sell-percent').disabled = !($('test-sell').checked || $('check-burn').checked) || state.busy;
    settingInputs.forEach((el, key) => { if (!['maxBurnPercent', 'maxSellLossPercent', 'testSellPercent'].includes(key)) el.disabled = state.busy; });
    $('test-sell').disabled = state.busy || $('check-burn').checked;
    text($('test-sell-mode'), $('check-burn').checked ? '高税拦截已包含同笔试卖，共用下方试卖比例。' : '仅检查本次能否卖出，不限制卖出损耗。');
    ['rpc-url', 'contract-address', 'amount-in', 'slippage-percent', 'deposit-asset', 'deposit-amount', 'withdraw-token', 'withdraw-recipient', 'withdraw-raw-amount', 'recovery-hash', 'trigger-wallets', 'trigger-address-file', 'trigger-amount', 'trigger-slippage', 'trigger-duration', 'admin-private-key'].forEach(id => { $(id).disabled = state.busy; });
    const fixedPrice=state.priceProtectionMode==='minimum';
    $('price-mode-minimum').checked=fixedPrice;$('price-mode-slippage').checked=!fixedPrice;
    ['price-mode-minimum','price-mode-slippage'].forEach(id=>{$(id).disabled=state.busy;});
    $('min-buy-amount').disabled=state.busy||!fixedPrice;
    $('trigger-slippage').disabled=state.busy||fixedPrice;
    $('slippage-percent').disabled=state.busy||fixedPrice;
    text($('price-mode-help'),`${dirty()&&state.hasReadSettings?'未保存：请保存交易设置，再重新开启本轮。':'当前选择：'}${fixedPrice?'仅最小得到；自动和手动购买均不添加滑点下限。':'仅滑点保护；保存时将链上最小得到数量清零。自动滑点在下方高级设置中调整。'}`);
    text($('auto-slippage-mode'),fixedPrice?'已关闭：当前使用最小得到数量。':'已开启：执行时新报价 × (1 − 自动滑点)。');
    text($('manual-slippage-mode'),fixedPrice?'已关闭：当前使用最小得到数量。':'已开启：按本次报价和手动滑点计算最低数量。');
    document.body.classList.toggle('busy', state.busy);
    document.body.setAttribute('aria-busy', String(state.busy));
    if (state.busy) {
      const id = state.action;
      const button = id && $(id);
      if (button) { if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent; text(button, '处理中…'); }
    } else {
      operationButtons.forEach(button => { if (button.dataset.idleLabel) { text(button, button.dataset.idleLabel); delete button.dataset.idleLabel; } });
      text($('connect-wallet'), state.wallet ? briefAddress(state.wallet.address) : '导入管理员钱包');
    }
    if (!contractReady) badge($('settings-badge'), '未读取');
    else if (state.contract?.recoveryOnly) badge($('settings-badge'), '仅提款模式', 'warning');
    else if (state.contract?.settingsReadable === false&&state.contract?.rawSettings?.tokenIn&&state.contract.rawSettings.tokenIn!==ZERO) badge($('settings-badge'), '代币资料不可读 · 可取回资金', 'warning');
    else if (!state.hasReadSettings) badge($('settings-badge'), '等待保存', 'warning');
    else if (dirty()) badge($('settings-badge'), '有未保存更改', 'warning');
    else badge($('settings-badge'), '与链上设置一致', 'success');
    if (contractReady) {
      badge($('contract-badge'), state.contract.isOwner ? '所有者已连接' : '只读模式', state.contract.isOwner ? 'success' : 'blue');
      text($('contract-owner'), `所有者：${state.contract.owner || '待确认'}`);
      badge($('execution-badge'), state.contract.executed ? '本组设置已执行' : '等待执行', state.contract.executed ? 'warning' : 'blue');
      show($('execution-badge'), !state.contract?.recoveryOnly);
    } else {
      badge($('contract-badge'), '未加载'); show($('execution-badge'), false);
      text($('contract-owner'), '部署或加载后可读取、保存设置及管理资金。');
    }
    show($('trade-lock'), Boolean(state.contract?.executed));
    show($('pending-notice'), state.pendingTransaction);
    text($('dex-context'),$('dex').value==='2'?'PancakeSwap Infinity':'Uniswap V4');
    const routeMode=settings=>settings.lockedPoolId&&!/^0x0{64}$/.test(settings.lockedPoolId)?'仅买锁定的 Pool ID '+briefAddress(settings.lockedPoolId):settings.v4Pools?.length?'比较已保存的 '+settings.v4Pools.length+' 个 V4 候选，选择最高有效报价':'请加入并保存 V4 候选池';
    text($('auto-route-summary'),`${dirty()||!state.hasReadSettings?'表单，保存后生效：':'已保存：'}${routeMode(rawSettings())}。`);
    badge($('auto-route-badge'),state.v4Pools.length?'V4 · '+state.v4Pools.length+' 个候选':'尚无候选','blue');
    const savedRoute = state.contract?.settings || null;
    text($('auto-task-route-summary'), savedRoute ? `合约在触发时按链上已保存设置执行：${routeMode(savedRoute)}。无需展开报价预览；设置本轮金额与有效期、开启本轮后，运行 Trigger 即可。` : '先保存交易设置，再设置本轮金额与有效期、开启本轮并运行 Trigger；合约会在触发时自动选池，无需手动报价。');
    const strictTrigger = state.contract?.strictTriggerLimits === true;
    show($('trigger-advanced-details'), !strictTrigger);
    text($('trigger-amount-help'), strictTrigger ? '填写大于 0 的投入金额。交易设置中保存的固定最小得到量是本轮实际到账下限。' : '本轮花多少支付代币。历史合约以 0 表示使用全部支付币余额。');
    const fullSell = ($('test-sell').checked || $('check-burn').checked) && Number($('test-sell-percent').value) === 100;
    text($('test-sell-help'), (fullSell ? '试卖 100% 会真实卖光本次买入量，卖出所得支付代币回到执行合约，收款人不会收到剩余获得代币。' : '按全额买入后，再卖出买到数量的指定比例。试卖 1% 并非只用本金 1% 先试买；成功仅证明本次路径与试卖量可卖出。') + ' 试卖量不足一个代币最小单位时，整笔交易回滚，不会自动扩大试卖比例。最多两位小数；0.1 表示 0.1%，不是 10%。');
    $('test-sell-help').classList.toggle('emphasis', fullSell);
    scheduleTaxQuery();
  }
  async function invoke(method, args = {}) {
    if (!available) throw new Error('请从桌面应用打开。');
    return bridge.invoke(method, args);
  }
  async function operate(buttonId, method, args, after) {
    if (state.busy || !available) return;
    state.busy = true; state.action = buttonId; clearNotice(); syncControls();
    if (mutationMethods.has(method) || ['rpc.connect', 'wallet.import', 'wallet.disconnect', 'contract.load', 'contract.read'].includes(method)) scheduleTaxQuery(true);
    const label = operationNames[method] || method;
    if (method === 'quote.compare') invalidateQuote();
    if (method === 'trade.simulate') show($('simulation-result'), false);
    log(`${label}开始。`);
    let returnedResult;
    try {
      const values = typeof args === 'function' ? args() : args || {};
      const result = returnedResult = await invoke(method, values);
      if(result?.contextCleared)clearContract({keepAddress:false});
      if (result?.success === false) throw new Error(result.error || result.message || `${label}未成功。`);
      if (after) await after(result);
      if(result?.refreshWarning){log(result.refreshWarning,'warning');displayNotice(result.refreshWarning,'warning');}
      return result;
    } catch (error) {
      const message = method === 'wallet.import' ? '管理员钱包导入失败，请检查私钥格式后重试。输入已清除。' : extractError(error);
      if (method === 'rpc.connect') { state.rpcReady = false; badge($('rpc-badge'), '连接失败', 'error'); }
      const confirmed=returnedResult?.status==='confirmed';
      const detail=confirmed?`${label}交易已确认，但后续界面刷新失败：${message}。请读取最新状态，不要重复提交。`:message;
      log(confirmed?detail:`${label}失败：${message}`,confirmed?'warning':'error');displayNotice(detail,confirmed?'warning':'error');
      if(confirmed){state.hasReadSettings=false;invalidateQuote();}
      if (method === 'trigger.disarm' && state.triggerEnd && state.triggerEnd.status !== 'confirmed') { state.triggerEnd.status = 'unknown'; renderTriggerEnd(); }
      if (state.rpcReady && mutationMethods.has(method)) {
        try { renderTransactions(await invoke('transaction.refresh')); }
        catch (refreshError) { log(`交易状态未能核对：${extractError(refreshError)}。若钱包已提交，请核对链上记录后再操作。`, 'warning'); }
      }
    } finally {
      if (method === 'wallet.import') $('admin-private-key').value = '';
      if (mutationMethods.has(method)) {
        try {
          const info = await invoke('app.info');applyNetwork(info);
          if (Array.isArray(info.transactions)) renderTransactions(info.transactions);
        } catch (error) {
          log(`本地交易记录未能同步：${extractError(error)}。请刷新记录核对最终状态。`, 'warning');
        }
      }
      state.busy = false; state.action = ''; syncControls();
    }
  }
  async function inspectToken(side, quiet = false) {
    const address = requireAddress($(`token-${side}`).value, side === 'in' ? '支付代币地址' : '获得代币地址');
    const contextKey = tokenContextKey(side);
    const result = await invoke('token.inspect', { address });
    if (tokenContextKey(side) !== contextKey) return;
    state.tokens[side] = result;
    state.tokenKeys[side] = contextKey;
    text($(`token-${side}-info`), `${result.symbol || '未知符号'} · ${result.name || '未返回名称'} · 精度 ${result.decimals ?? '未知'}`);
    text($(`token-${side}-wallet`), result.walletBalance ?? '—');
    text($(`token-${side}-contract`), result.contractBalance ?? '—');
    if (side === 'in') text($('amount-symbol'), result.symbol || '支付代币');
    if (!quiet) log(`已读取${side === 'in' ? '支付' : '获得'}代币：${result.symbol || briefAddress(address)}。`, 'success');
    return result;
  }
  async function refreshBalances(quiet = false) {
    const sides = ['in', 'out'].filter(side => addressValid($(`token-${side}`).value) && $(`token-${side}`).value.toLowerCase() !== ZERO);
    const results = await Promise.allSettled(sides.map(side => inspectToken(side, true)));
    results.forEach((result, index) => { if (result.status === 'rejected') log(`${sides[index] === 'in' ? '支付' : '获得'}代币余额刷新失败：${extractError(result.reason)}`, 'warning'); });
    if (!quiet && results.some(result => result.status === 'fulfilled')) log('已刷新可读取的代币余额。', 'success');
    if(state.contract){try{const loaded=await invoke('contract.read');if(state.contract?.address?.toLowerCase()===loaded.address?.toLowerCase()){state.contract.funds=loaded.funds;renderFunds(loaded.funds);}}catch(error){log(`独立资金余额读取失败：${extractError(error)}`,'warning');}}
    scheduleTaxQuery(true);
  }
  function renderFunds(funds) {
    text($('funds-owner'),state.contract?.owner||'加载合约后显示管理员地址');
    text($('funds-native'),funds?.native==null?'尚未读取 / 不可读':`${funds.native} ${state.nativeSymbol}`);
    text($('funds-weth'),funds?.weth==null?'尚未读取 / 不可读':`${funds.weth} ${state.wrappedSymbol}`);
  }
  function withdrawalArgs(token,advanced=false) {
    const recipient=advanced&&$('withdraw-recipient').value.trim()?requireAddress($('withdraw-recipient').value,'取回收款地址'):requireAddress(state.contract?.owner,'管理员地址');
    if(recipient.toLowerCase()===state.contract?.address.toLowerCase())throw Error('取回收款地址不能是执行合约自身。');
    const rawAmount=advanced?$('withdraw-raw-amount').value.trim()||'0':'0';
    if(!/^(0|[1-9]\d*)$/.test(rawAmount)||rawAmount.length>78||BigInt(rawAmount)>2n**256n-1n)throw Error('应急数量必须是 uint256 范围的最小单位整数；0 表示全部。');
    return {token:String(token).toUpperCase()==='ETH'?'ETH':requireAddress(token,'取回代币地址'),address:recipient,rawAmount};
  }
  async function withdrawalReturned(result) {
    const confirmed=transactionReturned(result,'取回资金');
    const verification=result.withdrawalVerification;
    const observed=confirmed&&verification?.status==='observed';
    const message=verification?.message||(confirmed?'取回交易已确认，但尚未核实收款地址余额增量；请核对钱包资产。':'取回交易尚未确认，不能据此认定资金已到账。');
    const panel=$('withdraw-feedback');panel.className=`notice ${observed?'success':'warning'}`;text(panel,message);
    if(verification?.receivedRaw!=null)text(panel,`${message} 收款增量：${verification.receivedRaw} 最小单位。`);
    displayNotice(message,observed?'success':'warning');
    if(confirmed) {
      await refreshBalances(true);
    }
  }
  function applyContract(result) {
    if (!result || !addressValid(result.address)) throw new Error('本地服务未返回有效的合约地址。');
    const changedContext = state.triggerFormContract !== result.address.toLowerCase();
    if (changedContext) {
      applySettings({...defaults,recipient:state.wallet?.address||''});
      $('amount-in').value='';$('slippage-percent').value='1';
      $('trigger-amount').value='0';$('trigger-slippage').value='1';$('trigger-duration').value='15';
      state.triggerClock=null;
      $('withdraw-token').value='';$('withdraw-recipient').value='';$('withdraw-raw-amount').value='0';
      show($('withdraw-feedback'),false);
    }
    state.contract = { ...result, executed: result.executed === true };
    if (state.wallet && result.owner) state.contract.isOwner = result.owner.toLowerCase() === state.wallet.address.toLowerCase();
    $('contract-address').value = result.address;
    if (result.settings) applySettings({ ...result.settings, ...(Array.isArray(result.v3Fees) ? { v3Fees: result.v3Fees } : {}) }, true);
    else {
      if (result.rawSettings?.tokenIn&&result.rawSettings.tokenIn!==ZERO) applySettings({...defaults,...result.rawSettings,minPoolInput:'',minBuyAmount:''});
      state.hasReadSettings = false; invalidateQuote();
    }
    const warnings = Array.isArray(result.metadataWarnings) ? result.metadataWarnings : [];
    show($('metadata-warning'),warnings.length>0||(result.settingsReadable===false&&result.rawSettings?.tokenIn&&result.rawSettings.tokenIn!==ZERO));
    text($('metadata-warning'), `${result.recoveryOnly?'已独立加载提款模式。':'代币资料未完整读取。'}管理员仍可取回 ${state.wrappedSymbol}、未包装 ${state.nativeSymbol} 或指定代币；交易和开启任务需先恢复可读配置。${warnings.map(value=>typeof value==='string'?value:value.message||'部分资料未读取').join('；')}`);
    renderFunds(result.funds);
    if (result.balanceIn != null) text($('token-in-contract'), result.balanceIn);
    const formContract = result.address.toLowerCase();
    const populateTriggerForm = state.triggerFormContract !== formContract && Number(result.trigger?.expiresAt) > 0;
    state.triggerFormContract = formContract;
    renderTrigger(result.trigger, populateTriggerForm);
    syncControls();
  }
  function triggerReferenceTime() {
    const clock = state.triggerClock;
    return clock ? clock.timestamp + Math.max(0, performance.now() - clock.readAt) / 1000 : Date.now() / 1000;
  }
  function renderTriggerEnd() {
    const end = state.triggerEnd, el = $('trigger-end-feedback');
    if (!end || !state.contract || end.contractAddress !== state.contract.address.toLowerCase()) { show(el, false); return; }
    const messages = {
      awaitingWallet: '正在申请结束本轮：请在本机确认窗口核对。尚未链上确认，本轮自动狙击仍可能执行。',
      pending: '结束交易已提交，等待链上确认。确认前本轮自动狙击仍可能执行；请刷新交易记录核对。',
      unknown: '结束交易状态未知，尚未确认本轮已结束。请刷新交易记录或补登哈希；本轮自动狙击仍可能执行。',
      confirmed: '本轮已结束（结束交易已链上确认）。此轮旧触发交易已失效，资金仍可取回；已成交无法撤回，所有者手动购买入口仍保留。',
      reverted: '结束交易已回滚，本轮未因此结束。请读取任务核对，自动狙击仍可能执行。',
      replaced: '结束交易已被替换，不能据此确认本轮已结束。请核对替换交易和链上任务。',
      nonceConsumed: '结束交易的 nonce 已在链上消耗，但此交易结果未核实。不能据此认定结束成功，请重新读取链上任务。',
      cancelled: '结束交易已取消，不能据此确认本轮已结束。请读取链上任务。',
    };
    el.className = `notice ${end.status === 'confirmed' ? 'success' : 'warning'}`;
    text(el, messages[end.status] || messages.unknown);
  }
  function renderTriggerClock() {
    const policy = state.contract?.trigger, clock = state.triggerClock;
    if (!policy || !clock) {
      badge($('trigger-badge'), '未读取');
      text($('trigger-countdown'), '—'); text($('trigger-deadline-at'), '尚未读取');
      text($('trigger-clock-note'), '读取任务后，以链上时间显示参考倒计时。');
      renderTriggerEnd(); return;
    }
    const age = Math.max(0, performance.now() - clock.readAt) / 1000;
    const expired = policy.armed && clock.timestamp > policy.expiresAt;
    const waiting = policy.armed && clock.timestamp < policy.notBefore;
    // Badge reflects the observed chain snapshot. A local countdown never confirms a chain transition.
    badge($('trigger-badge'), policy.executed ? '本轮已成功' : expired ? '链上时间已过期' : waiting ? '已开启 · 等待开始' : policy.armed ? '已开启 · 可触发' : '本轮未开启', policy.armed && !expired ? 'success' : 'neutral');
    text($('trigger-deadline-at'), policy.expiresAt ? new Date(policy.expiresAt * 1000).toLocaleString() : '尚未设置');
    const remaining = Math.max(0, Math.ceil(policy.expiresAt - triggerReferenceTime()));
    const duration = `${Math.floor(remaining / 3600).toString().padStart(2,'0')}:${Math.floor(remaining % 3600 / 60).toString().padStart(2,'0')}:${(remaining % 60).toString().padStart(2,'0')}`;
    text($('trigger-countdown'), policy.executed ? '本轮已成功' : !policy.armed ? '本轮未开启' : expired ? '链上时间已过期' : remaining ? duration : '预计已到截止时间');
    const freshness = age > 15 ? `链上读数已陈旧（${Math.floor(age)} 秒前），仅供参考` : `链上读数 ${Math.floor(age)} 秒前`;
    text($('trigger-clock-note'), `${freshness}。按已读取的链上时间与本机单调计时推算；倒计时归零不表示已确认链上结束，请读取任务核对。`);
    $('trigger-deadline').classList.toggle('stale', age > 15);
    renderTriggerEnd();
  }
  function renderTrigger(policy, applyForm=false) {
    if(state.contract)state.contract.trigger=policy;
    state.triggerClock = policy && Number.isFinite(Number(policy.blockTimestamp)) && Number(policy.blockTimestamp) > 0 ? { timestamp: Number(policy.blockTimestamp), readAt: performance.now() } : null;
    const list=$('trigger-wallet-status');list.replaceChildren();
    if(!policy){['trigger-epoch','trigger-policy-summary','trigger-window'].forEach(id=>text($(id),'—'));show($('price-policy-warning'),false);renderTriggerClock();return;}
    if(state.contract)state.contract.executed=policy.executed===true;
    // A newly armed epoch supersedes the status of a previous end operation.
    if (state.triggerEnd && policy.armed && BigInt(policy.epoch) > BigInt(state.triggerEnd.epoch)) state.triggerEnd = null;
    text($('trigger-epoch'),policy.epoch);
    const hasMinimum=/[1-9]/.test(String(state.contract?.settings?.minBuyAmount??state.contract?.rawSettings?.minBuyAmountRaw??'0'));
    const mode=policy.priceProtectionMode||(hasMinimum?(Number(policy.slippagePercent)<100?'combined':'minimum'):(Number(policy.slippagePercent)<100?'slippage':'none'));
    text($('trigger-policy-summary'),`${policy.amountInRaw==='0'?'全部支付代币余额':policy.amountIn==null?`${policy.amountInRaw} 最小单位（精度未读取）`:policy.amountIn+' 支付代币'} / ${mode==='minimum'?'仅最小得到（滑点关闭）':mode==='slippage'?'仅滑点 '+policy.slippagePercent+'%':mode==='combined'?'旧任务：最小得到 + 滑点 '+policy.slippagePercent+'%':'两项价格保护均关闭（旧参数）'}`);
    if(policy.strictTriggerLimits){
      const amountLabel=policy.amountInRaw==='0'?'尚未设定':(policy.amountIn??policy.amountInRaw+' 最小单位')+' 支付代币';
      text($('trigger-policy-summary'),amountLabel+' · 最低实收 '+policy.minimumReceivedRaw+' 获得币最小单位');
    }
    show($('price-policy-warning'),policy.armed&&(mode==='combined'||mode==='none'));
    text($('price-policy-warning'),'链上旧任务仍使用原参数。请结束本轮；选择一种价格保护并保存设置后，再重新开启。切换界面不会自动修改正在运行的任务。');
    text($('trigger-window'),policy.expiresAt?`${policy.notBefore?new Date(policy.notBefore*1000).toLocaleString():'立即'} → ${new Date(policy.expiresAt*1000).toLocaleString()}`:'尚未配置有效期');
    if(applyForm){const hasPriorPolicy=Number(policy.expiresAt)>0;$('trigger-amount').value=hasPriorPolicy?(policy.amountIn==null?'':policy.amountIn):(policy.strictTriggerLimits?'':'0');if(hasPriorPolicy&&Number(policy.slippagePercent)<100)$('trigger-slippage').value=policy.slippagePercent;}
    const wallets=policy.wallets||[],summary=document.createElement('div');summary.className='field-help';text(summary,`本次读取 ${wallets.length} 个公开地址，已授权 ${wallets.filter(item=>item.allowed).length} 个。链上白名单不能自动枚举，查询列表来自本机记录或本次输入。`);list.append(summary);
    wallets.forEach(item=>{const row=document.createElement('div');row.className='trigger-wallet-row';const a=document.createElement('span');a.className='mono';text(a,item.address);const flag=document.createElement('span');badge(flag,item.allowed?'已授权':'未授权',item.allowed?'success':'neutral');row.append(a,flag);list.append(row);});
    renderTriggerClock();
  }
  function publicTriggerAddresses(raw=$('trigger-wallets').value) {
    const values=String(raw).split(/[\s,;，；]+/).filter(Boolean);
    if(!values.length||values.length>500)throw Error('每批填写 1–500 个公开钱包地址，不填写私钥。');
    return [...new Set(values.map(value=>requireAddress(value,'触发钱包公开地址')))];
  }
  async function readContract(quiet = false) {
    const result = await invoke('contract.read'); applyContract(result);
    if (!quiet) log('已读取链上设置及执行状态。', 'success');
    return result;
  }
  async function readAfterTransaction() {
    try { await readContract(true); }
    catch (error) { state.hasReadSettings = false; log(`交易操作已返回，但最新链上状态读取失败：${extractError(error)}。请手动读取。`, 'warning'); }
    await refreshBalances(true);
  }
  function transactionReturned(result, label) {
    if (!result?.txHash || !/^0x[a-fA-F0-9]{64}$/.test(result.txHash)) throw new Error(`${label}未返回有效交易哈希，请查看钱包和链上状态，避免重复操作。`);
    const confirmed = result.status === 'confirmed';
    const status = ['confirmed', 'reverted', 'pending', 'unknown'].includes(result.status) ? result.status : 'unknown';
    const record = { chainId:state.chainId,hash: result.txHash, summary: label, status, from: state.wallet?.address, createdAt: new Date().toISOString() };
    renderTransactions([...state.transactions.filter(item => item.hash !== result.txHash), record]);
    log(`${label}交易${confirmed ? '已确认' : '尚未确认'}：${result.txHash}`, confirmed ? 'success' : 'warning', result.txHash);
    displayNotice(confirmed ? `${label}交易已在链上确认。` : `${label}交易待确认或状态未知。请刷新交易记录核对结果，不要重复提交。`, confirmed ? 'success' : 'warning');
    return confirmed;
  }
  function renderTransactions(records) {
    state.transactions = Array.isArray(records) ? records : [];
    const currentWallet = state.wallet?.address?.toLowerCase();
    state.pendingTransaction = state.transactions.some(record => (record.chainId??8453)===state.chainId&&['awaitingWallet', 'pending', 'unknown'].includes(record.status)
      && (!currentWallet || !record.from || record.from.toLowerCase() === currentWallet));
    if (state.triggerEnd) {
      const end = state.triggerEnd;
      const endRecord = end.hash ? state.transactions.find(record => (record.hash || record.txHash) === end.hash)
        : state.transactions.slice().reverse().find(record => record.to?.toLowerCase() === end.contractAddress && record.data?.toLowerCase().startsWith('0x47d4f659') && !end.priorRecords.has(record.hash || record.requestId || `${record.createdAt}|${record.nonce}|${record.data}`));
      if (endRecord) { end.status = endRecord.status; end.hash = endRecord.hash || endRecord.txHash || null; }
    }
    renderTriggerEnd();
    const container = $('transactions'); container.replaceChildren();
    for (const record of state.transactions.slice(-30).reverse()) {
      const row = document.createElement('div'); row.className = 'transaction-row';
      const labels = { awaitingWallet: ['等待钱包结果', 'warning'], pending: ['待确认', 'warning'], unknown: ['状态未知', 'warning'], confirmed: ['已确认', 'success'], reverted: ['已回滚', 'error'], replaced: ['已替换', 'neutral'], nonceConsumed: ['Nonce 已消耗 · 原交易结果未核实', 'warning'], cancelled: ['已取消', 'neutral'] };
      const label = labels[record.status] || [String(record.status || '状态未知'), 'warning'];
      const status = document.createElement('span'); badge(status, ...label);
      const detail = document.createElement('div'); detail.className = 'transaction-detail';
      const title = document.createElement('strong'); text(title, record.summary || '链上交易');
      const hash = document.createElement('small'); text(hash, record.hash || record.txHash || '未返回哈希'); detail.append(title, hash);
      row.append(status, detail);
      const txHash = record.hash || record.txHash;
      if (/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
        const link = document.createElement('button'); link.type = 'button'; link.className = 'text-button'; text(link, '浏览器 ↗');
        link.addEventListener('click', () => openExternal(`${explorer(state.chainId)}/tx/${txHash}`)); row.append(link);
      }
      container.append(row);
    }
    if (!state.transactions.length) { const empty = document.createElement('div'); empty.className = 'log-empty'; text(empty, '暂无已记录的交易。'); container.append(empty); }
    syncControls();
  }
  function formatFee(fee) {
    if (fee == null) return '';
    const n = Number(fee); return Number.isFinite(n) ? `${n / 10000}%` : String(fee);
  }
  function routeLabel(candidate) {
    return `${candidate?.kind || '未知路径'}${candidate?.tickSpacing ? ` · tickSpacing ${candidate.tickSpacing}` : ''}${candidate?.fee != null ? ` · ${formatFee(candidate.fee)}` : ''}`;
  }
  function renderQuote(result) {
    state.quote = result;
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    let best = result?.best;
    if (typeof best === 'number') best = candidates[best];
    else if (typeof best === 'string') best = candidates.find(candidate => candidate.pool?.toLowerCase() === best.toLowerCase() || candidate.kind === best);
    if (best && (best.eligible === false || best.kind === 'NONE' || best.pool === ZERO && !best.poolId)) best = null;
    const tbody = $('quote-candidates'); tbody.replaceChildren();
    text($('quote-best'), best ? routeLabel(best) : '暂无符合条件的路径');
    text($('quote-amount'), best ? `预计获得 ${best.amountOutFormatted ?? `${best.amountOut ?? '—'} 原始单位`} ${state.tokens.out?.symbol || ''}` : '请检查池子、余额、门槛和 RPC 返回信息。');
    candidates.forEach(candidate => {
      const isBest = best && ((candidate.poolId && best.poolId && candidate.poolId===best.poolId || candidate.pool && best.pool && candidate.pool.toLowerCase() === best.pool.toLowerCase() && candidate.fee === best.fee) || candidate === best);
      const row = document.createElement('tr'); if (isBest) row.className = 'best';
      const route = document.createElement('td'); text(route, routeLabel(candidate));
      if(candidate.poolId){const id=document.createElement('small');text(id,briefAddress(candidate.poolId));id.title='Pool ID: '+candidate.poolId+' · Manager: '+candidate.manager;route.append(id);}
      if (candidate.pool) { const pool = document.createElement('small'); text(pool, briefAddress(candidate.pool)); pool.title = candidate.pool; route.append(pool); }
      const output = document.createElement('td'); text(output, candidate.amountOutFormatted ?? (candidate.amountOut != null ? `${candidate.amountOut}（原始单位）` : '—'));
      if (!candidate.v4 && candidate.poolInputFormatted != null) { const poolInput = document.createElement('small'); text(poolInput, `池中支付币 ${candidate.poolInputFormatted}`); output.append(poolInput); }
      const status = document.createElement('td'); const pill = document.createElement('span');
      badge(pill, candidate.error ? '不可用' : candidate.eligible ? (isBest ? '较优' : '可用') : '未达门槛', candidate.error ? 'error' : candidate.eligible ? (isBest ? 'success' : 'blue') : 'warning');
      if (candidate.error) { pill.title = String(candidate.error); const detail = document.createElement('small'); text(detail, String(candidate.error).slice(0, 130)); status.append(pill, detail); }
      else status.append(pill);
      row.append(route, output, status); tbody.append(row);
    });
    if (!candidates.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 3; text(cell, '节点未返回候选路径。'); row.append(cell); tbody.append(row); }
    show($('quote-empty'), false); show($('quote-result'), true);
  }
  function summarise(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join(' · ');
    return '';
  }
  function on(id, handler) { $(id).addEventListener('click', handler); }

  async function restoreKnownContract(info) {
    if (!state.rpcReady || !state.wallet) return;
    try {
      const current = info || await invoke('app.info');
      const address = current.contractAddress || current.knownContractAddress;
      if (!addressValid(address)) return;
      // A stored public address is only a hint; the backend validates code and owner.
      applyContract(await invoke('contract.load', { address }));
      log(`已恢复当前管理员的专属合约：${address}。`, 'success');
    } catch (error) {
      clearContract({ keepAddress: false });
      const message = `管理员钱包与 RPC 已就绪，但历史合约恢复失败：${extractError(error)}。请核对后手动加载。`;
      log(message, 'warning'); displayNotice(message, 'warning');
    }
  }

  on('rpc-connect', () => operate('rpc-connect', 'rpc.connect', () => {
    const url = $('rpc-url').value.trim(); let parsed;
    try { parsed = new URL(url); } catch { throw new Error('请输入完整的 RPC 地址。'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('RPC 地址必须使用 HTTP 或 HTTPS。');
    state.rpcReady = false; badge($('rpc-badge'), '正在连接', 'blue'); return { url };
  }, async result => {
    if (Number(result.chainId) !== state.chainId) { badge($('rpc-badge'), '网络不匹配', 'error'); throw new Error(`此 RPC 返回链 ID ${result.chainId}，需要 ${state.network} ${state.chainId}。`); }
    clearContract();
    state.rpcReady = true; badge($('rpc-badge'), state.network+' 已连接', 'success');
    text($('rpc-meta'), `区块 ${result.blockNumber ?? '—'} · ${result.latencyMs ?? '—'} ms · Chain ID ${state.chainId}`);
    log(`${state.network} RPC 连接成功，区块 ${result.blockNumber ?? '—'}，延迟 ${result.latencyMs ?? '—'} ms。`, 'success');
    await restoreKnownContract();
    if (state.contract) await refreshBalances(true);
  }));
  on('connect-wallet', () => { $('wallet-import-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('admin-private-key').focus({ preventScroll: true }); });
  on('wallet-import', () => operate('wallet-import', 'wallet.import', () => {
    const privateKey = $('admin-private-key').value.trim();
    $('admin-private-key').value = '';
    return { privateKey };
  }, async result => {
    if (!result || !addressValid(result.address)) throw new Error('未取得有效的管理员地址。');
    setWallet({ address: result.address, chainId: 8453 }); clearContract({ keepAddress: false });
    log(`管理员钱包已导入：${result.address}`, 'success'); clearNotice();
    const info = await invoke('app.info');applyNetwork(info);
    if (Array.isArray(info.transactions)) renderTransactions(info.transactions);
    await restoreKnownContract(info);
    if (state.rpcReady) await refreshBalances(true);
  }));
  $('admin-private-key').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('wallet-import').disabled) { event.preventDefault(); $('wallet-import').click(); } });
  on('disconnect-wallet', () => operate('disconnect-wallet', 'wallet.disconnect', {}, () => {
    $('admin-private-key').value = ''; setWallet(null); clearContract(); state.tokens.in = null; state.tokens.out = null;
    text($('token-in-wallet'), '—'); text($('token-out-wallet'), '—'); log('管理员钱包已锁定；后续签名需重新导入。', 'info');
  }));
  on('contract-recovery-load', () => operate('contract-recovery-load', 'contract.load', () => ({ address: requireAddress($('contract-address').value, '执行合约地址'), recoveryOnly: true }), result => { applyContract(result); displayNotice('已核对管理员与执行器代码，可使用独立提款或签名结束本轮。交易配置与链上任务状态未读取，加载不会结束任务。', 'warning'); log('已独立加载提款目标：'+result.address, 'warning'); }));
  on('contract-load', () => operate('contract-load', 'contract.load', () => ({ address: requireAddress($('contract-address').value, '执行合约地址') }), async result => {
    applyContract(result); log(`已加载合约 ${result.address}。${result.isOwner ? '' : '当前为只读模式。'}`, 'success'); await refreshBalances(true);
  }));
  on('contract-deploy', () => operate('contract-deploy', 'contract.deploy', {}, async result => {
    if (!transactionReturned(result, '部署')) return;
    if (!addressValid(result.address)) {
      const deployed=result.createdContractAddress||result.receipt?.contractAddress;
      log(`部署交易已确认，但尚未加载执行合约${addressValid(deployed)?' '+deployed:''}；请核对记录后手动加载，勿重复部署。`,'warning',result.txHash);
      return;
    }
    $('contract-address').value = result.address;
    const loaded = await invoke('contract.load', { address: result.address }); applyContract(loaded);
    log(`专属合约已加载：${result.address}。请设置获得代币并保存配置。`, 'success');
    await refreshBalances(true);
  }));
  on('contract-read', () => operate('contract-read', 'contract.read', {}, async result => { applyContract(result); log('已读取链上设置及执行状态。', 'success'); await refreshBalances(true); }));
  on('contract-save', () => operate('contract-save', 'contract.save', () => ({ settings: validSettings() }), async result => {
    if (transactionReturned(result, '保存设置')) await readAfterTransaction();
  }));
  on('inspect-token-in', () => operate('inspect-token-in', 'token.inspect', () => ({ address: requireAddress($('token-in').value, '支付代币地址') }), result => {
    state.tokens.in = result; text($('token-in-info'), `${result.symbol || '未知符号'} · ${result.name || '未返回名称'} · 精度 ${result.decimals ?? '未知'}`);
    text($('token-in-wallet'), result.walletBalance); text($('token-in-contract'), result.contractBalance); text($('amount-symbol'), result.symbol || '支付代币'); log('已读取支付代币信息。', 'success');
    state.tokenKeys.in = tokenContextKey('in'); scheduleTaxQuery(true);
  }));
  on('inspect-token-out', () => operate('inspect-token-out', 'token.inspect', () => ({ address: requireAddress($('token-out').value, '获得代币地址') }), result => {
    state.tokens.out = result; text($('token-out-info'), `${result.symbol || '未知符号'} · ${result.name || '未返回名称'} · 精度 ${result.decimals ?? '未知'}`);
    text($('token-out-wallet'), result.walletBalance); text($('token-out-contract'), result.contractBalance); log('已读取获得代币信息。', 'success');
    state.tokenKeys.out = tokenContextKey('out'); scheduleTaxQuery(true);
  }));
  on('use-wallet', () => { if (state.wallet) { $('recipient').value = state.wallet.address; invalidateQuote(); syncControls(); } });
  on('quote-compare', () => operate('quote-compare', 'quote.compare', () => ({ amountIn: tradeArgs().amountIn }), result => {
    renderQuote(result); const eligible = result.best && result.best.eligible !== false && result.best.kind !== 'NONE';
    log(eligible ? '已取得并比较当前路径报价。' : '没有找到符合条件的路径。', eligible ? 'success' : 'warning');
  }));
  on('trade-simulate', () => operate('trade-simulate', 'trade.simulate', tradeArgs, result => {
    if (result.success !== true) throw new Error(result.summary || '模拟未明确返回成功，请勿据此判断交易可执行。');
    if (result.quote) renderQuote(result.quote);
    const panel = $('simulation-result'); panel.className = 'notice success';
    text(panel, `当前状态模拟通过${result.estimatedGas != null ? ` · 预计 Gas ${result.estimatedGas}` : ''}\n${summarise(result.summary) || '模拟不会提交交易。后续链上状态变化仍可能导致实际交易失败。'}`);
    log('当前节点状态下模拟通过，未提交交易。', 'success');
  }));
  on('trade-buy', () => operate('trade-buy', 'trade.buy', tradeArgs, async result => {
    if (!transactionReturned(result, '购买')) return;
    state.hasReadSettings = false; invalidateQuote(); await readAfterTransaction();
  }));
  on('funds-deposit', () => operate('funds-deposit', 'funds.deposit', () => {
    const amount = decimal($('deposit-amount').value, '充值数量');
    if (/^0+(?:\.0+)?$/.test(amount)) throw new Error('充值数量必须大于 0。');
    return { amount, asset: $('deposit-asset').value };
  }, async result => { if (transactionReturned(result, '充值')) { const v=result.depositVerification; if(v)displayNotice(v.message,v.status==='observed'?'success':'warning'); await refreshBalances(true); } }));
  on('withdraw-token-button', () => operate('withdraw-token-button', 'funds.withdraw', () => withdrawalArgs($('withdraw-token').value),withdrawalReturned));
  on('withdraw-eth-button', () => operate('withdraw-eth-button', 'funds.withdraw', () => withdrawalArgs('ETH'),withdrawalReturned));
  on('withdraw-weth-button', () => operate('withdraw-weth-button', 'funds.withdraw', () => withdrawalArgs(WETH),withdrawalReturned));
  on('withdraw-input-button', () => operate('withdraw-input-button', 'funds.withdraw', () => withdrawalArgs(state.contract?.settings?.tokenIn||state.contract?.rawSettings?.tokenIn),withdrawalReturned));
  on('withdraw-advanced-button', () => operate('withdraw-advanced-button', 'funds.withdraw', () => withdrawalArgs($('withdraw-token').value,true),withdrawalReturned));
  on('trigger-read',()=>operate('trigger-read','trigger.read',{},result=>{renderTrigger(result,true);log('已读取当前 epoch、有效期和本机已知地址的授权状态。','success');}));
  on('trigger-query',()=>operate('trigger-query','trigger.read',()=>({addresses:publicTriggerAddresses()}),result=>renderTrigger(result)));
  for(const [id,allowed] of [['trigger-allow',true],['trigger-revoke',false]])on(id,()=>operate(id,'trigger.wallets',()=>({addresses:publicTriggerAddresses(),allowed}),async result=>{if(transactionReturned(result,allowed?'授权':'撤销授权')){renderTrigger(result.trigger);await readAfterTransaction();}}));
  on('trigger-arm',()=>operate('trigger-arm','trigger.arm',()=>{
    if(!state.hasReadSettings||dirty())throw Error('请先保存交易设置，再开启本轮。');
    const rawDuration=$('trigger-duration').value.trim(),durationMinutes=Number(rawDuration);
    if(!/^\d+$/.test(rawDuration)||!Number.isSafeInteger(durationMinutes)||durationMinutes<1||durationMinutes>1440)throw Error('有效期请输入 1–1440 之间的整分钟数。');
    validSettings();
    const strict = state.contract?.strictTriggerLimits === true;
    if(strict&&state.priceProtectionMode!=='minimum')throw Error('请先保存固定的最低实收量');
    return {amountIn:decimal($('trigger-amount').value,'本轮自动支付数量',!strict),priceProtectionMode:state.priceProtectionMode,slippagePercent:state.priceProtectionMode==='minimum'?'100':quotePercent($('trigger-slippage').value,'自动滑点'),durationMinutes};
  },async result=>{if(transactionReturned(result,'开启本轮')){state.triggerEnd=null;await readAfterTransaction();}}));
  on('trigger-disarm',()=>operate('trigger-disarm','trigger.disarm',()=>{
    state.triggerEnd = {contractAddress:state.contract.address.toLowerCase(),epoch:state.contract.trigger?.epoch||'0',hash:null,status:'awaitingWallet',priorRecords:new Set(state.transactions.map(record=>record.hash||record.requestId||`${record.createdAt}|${record.nonce}|${record.data}`))};
    renderTriggerEnd(); return {};
  },async result=>{
    state.triggerEnd.hash = result.txHash || null; state.triggerEnd.status = result.status || 'unknown'; renderTriggerEnd();
    if(transactionReturned(result,'结束本轮')){if(result.trigger)renderTrigger(result.trigger);await readAfterTransaction();}
  }));
  $('trigger-address-file').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try{if(file.size>1_000_000)throw Error('地址文件过大，请保持在 1 MB 以内。');const addresses=publicTriggerAddresses(await file.text());$('trigger-wallets').value=addresses.join('\n');log(`已在本机导入 ${addresses.length} 个公开地址，尚未提交授权。`,'info');}
    catch(error){displayNotice(extractError(error),'error');}
    finally{event.target.value='';}
  });
  on('transaction-refresh', () => operate('transaction-refresh', 'transaction.refresh', {}, async records => {
    renderTransactions(records);
    log(state.pendingTransaction ? '仍有待确认或状态未知的交易，请勿重复提交。' : '交易记录已刷新。', state.pendingTransaction ? 'warning' : 'info');
    if (state.contract && !dirty()) { try { await readContract(true); await refreshBalances(true); } catch (error) { log(`刷新合约状态失败：${extractError(error)}`, 'warning'); } }
    if (!state.contract) {
      const deployment = state.transactions.slice().reverse().find(record => (record.chainId??8453)===state.chainId&&record.status === 'confirmed' && addressValid(record.contractAddress));
      if (deployment) { try { applyContract(await invoke('contract.load', { address: deployment.contractAddress })); } catch (error) { log(`读取已部署合约失败：${extractError(error)}`, 'warning'); } }
    }
  }));
  on('transaction-recover', () => operate('transaction-recover', 'transaction.recover', () => {
    const hash = $('recovery-hash').value.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('请输入完整的 0x 开头的交易哈希。');
    return { hash };
  }, async result => {
    const records = Array.isArray(result) ? result : await invoke('transaction.refresh');
    renderTransactions(records);
    log(state.pendingTransaction ? '已核对哈希，仍有交易待确认或状态未知，请勿重复提交。' : '已核对交易哈希，请查看交易记录中的链上状态。', state.pendingTransaction ? 'warning' : 'info');
    if (state.contract && !dirty()) { try { await readContract(true); await refreshBalances(true); } catch (error) { log(`刷新合约状态失败：${extractError(error)}`, 'warning'); } }
  }));
  on('refresh-balances', async () => {
    if (state.busy || !available) return;
    state.busy = true; state.action = 'refresh-balances'; syncControls();
    try { await refreshBalances(); } catch (error) { log(extractError(error), 'error'); }
    finally { state.busy = false; state.action = ''; syncControls(); }
  });
  on('clear-logs', () => { state.logs = []; $('logs').replaceChildren(); text($('log-count'), '0'); });
  settingInputs.forEach((el, key) => el.addEventListener(booleanKeys.has(key) ? 'change' : 'input', () => {
    if (key === 'tokenIn') resetToken('in'); if (key === 'tokenOut') resetToken('out');
    invalidateQuote(); syncControls();
  }));
  ['amount-in', 'slippage-percent'].forEach(id => $(id).addEventListener('input', invalidateQuote));
  $('price-mode-slippage').addEventListener('change',()=>{if($('price-mode-slippage').checked)selectPriceProtection('slippage');});
  $('price-mode-minimum').addEventListener('change',()=>{if($('price-mode-minimum').checked)selectPriceProtection('minimum');});
  $('trigger-amount').addEventListener('input', () => scheduleTaxQuery());
  $('rpc-url').addEventListener('input', () => {
    state.rpcReady = false; badge($('rpc-badge'), '地址已更改，待连接', 'warning'); invalidateQuote(); syncControls();
  });
  $('contract-address').addEventListener('input', () => {
    if (state.contract && $('contract-address').value.trim().toLowerCase() !== state.contract.address.toLowerCase()) {
      clearContract();
    }
  });

  setInterval(renderTriggerClock, 1000);
  applySettings(defaults);
  if (!available) { show($('desktop-warning'), true); syncControls(); return; }
  if (typeof bridge.onEvent === 'function') {
    bridge.onEvent(event => {
      if (!event || typeof event !== 'object') return;
      if (event.message || event.txHash) log(event.message || '交易状态已更新。', event.level || 'info', event.txHash);
      if(event.type==='context-reset'){clearContract({keepAddress:false});displayNotice(event.message,'warning');syncControls();}
      if(event.type==='settings-stale'){state.hasReadSettings=false;invalidateQuote();syncControls();}
      // Events are progress messages; the ledger comes from app.info / transaction.refresh.
      if (event.type === 'wallet-result' && !event.message) log('钱包已返回操作结果，交易状态以本地记录及链上回执为准。', 'info');
      if (event.type === 'status' && event.wallet !== undefined) setWallet(event.wallet);
      if (event.type === 'status' && event.executed !== undefined && state.contract) { state.contract.executed = Boolean(event.executed); syncControls(); }
    });
  }

  function explorer(id){return id===1?'https://etherscan.io':id===56?'https://bscscan.com':'https://basescan.org';}
  function applyNetwork(info){
    state.chainId=info.chainId??8453;state.network=info.network||'Base';state.nativeSymbol=info.nativeSymbol||'ETH';state.wrappedSymbol=info.wrappedSymbol||'WETH';
    WETH=info.addresses?.weth||WETH;defaults.tokenIn=WETH;
    $('network-select').value=String(state.chainId);if($('network-context'))text($('network-context'),state.network);
    const aero=$('dex').querySelector('option[value="1"]');if(aero){aero.disabled=state.chainId!==8453;aero.hidden=state.chainId!==8453;}
    const pancake=$('dex').querySelector('option[value="2"]');pancake.disabled=state.chainId===1;pancake.hidden=state.chainId===1;if(state.chainId===1&&$('dex').value==='2')$('dex').value='0';
    for(const el of document.querySelectorAll('[data-native-unit]'))text(el,state.nativeSymbol);
    for(const el of document.querySelectorAll('[data-wrapped-label]'))text(el,state.wrappedSymbol+' 余额');
    for(const el of document.querySelectorAll('[data-native-label]'))text(el,'未包装 '+state.nativeSymbol+' 余额');
    $('rpc-url').placeholder='https://你的 '+state.network+' RPC 节点';
    text($('withdraw-eth-button'),'取回 '+state.nativeSymbol);text($('withdraw-weth-button'),'取回 '+state.wrappedSymbol);
    const native=$('deposit-asset')?.querySelector('option[value="ETH"]');if(native)text(native,state.nativeSymbol+' → '+state.wrappedSymbol);
  }
  $('network-select').addEventListener('change',async()=>{
    if(state.busy)return;state.busy=true;syncControls();
    try{const info=await invoke('network.select',{chainId:Number($('network-select').value)});state.rpcReady=false;state.triggerEnd=null;clearContract();invalidateQuote();state.tax.generation++;clearTimeout(state.tax.timer);state.tax.key=null;
      applyNetwork(info);$('rpc-url').value=info.rpcUrl||'';$('contract-address').value='';setWallet(info.wallet);applySettings(info.settings||defaults);renderTransactions(info.transactions||[]);badge($('rpc-badge'),'网络已切换，请测试 RPC','neutral');
    }catch(e){displayNotice(extractError(e),'error');$('network-select').value=String(state.chainId);}finally{state.busy=false;syncControls();}
  });

  function syncV4Kind(){
    const selected=Number($('dex').value),supported=selected!==1&&!(state.chainId===1&&selected===2);
    for(const option of $('v4-kind').options){option.hidden=selected===0?option.value!=='10':option.value==='10';option.disabled=option.hidden||!supported;}
    if(selected===0)$('v4-kind').value='10';else if($('v4-kind').value==='10')$('v4-kind').value='11';
    text($('v4-availability'),!supported?'当前网络不支持 Infinity，请选择 Uniswap V4。':state.contract&&!state.contract.v4Supported?'请加载支持的 V4 执行合约，或部署新的 V4 执行器。':'无 Hook 直接池。最多保存 8 个；候选仅在保存后参与链上选池。');
  }
  function renderV4Pools(){
    const holder=$('v4-pools');holder.replaceChildren();const select=$('v4-lock-id'),selected=state.lockedPoolId;select.replaceChildren();
    for(const p of state.v4Pools){
      const row=document.createElement('div');row.className='v4-pool-row';const desc=document.createElement('span');
      text(desc,`${state.network || state.chainId} · ${p.kind===10?'Uniswap V4':p.kind===11?'Infinity CL':'Infinity Bin'} · ${p.poolId} · ${p.currency0} ↔ ${p.currency1} · 费率 ${p.fee/10000}% · ${p.kind===12?'binStep '+Number(BigInt(p.parameters)>>16n):'tickSpacing '+p.tickSpacing} · 无 Hook`);
      const remove=document.createElement('button');remove.type='button';remove.className='text-button';text(remove,'删除');remove.addEventListener('click',()=>{if(state.busy)return;state.v4Pools=state.v4Pools.filter(x=>x.poolId!==p.poolId);if(state.lockedPoolId===p.poolId){state.lockedPoolId='0x'+'0'.repeat(64);$('v4-lock').checked=false;}renderV4Pools();invalidateQuote();syncControls();});row.append(desc,remove);holder.append(row);
      const option=document.createElement('option');option.value=p.poolId;text(option,`${p.kind===10?'V4':p.kind===11?'CL':'Bin'} · ${p.poolId}`);select.append(option);
    }
    if(state.v4Pools.some(p=>p.poolId===selected))select.value=selected;
    if(!state.v4Pools.length)text(holder,'尚未加入 V4 候选；请查询 Pool ID 或填写完整 PoolKey。');
  }
  on('v4-resolve',async()=>{
    if(state.v4Resolving||state.busy)return;
    const context=()=>JSON.stringify([state.chainId,$('dex').value,$('v4-kind').value,$('token-in').value,$('token-out').value,$('v4-pool-id').value,$('v4-pool-key').value]);
    const key=context();state.v4Resolving=true;syncControls();
    try{
      if(state.v4Pools.length>=8)throw Error('最多保存 8 个候选池');
      let poolKey;const raw=$('v4-pool-key').value.trim();if(raw){if(raw.length>8192)throw Error('PoolKey 过长');poolKey=JSON.parse(raw);}
      const args={poolId:$('v4-pool-id').value.trim(),kind:Number($('v4-kind').value),poolKey,tokenIn:requireAddress($('token-in').value,'支付币'),tokenOut:requireAddress($('token-out').value,'获得币'),dex:Number($('dex').value)};
      const result=await invoke('pool.resolve',args);if(context()!==key){log('查询上下文已变化，旧 PoolKey 结果已丢弃。','info');return;}
      if(state.v4Pools.some(p=>p.poolId===result.poolId))throw Error('Pool ID 已在候选列表');
      const keys=['kind','currency0','currency1','hooks','fee','tickSpacing','parameters','poolId'];state.v4Pools.push(Object.fromEntries(keys.map(k=>[k,result[k]])));$('v4-pool-id').value=result.poolId;
      renderV4Pools();invalidateQuote();log(result.source==='validated-key'?'完整 PoolKey 校验通过；不代表已初始化。请保存链上设置。':'链上 PoolKey 查询通过；请保存链上设置后使用。','success');
    }catch(error){log(extractError(error),'error');}
    finally{state.v4Resolving=false;syncControls();}
  });
  $('v4-lock').addEventListener('change',()=>{state.lockedPoolId=$('v4-lock').checked?$('v4-lock-id').value:'0x'+'0'.repeat(64);invalidateQuote();syncControls();});
  $('v4-lock-id').addEventListener('change',()=>{state.lockedPoolId=$('v4-lock').checked?$('v4-lock-id').value:'0x'+'0'.repeat(64);invalidateQuote();syncControls();});
  $('dex').addEventListener('change',()=>{state.v4Pools=[];state.lockedPoolId='0x'+'0'.repeat(64);$('v4-lock').checked=false;renderV4Pools();syncControls();});
  renderV4Pools();
  $('dex').addEventListener('change',()=>{state.v3Fees=$('dex').value==='2'?[100,500,2500,10000]:[100,500,3000,10000];invalidateQuote();});

  (async () => {
    state.busy = true; syncControls();
    try {
      const info = await invoke('app.info');applyNetwork(info);
      text($('version'), info.version ? `版本 ${info.version}` : '桌面应用'); text($('footer-version'), info.version ? `v${info.version}` : '');
      if (info.rpcUrl) $('rpc-url').value = info.rpcUrl;
      setWallet(info.wallet);
      applySettings(info.settings || defaults);
      if (info.contractAddress) $('contract-address').value = info.contractAddress;
      if (Array.isArray(info.transactions)) renderTransactions(info.transactions);
      log('本地执行服务已就绪。导入管理员钱包后，可在本机确认并签名交易。', 'info');
      if(info.rpcConnected){state.rpcReady=true;badge($('rpc-badge'),state.network+' 已连接','success');if(info.contract)applyContract(info.contract);}
      if (info.rpcUrl && !info.rpcConnected && !info.localTaskActive) {
        try {
          const rpc = await invoke('rpc.connect', { url: info.rpcUrl });
          if (Number(rpc.chainId) !== state.chainId) throw new Error('保存的 RPC 不属于所选主网。');
          state.rpcReady = true; badge($('rpc-badge'), state.network+' 已连接', 'success');
          text($('rpc-meta'), `区块 ${rpc.blockNumber ?? '—'} · ${rpc.latencyMs ?? '—'} ms · Chain ID ${state.chainId}`);
          log('已连接保存的 '+state.network+' RPC。', 'success');
          if (addressValid(info.contractAddress)) {
            try { applyContract(await invoke('contract.load', { address: info.contractAddress })); await refreshBalances(true); }
            catch (error) { log(`保存的合约尚未加载：${extractError(error)}`, 'warning'); }
          }
        } catch (error) { badge($('rpc-badge'), '连接失败', 'error'); log(`保存的 RPC 连接失败：${extractError(error)}`, 'warning'); }
      }
    } catch (error) { displayNotice(`本地执行服务初始化失败：${extractError(error)}`, 'error'); log(extractError(error), 'error'); }
    finally { state.busy = false; state.initialised = true; syncControls(); }
  })();
})();

document.getElementById('show-trigger').addEventListener('click',()=>window.desktop.invoke('app.page',{page:'runner'}).catch(console.error));

