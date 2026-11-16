# V4 Trading Desktop

面向 Uniswap V4 和 PancakeSwap Infinity 的 Electron 交易工作台。 当前版本 1.0.5。

交易页默认部署重写版 V4 执行器。交易页和触发页共享执行器识别规则及配套报价合约验证，历史 V4 执行器仍可读取和取回资金。

## 开发与构建

使用 Node.js 24、npm 和 Electron 44.5.1。

```powershell
npm ci
npm test
npm run smoke
npm run dist:win
```

源码位于 `src/` 和 `renderer/`。Windows x64 安装包生成在 `dist/`。启动检查使用独立的测试配置。

## 合约源码与兼容性

本工程包含对应执行器及报价合约的 Solidity 源码。运行 `npm run build:contracts` 可用 Solidity 0.8.38 重编译 `artifacts/Rebuilt*.json`。初版重写源码见 [合约提交 4161a3c](https://github.com/wwin57519-lgtm/multichain-desktop-contracts/tree/4161a3c70b059457596ffc35b2060808581d7a1b)

执行器重写版 0.2.0 要求自动触发前设置正数投入金额和固定最低实收。执行器在兑换、试卖和转账完成后核对收款地址实际到账。本应用保留对 0.1.0 及历史合约的识别和原有操作。部署 0.2.0 会生成独立地址。

## 许可

项目采用 [MIT 许可证](LICENSE)。第三方许可和归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
