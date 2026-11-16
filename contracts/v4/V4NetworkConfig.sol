// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @dev Fixed dependency order retained from the desktop V4 workbench.
library V4NetworkConfig {
    error InvalidV4Pool();

    function wrappedNative() internal view returns (address) {
        if (block.chainid == 1) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        if (block.chainid == 56) return 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
        if (block.chainid == 8453) return 0x4200000000000000000000000000000000000006;
        revert InvalidV4Pool();
    }

    /// @return values Uniswap manager, router, quoter, state view and Permit2, followed
    /// by Infinity vault, CL manager, Bin manager, router, CL quoter, Bin quoter and Permit2.
    function dependencies() internal view returns (address[12] memory values) {
        if (block.chainid == 1) {
            values[0] = 0x000000000004444c5dc75cB358380D2e3dE08A90;
            values[1] = 0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85;
            values[2] = 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203;
            values[3] = 0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227;
            values[4] = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
            return values;
        }
        if (block.chainid == 56) {
            values[0] = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
            values[1] = 0xDc264714F68d84CF29BC605589405E78bDBE7C9f;
            values[2] = 0x9F75dD27D6664c475B90e105573E550ff69437B0;
            values[3] = 0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4;
            values[4] = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
            values[5] = 0x238a358808379702088667322f80aC48bAd5e6c4;
            values[6] = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
            values[7] = 0xC697d2898e0D09264376196696c51D7aBbbAA4a9;
            values[8] = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;
            values[9] = 0xd0737C9762912dD34c3271197E362Aa736Df0926;
            values[10] = 0xC631f4B0Fc2Dd68AD45f74B2942628db117dD359;
            values[11] = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;
            return values;
        }
        if (block.chainid == 8453) {
            values[0] = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
            values[1] = 0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40;
            values[2] = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
            values[3] = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
            values[4] = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
            values[5] = 0x238a358808379702088667322f80aC48bAd5e6c4;
            values[6] = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
            values[7] = 0xC697d2898e0D09264376196696c51D7aBbbAA4a9;
            values[8] = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;
            values[9] = 0xd0737C9762912dD34c3271197E362Aa736Df0926;
            values[10] = 0xC631f4B0Fc2Dd68AD45f74B2942628db117dD359;
            values[11] = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;
            return values;
        }
        revert InvalidV4Pool();
    }
}
