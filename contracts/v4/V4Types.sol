// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @dev The desktop stores one canonical key per candidate and switches by kind.
library V4Types {
    uint8 internal constant UNISWAP = 10;
    uint8 internal constant INFINITY_CL = 11;
    uint8 internal constant INFINITY_BIN = 12;

    struct Pool {
        uint8 kind;
        address currency0;
        address currency1;
        address hooks;
        uint24 fee;
        int24 tickSpacing;
        bytes32 parameters;
        bytes32 poolId;
    }

    struct Route {
        uint8 kind;
        uint24 fee;
        address pool;
        uint256 amountOut;
        uint256 poolInput;
        bytes32 poolId;
        address manager;
        uint8 candidateIndex;
    }

    struct UniKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct InfinityKey {
        address currency0;
        address currency1;
        address hooks;
        address poolManager;
        uint24 fee;
        bytes32 parameters;
    }

    struct UniQuote {
        UniKey key;
        bool zeroForOne;
        uint128 amount;
        bytes hookData;
    }

    struct InfinityQuote {
        InfinityKey key;
        bool zeroForOne;
        uint128 amount;
        bytes hookData;
    }

    struct UniSwap {
        UniKey key;
        bool zeroForOne;
        uint128 amount;
        uint128 minimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct InfinitySwap {
        InfinityKey key;
        bool zeroForOne;
        uint128 amount;
        uint128 minimum;
        bytes hookData;
    }

    function uniKey(Pool memory pool) internal pure returns (UniKey memory) {
        return UniKey(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks);
    }

    function infinityKey(Pool memory pool, address manager) internal pure returns (InfinityKey memory) {
        return InfinityKey(pool.currency0, pool.currency1, pool.hooks, manager, pool.fee, pool.parameters);
    }
}

interface IUniV4Quoter {
    function quoteExactInputSingle(V4Types.UniQuote calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

interface IInfinityQuoter {
    function quoteExactInputSingle(V4Types.InfinityQuote calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

interface IV4UniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IV4Permit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
