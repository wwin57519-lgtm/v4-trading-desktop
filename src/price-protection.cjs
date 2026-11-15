'use strict';
// The deployed ABI has two floors. Encode exactly one without changing the
// contract: a fixed floor disables the quote floor with 10_000 slippage bps.
function mode(value, hasMinimum) {
  if (value === undefined) return hasMinimum ? 'minimum' : 'slippage';
  if (value !== 'minimum' && value !== 'slippage') throw Error('价格保护方式无效');
  return value;
}
function executionMode(value, minimum) {
  const hasMinimum = BigInt(minimum ?? 0) > 0n, selected = mode(value, hasMinimum);
  if (selected === 'minimum' && !hasMinimum) throw Error('请先保存大于 0 的最小得到数量');
  if (selected === 'slippage' && hasMinimum) throw Error('请先保存自动滑点模式，清除链上的最小得到限制');
  return selected;
}
function quoteBps(value) {
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10000) throw Error('滑点必须大于等于 0% 且小于 100%，不能同时关闭两项价格保护');
  return bps;
}
module.exports = { mode, executionMode, quoteBps };
