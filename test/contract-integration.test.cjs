const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, getAddress, ZeroAddress } = require("ethers");
const { Engine } = require("../src/engine.cjs");
const { rebuiltArtifact, identifyExecutor } = require("../src/contract-artifacts.cjs");
const { Engine: Runner } = require("../src/runner/engine.cjs");
const oldExecutor = require("../artifacts/V4SwapExecutor.json");
const oldHelper = require("../artifacts/V4QuoteHelper.json");
const newHelper = require("../artifacts/RebuiltV4QuoteHelper.json");
const target = getAddress("0x" + "11".repeat(20));
const helper = getAddress("0x" + "22".repeat(20));
const owner = getAddress("0x" + "33".repeat(20));

function deployedCode(artifact) {
  const bytes = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
  for (const references of Object.values(artifact.immutableReferences || {})) {
    for (const { start, length } of references) bytes.fill(19, start, start + length);
  }
  return "0x" + bytes.toString("hex");
}

function makeEngine(EngineClass = Engine) {
  return new EngineClass({ vault: { list: () => [], info: () => ({ locked: true }) } });
}

function fixture(engine, executorArtifact, helperArtifact, changes = {}) {
  const chain = engine.chain;
  const addresses = chain.addresses;
  const expected = [addresses.weth, addresses.v2Factory, addresses.v2Router,
    addresses.v3Factory, addresses.v3Router, addresses.quoter];
  const aero = chain.aerodrome?.config || Array(11).fill(ZeroAddress);
  const executorValues = {
    owner: [owner], networkChainId: [chain.chainId], wrappedNative: [addresses.weth],
    v2Factory: [addresses.v2Factory], v2Router: [addresses.v2Router],
    v3Factory: [addresses.v3Factory], v3Router: [addresses.v3Router],
    quoterV2: [addresses.quoter], getAerodromeConfig: [aero],
    getPancakeConfig: [chain.pancake?.config],
    aerodromeQuoteHelper: [helper], quoteHelper: [helper],
    ...changes.executor
  };
  const helperValues = {
    getConfig: [aero], getNetworkConfig: [expected, aero, chain.pancake?.config],
    getV4Config: [chain.v4?.config], controller: [target],
    ...changes.helper
  };
  const executorInterface = new Interface(executorArtifact.abi);
  const helperInterface = new Interface(helperArtifact.abi);
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(chain.chainId) }),
    async getCode(address) {
      if (address === target) return changes.code || deployedCode(executorArtifact);
      if (address === helper) return deployedCode(helperArtifact);
      return "0x6000";
    },
    async call({ to, data }) {
      const [iface, values] = to === target ? [executorInterface, executorValues] : [helperInterface, helperValues];
      const parsed = iface.parseTransaction({ data });
      assert.ok(parsed && Object.hasOwn(values, parsed.name), "Unexpected test RPC call");
      return iface.encodeFunctionResult(parsed.fragment, values[parsed.name]);
    }
  };
  if (typeof engine.contractAt === "function") {
    engine.pool = {
      primary: provider,
      read(method, address) {
        assert.equal(method, "getCode");
        return provider.getCode(address);
      }
    };
  } else {
    engine.provider = provider;
  }
  return provider;
}

function load(engine, options) {
  if (typeof engine.contractAt === "function") return engine.contractAt(target);
  return engine.validateContract(target, options);
}

test("runtime verification recognizes exact historical executors and masks immutable bytes", () => {
  const versions = [["1.0.0", "V4SwapExecutor"]];
  for (const [version, name] of versions) {
    const artifact = require("../artifacts/" + name + ".json");
    assert.equal(identifyExecutor(deployedCode(artifact)).version, version);
  }
  const rebuilt = identifyExecutor(deployedCode(rebuiltArtifact));
  assert.equal(rebuilt.version, "重写版 0.1.0");
  assert.strictEqual(rebuilt.helpers[0], newHelper);
  const code = deployedCode(rebuiltArtifact);
  const changed = "0x" + (code.slice(2, 4) === "00" ? "01" : "00") + code.slice(4);
  assert.equal(identifyExecutor(changed), null);
});

test("contract loading accepts both releases and enforces their quote helpers", async (t) => {
  for (const EngineClass of [Engine, Runner]) {
    const engine = makeEngine(EngineClass);
    t.after(() => clearInterval(engine.pollTimer));
    fixture(engine, rebuiltArtifact, newHelper);
    const current = await load(engine);
    assert.equal(current.verifiedVersion, "重写版 0.1.0");
    assert.equal(await current.owner(), owner);

    fixture(engine, oldExecutor, oldHelper);
    assert.equal((await load(engine)).verifiedVersion, "1.0.0");

    fixture(engine, rebuiltArtifact, oldHelper);
    await assert.rejects(() => load(engine), /报价辅助合约代码|辅助合约代码不符/);
    fixture(engine, oldExecutor, oldHelper, { executor: { networkChainId: [97] } });
    await assert.rejects(() => load(engine), /链标识|执行器网络/);
  }
});

test("deployment builds the new creation transaction without submitting it", async () => {
  const engine = makeEngine();
  assert.strictEqual(engine.artifact, rebuiltArtifact);
  fixture(engine, rebuiltArtifact, newHelper);
  engine.assertWallet = async () => owner;
  let draft;
  engine.sendTransaction = async (transaction) => {
    draft = transaction;
    return { status: "pending" };
  };
  await engine.deploy();
  assert.ok(draft?.data.startsWith(rebuiltArtifact.bytecode));
  const iface = new Interface(rebuiltArtifact.abi);
  const encoded = draft.data.slice(rebuiltArtifact.bytecode.length);
  const { AbiCoder } = require("ethers");
  const decoded = AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs, "0x" + encoded);
  assert.equal(decoded[0], owner);
});

test("recovery recognizes verified executors despite a mismatched helper and checks the wrapped asset", async () => {
  const engine = makeEngine();
  fixture(engine, rebuiltArtifact, oldHelper);
  const contract = await load(engine, { recoveryOnly: true });
  assert.equal(contract.verifiedVersion, "重写版 0.1.0");
  fixture(engine, oldExecutor, oldHelper, { executor: { wrappedNative: [ZeroAddress] } });
  await assert.rejects(() => load(engine, { recoveryOnly: true }), /包装币配置不符/);
});
