const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const deliverables = ["V4SwapExecutor", "V4QuoteHelper"];

function collect(directory, sources) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect(fullPath, sources);
        } else if (entry.isFile() && entry.name.endsWith(".sol")) {
            const name = path.relative(root, fullPath).split(path.sep).join("/");
            sources[name] = { content: fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n") };
        }
    }
}

function compile() {
    const sources = {};
    collect(path.join(root, "contracts"), sources);

    const input = {
        language: "Solidity",
        sources,
        settings: {
            evmVersion: "paris",
            viaIR: true,
            optimizer: { enabled: true, runs: 200 },
            metadata: { useLiteralContent: true },
            outputSelection: {
                "*": {
                    "*": ["abi", "metadata", "evm.bytecode.object", "evm.deployedBytecode.object",
                        "evm.deployedBytecode.immutableReferences"]
                }
            }
        }
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (output.errors || []).filter(item => item.severity === "error");
    if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join("\n"));

    const artifacts = {};
    for (const [sourceName, contracts] of Object.entries(output.contracts)) {
        for (const [contractName, contract] of Object.entries(contracts)) {
            const runtime = contract.evm.deployedBytecode;
            if (artifacts[contractName]) throw new Error("Duplicate contract name: " + contractName);
            artifacts[contractName] = {
                contractName,
                sourceName,
                compiler: solc.version(),
                abi: contract.abi,
                bytecode: "0x" + contract.evm.bytecode.object,
                deployedBytecode: "0x" + runtime.object,
                immutableReferences: runtime.immutableReferences,
                metadata: JSON.parse(contract.metadata)
            };
        }
    }
    return artifacts;
}

if (require.main === module) {
    const artifacts = compile();
    const destination = path.join(root, "artifacts");
    for (const name of deliverables) {
        const artifact = artifacts[name];
        if (!artifact || artifact.bytecode === "0x") throw new Error("Missing deployable contract: " + name);
        const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
        const initBytes = (artifact.bytecode.length - 2) / 2;
        if (runtimeBytes > 24576 || initBytes > 49152) {
            throw new Error(name + " exceeds EVM deployment size limits");
        }
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const name of deliverables) {
        const artifact = artifacts[name];
        fs.writeFileSync(path.join(destination, "Rebuilt" + name + ".json"), JSON.stringify(artifact, null, 2) + "\n");
        const size = (artifact.deployedBytecode.length - 2) / 2;
        console.log(name + " runtime " + size + " bytes");
    }
}
module.exports = { compile, deliverables };
