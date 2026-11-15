const { runtimeMatches } = require("./dex.cjs");

const rebuiltArtifact = require("../artifacts/RebuiltV4SwapExecutor.json");
const rebuiltHelper = require("../artifacts/RebuiltV4QuoteHelper.json");
const historicalHelpers = [require("../artifacts/V4QuoteHelper.json")];

const versions = [
  { version: "重写版 0.1.0", artifact: rebuiltArtifact, helpers: [rebuiltHelper] },
  { version: "1.0.0", artifact: require("../artifacts/V4SwapExecutor.json"), helpers: historicalHelpers }
];

function identifyExecutor(code, override) {
  const known = versions.find(entry => runtimeMatches(code, entry.artifact));
  if (known) return known;
  if (override && runtimeMatches(code, override)) {
    return { version: "自定义", artifact: override, helpers: historicalHelpers };
  }
  return null;
}

module.exports = { rebuiltArtifact, identifyExecutor };
