// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {V4Types, IUniV4Quoter, IInfinityQuoter} from "./v4/V4Types.sol";
import {V4NetworkConfig} from "./v4/V4NetworkConfig.sol";

/// @notice Stores a single executor's approved, hook-free direct pools and constructs typed router inputs.
/// @dev The helper holds no operating balances or approvals. Only its creating executor may configure it.
contract V4QuoteHelper {
    error InvalidV4Pool();
    error V4OnlyController();

    uint256 private constant MAX_SWAP_AMOUNT = uint128(type(int128).max);
    uint256 private constant MAX_QUOTE_GAS = 1_000_000;

    address public immutable controller;
    address private immutable _wrapped;
    address[12] private _dependencies;
    V4Types.Pool[] private _pools;
    bytes32 private _lockId;
    address private _input;
    address private _output;

    constructor(address wrapped) {
        if (wrapped != V4NetworkConfig.wrappedNative() || wrapped.code.length == 0) revert InvalidV4Pool();
        address[12] memory deps = V4NetworkConfig.dependencies();
        for (uint256 i; i < deps.length; ++i) {
            if (deps[i] != address(0) && deps[i].code.length == 0) revert InvalidV4Pool();
        }
        _wrapped = wrapped;
        _dependencies = deps;
        controller = msg.sender;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert V4OnlyController();
        _;
    }

    function getV4Config() external view returns (address[12] memory) {
        return _dependencies;
    }

    function getV4Policy() external view returns (V4Types.Pool[] memory, bytes32) {
        return (_pools, _lockId);
    }

    function hasV4() external view returns (bool) {
        return _pools.length != 0;
    }

    function v4Locked() external view returns (bool) {
        return _lockId != bytes32(0);
    }

    function clearV4() external onlyController {
        delete _pools;
        delete _lockId;
        delete _input;
        delete _output;
    }

    function configureV4(
        V4Types.Pool[] calldata pools,
        bytes32 lockId,
        uint8 venue,
        address input,
        address output
    ) external onlyController {
        if (pools.length == 0 || pools.length > 8 || input == output || input == address(0) || output == address(0)) {
            revert InvalidV4Pool();
        }

        delete _pools;
        bool foundLock = lockId == bytes32(0);
        for (uint256 i; i < pools.length; ++i) {
            V4Types.Pool calldata pool = pools[i];
            _validatePool(pool, venue, input, output);
            for (uint256 j; j < i; ++j) {
                if (pools[j].poolId == pool.poolId) revert InvalidV4Pool();
            }
            if (pool.poolId == lockId) foundLock = true;
            _pools.push(pool);
        }
        if (!foundLock) revert InvalidV4Pool();
        _lockId = lockId;
        _input = input;
        _output = output;
    }

    function quote(address tokenIn, uint256 amount)
        external
        returns (V4Types.Route memory best, V4Types.Route[] memory routes)
    {
        if (tokenIn != _input || tokenIn == address(0)) revert InvalidV4Pool();
        routes = new V4Types.Route[](_pools.length);
        for (uint256 i; i < _pools.length; ++i) {
            V4Types.Pool memory pool = _pools[i];
            address manager = _manager(pool.kind);
            uint256 amountOut = _quoteCandidate(pool, manager, tokenIn, amount);
            V4Types.Route memory candidate =
                V4Types.Route(pool.kind, pool.fee, address(0), amountOut, 0, pool.poolId, manager, uint8(i));
            routes[i] = candidate;
            if (amountOut > best.amountOut) best = candidate;
        }
    }

    function quoteV4(address input, uint256 amount)
        external
        returns (
            uint8[] memory kinds,
            bytes32[] memory ids,
            address[] memory managers,
            uint256[] memory outputs,
            uint24[] memory fees
        )
    {
        if (input != _input || input == address(0)) revert InvalidV4Pool();
        uint256 count = _pools.length;
        kinds = new uint8[](count);
        ids = new bytes32[](count);
        managers = new address[](count);
        outputs = new uint256[](count);
        fees = new uint24[](count);
        for (uint256 i; i < count; ++i) {
            V4Types.Pool memory pool = _pools[i];
            address manager = _manager(pool.kind);
            kinds[i] = pool.kind;
            ids[i] = pool.poolId;
            managers[i] = manager;
            outputs[i] = _quoteCandidate(pool, manager, input, amount);
            fees[i] = pool.fee;
        }
    }

    function reverseV4(uint8 index, bytes32 id, address input, uint256 amount) external returns (uint256) {
        if (input != _output) revert InvalidV4Pool();
        V4Types.Pool memory pool = _candidate(index, id);
        return _quoteCandidate(pool, _manager(pool.kind), input, amount);
    }

    function encodeV4(uint8 index, bytes32 id, address input, address output, uint256 amount, uint256 minimum)
        external
        view
        returns (
            address router,
            address permit2,
            bool nativeInput,
            bool nativeOutput,
            bytes memory commands,
            bytes[] memory inputs
        )
    {
        if (amount == 0 || amount > MAX_SWAP_AMOUNT || minimum > MAX_SWAP_AMOUNT) revert InvalidV4Pool();
        if (!(input == _input && output == _output) && !(input == _output && output == _input)) {
            revert InvalidV4Pool();
        }
        V4Types.Pool memory pool = _candidate(index, id);
        bool zeroForOne = _asset(pool.currency0) == input;
        address currencyIn = zeroForOne ? pool.currency0 : pool.currency1;
        address currencyOut = zeroForOne ? pool.currency1 : pool.currency0;
        nativeInput = currencyIn == address(0);
        nativeOutput = currencyOut == address(0);

        bytes[] memory params = new bytes[](3);
        if (pool.kind == V4Types.UNISWAP) {
            router = _dependencies[1];
            permit2 = _dependencies[4];
            // Universal Router 2.1.2 includes a per-hop field. The explicit amount floor governs this single hop.
            params[0] = abi.encode(
                V4Types.UniSwap(V4Types.uniKey(pool), zeroForOne, uint128(amount), uint128(minimum), 0, "")
            );
        } else {
            router = _dependencies[8];
            permit2 = _dependencies[11];
            params[0] = abi.encode(
                V4Types.InfinitySwap(
                    V4Types.infinityKey(pool, _manager(pool.kind)), zeroForOne, uint128(amount), uint128(minimum), ""
                )
            );
        }
        params[1] = abi.encode(currencyIn, amount);
        params[2] = abi.encode(currencyOut, minimum);

        uint8 swapAction = pool.kind == V4Types.INFINITY_BIN ? 0x1c : 0x06;
        bytes memory actions = abi.encodePacked(swapAction, uint8(0x0c), uint8(0x0f));
        commands = hex"10";
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    function _validatePool(V4Types.Pool calldata pool, uint8 venue, address input, address output) private view {
        if (pool.hooks != address(0) || pool.currency0 >= pool.currency1 || pool.fee >= 1_000_000) {
            revert InvalidV4Pool();
        }
        address asset0 = _asset(pool.currency0);
        address asset1 = _asset(pool.currency1);
        if (!(asset0 == input && asset1 == output) && !(asset0 == output && asset1 == input)) {
            revert InvalidV4Pool();
        }

        address manager = _manager(pool.kind);
        if (manager == address(0)) revert InvalidV4Pool();
        bytes32 id;
        if (pool.kind == V4Types.UNISWAP) {
            if (venue != 0 || pool.parameters != bytes32(0) || pool.tickSpacing <= 0 || pool.tickSpacing > 32767) {
                revert InvalidV4Pool();
            }
            id = keccak256(abi.encode(V4Types.uniKey(pool)));
        } else {
            if (venue != 2) revert InvalidV4Pool();
            uint256 bits = uint256(pool.parameters);
            uint256 step = bits >> 16;
            if (uint16(bits) != 0 || step == 0) revert InvalidV4Pool();
            if (pool.kind == V4Types.INFINITY_CL) {
                if (step > 32767 || pool.tickSpacing <= 0 || uint256(uint24(pool.tickSpacing)) != step) {
                    revert InvalidV4Pool();
                }
            } else if (step > 100 || pool.tickSpacing != 0 || pool.fee > 100_000) {
                revert InvalidV4Pool();
            }
            id = keccak256(abi.encode(V4Types.infinityKey(pool, manager)));
        }
        if (id != pool.poolId) revert InvalidV4Pool();
    }

    function _candidate(uint8 index, bytes32 id) private view returns (V4Types.Pool memory pool) {
        if (index >= _pools.length || (_lockId != bytes32(0) && id != _lockId)) revert InvalidV4Pool();
        pool = _pools[index];
        if (pool.poolId != id) revert InvalidV4Pool();
    }

    function _quoteCandidate(V4Types.Pool memory pool, address manager, address input, uint256 amount)
        private
        returns (uint256 out)
    {
        if (amount == 0 || amount > MAX_SWAP_AMOUNT || (_lockId != bytes32(0) && _lockId != pool.poolId)) {
            return 0;
        }
        bool zeroForOne = _asset(pool.currency0) == input;
        if (pool.kind == V4Types.UNISWAP) {
            V4Types.UniQuote memory params = V4Types.UniQuote(V4Types.uniKey(pool), zeroForOne, uint128(amount), "");
            try IUniV4Quoter(_dependencies[2]).quoteExactInputSingle{gas: MAX_QUOTE_GAS}(params)
                returns (uint256 received, uint256)
            {
                out = received;
            } catch {}
        } else {
            address quoter = _dependencies[pool.kind == V4Types.INFINITY_CL ? 9 : 10];
            V4Types.InfinityQuote memory params =
                V4Types.InfinityQuote(V4Types.infinityKey(pool, manager), zeroForOne, uint128(amount), "");
            try IInfinityQuoter(quoter).quoteExactInputSingle{gas: MAX_QUOTE_GAS}(params)
                returns (uint256 received, uint256)
            {
                out = received;
            } catch {}
        }
        if (out > MAX_SWAP_AMOUNT) return 0;
    }

    function _asset(address currency) private view returns (address) {
        return currency == address(0) ? _wrapped : currency;
    }

    function _manager(uint8 kind) private view returns (address) {
        if (kind == V4Types.UNISWAP) return _dependencies[0];
        if (kind == V4Types.INFINITY_CL) return _dependencies[6];
        if (kind == V4Types.INFINITY_BIN) return _dependencies[7];
        revert InvalidV4Pool();
    }
}
