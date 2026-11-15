// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {TradeCore} from "./common/TradeCore.sol";
import {IWETH, TokenOps} from "./common/TokenOps.sol";
import {V4QuoteHelper} from "./V4QuoteHelper.sol";
import {V4NetworkConfig} from "./v4/V4NetworkConfig.sol";
import {V4Types, IV4UniversalRouter, IV4Permit2} from "./v4/V4Types.sol";

/// @notice Owner-funded, single-round Uniswap V4 and PancakeSwap Infinity executor.
contract V4SwapExecutor is TradeCore {
    error V4SwapFailed();

    event DexPolicyUpdated(uint8 dex);

    uint256 private constant MAX_SWAP_AMOUNT = uint128(type(int128).max);

    struct Settings {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint8 priceMode;
        uint256 minBuyAmount;
        bool checkBurn;
        uint16 maxBurnBps;
        bool testSell;
        uint16 testSellBps;
    }

    V4QuoteHelper public immutable quoteHelper;
    uint8 public dex;
    Settings private _settings;

    constructor(address initialOwner) TradeCore(initialOwner, V4NetworkConfig.wrappedNative()) {
        quoteHelper = new V4QuoteHelper(wrappedNative);
    }

    function getSettings() external view returns (Settings memory) {
        return _settings;
    }

    function getDexPolicy() external view returns (uint8 venue, uint32[] memory) {
        return (dex, new uint32[](0));
    }

    function getV4Policy() external view returns (V4Types.Pool[] memory, bytes32) {
        return quoteHelper.getV4Policy();
    }

    function setSettingsAndV4(
        Settings calldata next,
        uint16 sellLossBps,
        uint8 venue,
        V4Types.Pool[] calldata pools,
        bytes32 lockId
    ) external onlyOwner nonReentrant {
        _checkRecipient(next.recipient);
        if (
            next.tokenIn == next.tokenOut || next.tokenIn.code.length == 0 || next.tokenOut.code.length == 0
                || next.maxBurnBps > BPS || next.testSellBps > BPS || next.minBuyAmount > MAX_SWAP_AMOUNT
                || ((next.checkBurn || next.testSell) && next.testSellBps == 0)
        ) {
            revert InvalidSettings();
        }
        if (next.priceMode > 1 || (next.priceMode == 1) != (next.minBuyAmount != 0)) {
            revert InvalidPriceProtection();
        }

        quoteHelper.configureV4(pools, lockId, venue, next.tokenIn, next.tokenOut);
        _settings = next;
        dex = venue;
        _afterSettings(sellLossBps);
        emit SettingsUpdated(next.tokenIn, next.tokenOut, next.recipient);
        emit DexPolicyUpdated(venue);
    }

    function quoteBest(uint256 amountIn)
        external
        returns (V4Types.Route memory best, V4Types.Route[] memory candidates)
    {
        if (_settings.tokenIn == address(0)) revert NotConfigured();
        return quoteHelper.quote(_settings.tokenIn, amountIn);
    }

    /// @notice Simulates the current route, then always rolls back the trial swaps and allowance changes.
    function simulateTaxSaved(uint256 amountIn, uint16 probeBps) external onlyOwner nonReentrant {
        try this.runTaxSimulationSaved(amountIn, probeBps) returns (TaxExecutionResult memory result) {
            _report(result);
        } catch (bytes memory reason) {
            revert TaxSimulationFailed(reason);
        }
    }

    /// @dev The external boundary separates adapter reverts from the executor's own TaxReport.
    function runTaxSimulationSaved(uint256 amountIn, uint16 probeBps)
        external
        returns (TaxExecutionResult memory)
    {
        if (msg.sender != address(this)) revert TaxSimulationOnlySelf();
        if (probeBps == 0 || probeBps > BPS) revert InvalidSettings();
        if (_settings.tokenIn == address(0)) revert NotConfigured();
        if (amountIn == 0 || TokenOps.balanceOf(_settings.tokenIn, address(this)) < amountIn) {
            revert InsufficientInput();
        }
        V4Types.Route memory best = _bestRoute(amountIn);
        return _settleTrade(best, amountIn, 0, block.timestamp, probeBps, false);
    }

    function _settingsInput() internal view override returns (address) {
        return _settings.tokenIn;
    }

    function _settingsMinimum() internal view override returns (uint256) {
        return _settings.minBuyAmount;
    }

    function _executeTrade(
        uint256 amountIn,
        uint256 requestedMinimum,
        uint256 deadline,
        uint16 autoSlippageBps,
        bool automatic
    ) internal override returns (uint256 bought, uint256 received, uint256 testInputRecovered) {
        V4Types.Route memory route = _bestRoute(amountIn);
        uint256 minimum = _executionMinimum(route.amountOut, requestedMinimum, autoSlippageBps, automatic);
        bool checkBurn = _settings.checkBurn;
        uint16 probeBps = (_settings.testSell || checkBurn) ? _settings.testSellBps : 0;
        TaxExecutionResult memory result = _settleTrade(route, amountIn, minimum, deadline, probeBps, checkBurn);
        emit Bought(
            result.kind,
            result.pool,
            result.fee,
            result.amountIn,
            result.expectedBuy,
            result.bought,
            result.received,
            result.recovered
        );
        return (result.bought, result.received, result.recovered);
    }

    function _bestRoute(uint256 amountIn) private returns (V4Types.Route memory route) {
        (route,) = quoteHelper.quote(_settings.tokenIn, amountIn);
        if (route.amountOut == 0) revert NoEligiblePool();
    }

    function _settleTrade(
        V4Types.Route memory route,
        uint256 amountIn,
        uint256 minimum,
        uint256 deadline,
        uint16 probeBps,
        bool enforceLossLimits
    ) private returns (TaxExecutionResult memory result) {
        Settings memory settings = _settings;
        result.amountIn = amountIn;
        result.expectedBuy = route.amountOut;
        result.kind = route.kind;
        result.pool = route.pool;
        result.fee = route.fee;
        if (minimum > result.expectedBuy) revert MinimumNotMet(result.expectedBuy, minimum);
        result.bought = _swap(route, settings.tokenIn, settings.tokenOut, amountIn, minimum == 0 ? 1 : minimum, deadline);

        if (probeBps != 0) {
            result.probeAmount = _lossFloor(result.bought, BPS - probeBps);
            if (result.probeAmount == 0) revert SellProbeFailed();
            result.expectedSell =
                quoteHelper.reverseV4(route.candidateIndex, route.poolId, settings.tokenOut, result.probeAmount);
            if (result.expectedSell == 0) revert SellProbeFailed();
            result.recovered =
                _swap(route, settings.tokenOut, settings.tokenIn, result.probeAmount, 1, deadline);
            if (enforceLossLimits && result.recovered < _requiredAfterLoss(result.expectedSell, maxSellLossBps)) {
                revert SellLossLimitExceeded(result.expectedSell, result.recovered);
            }
        }

        result.forwarded = result.bought - result.probeAmount;
        // These two factors are bounded by the signed pool amount width.
        result.expectedRecipient = (result.expectedBuy * result.forwarded) / result.bought;
        if (result.forwarded != 0) {
            result.received = _forward(settings.tokenOut, settings.recipient, result.forwarded);
            if (minimum != 0) {
                uint256 recipientMinimum = (minimum * result.forwarded) / result.bought;
                if (recipientMinimum == 0) recipientMinimum = 1;
                if (result.received < recipientMinimum) revert MinimumNotMet(result.received, recipientMinimum);
            }
        }
        if (enforceLossLimits) {
            if (result.bought < _requiredAfterLoss(result.expectedBuy, settings.maxBurnBps)) {
                revert BurnLimitExceeded(result.expectedBuy, result.bought);
            }
            if (result.received < _requiredAfterLoss(result.expectedRecipient, settings.maxBurnBps)) {
                revert BurnLimitExceeded(result.expectedRecipient, result.received);
            }
        }
    }

    function _swap(
        V4Types.Route memory route,
        address input,
        address output,
        uint256 amount,
        uint256 minimum,
        uint256 deadline
    ) private returns (uint256 received) {
        (address router, address permit2, bool nativeInput, bool nativeOutput, bytes memory commands, bytes[] memory args)
        = quoteHelper.encodeV4(route.candidateIndex, route.poolId, input, output, amount, minimum);
        uint256 inputBefore = TokenOps.balanceOf(input, address(this));
        uint256 outputBefore = TokenOps.balanceOf(output, address(this));
        if (amount > inputBefore) revert InsufficientInput();

        uint256 nativeBefore = address(this).balance;
        uint256 routerNativeBefore;
        if (nativeInput) {
            routerNativeBefore = router.balance;
            IWETH(wrappedNative).withdraw(amount);
            if (address(this).balance != nativeBefore + amount) revert UnexpectedBalance();
        } else {
            TokenOps.forceApprove(input, permit2, amount);
            IV4Permit2(permit2).approve(input, router, uint160(amount), uint48(block.timestamp));
        }

        try IV4UniversalRouter(router).execute{value: nativeInput ? amount : 0}(commands, args, deadline) {}
        catch {
            revert V4SwapFailed();
        }

        if (nativeInput) {
            // Full-input settlement cannot leave value with either the executor or the router.
            if (address(this).balance != nativeBefore || router.balance != routerNativeBefore) {
                revert UnexpectedBalance();
            }
        } else {
            IV4Permit2(permit2).approve(input, router, 0, 0);
            TokenOps.forceApprove(input, permit2, 0);
            if (nativeOutput) {
                if (address(this).balance <= nativeBefore) revert V4SwapFailed();
                IWETH(wrappedNative).deposit{value: address(this).balance - nativeBefore}();
            }
            if (address(this).balance != nativeBefore) revert UnexpectedBalance();
        }

        uint256 inputAfter = TokenOps.balanceOf(input, address(this));
        uint256 outputAfter = TokenOps.balanceOf(output, address(this));
        if (inputAfter != inputBefore - amount || outputAfter < outputBefore) revert UnexpectedBalance();
        received = outputAfter - outputBefore;
        if (received < minimum) revert MinimumNotMet(received, minimum);
        if (received > MAX_SWAP_AMOUNT) revert UnexpectedBalance();
    }

    function _forward(address token, address recipient, uint256 amount) private returns (uint256 received) {
        uint256 senderBefore = TokenOps.balanceOf(token, address(this));
        uint256 recipientBefore = TokenOps.balanceOf(token, recipient);
        TokenOps.transfer(token, recipient, amount);
        uint256 recipientAfter = TokenOps.balanceOf(token, recipient);
        if (
            senderBefore < amount || TokenOps.balanceOf(token, address(this)) != senderBefore - amount
                || recipientAfter < recipientBefore
        ) {
            revert UnexpectedBalance();
        }
        return recipientAfter - recipientBefore;
    }
}
