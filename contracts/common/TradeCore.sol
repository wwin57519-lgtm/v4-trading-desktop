// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IWETH, TokenOps} from "./TokenOps.sol";

abstract contract TradeCore {
    error AlreadyExecuted();
    error BurnLimitExceeded(uint256 expected, uint256 actual);
    error Expired();
    error InsufficientInput();
    error InvalidConfiguration();
    error InvalidPriceProtection();
    error InvalidSettings();
    error InvalidTriggerPolicy();
    error InvalidTriggerWallets();
    error MinimumNotMet(uint256 actual, uint256 minimum);
    error NativeTransferFailed();
    error NoEligiblePool();
    error NotConfigured();
    error NotOwner();
    error NotTriggerWallet();
    error Reentrancy();
    error SellLossLimitExceeded(uint256 expected, uint256 actual);
    error SellProbeFailed();
    error StaleTriggerEpoch();
    error TaxSimulationFailed(bytes reason);
    error TaxSimulationOnlySelf();
    error TriggerNotArmed();
    error TriggerTooEarly();
    error UnexpectedBalance();

    error TaxReport(
        uint256 amountIn,
        uint256 expectedBuy,
        uint256 bought,
        uint256 probeAmount,
        uint256 expectedSell,
        uint256 recovered,
        uint256 forwarded,
        uint256 expectedRecipient,
        uint256 received,
        uint8 kind,
        address pool,
        uint24 fee
    );

    event Bought(
        uint8 indexed kind,
        address indexed pool,
        uint24 fee,
        uint256 amountIn,
        uint256 quotedOut,
        uint256 bought,
        uint256 received,
        uint256 testInputRecovered
    );
    event NativeDeposited(uint256 amount);
    event SettingsUpdated(address indexed tokenIn, address indexed tokenOut, address recipient);
    event TaxLimitUpdated(uint16 maxSellLossBps);
    event TriggerArmed(uint256 indexed epoch, uint256 amountIn, uint16 slippageBps, uint64 notBefore, uint64 expiresAt);
    event TriggerDisarmed(uint256 indexed epoch);
    event TriggerExecuted(address indexed wallet, uint256 indexed epoch);
    event TriggerWalletsUpdated(address[] wallets, bool allowed);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    struct TriggerPolicy {
        uint256 amountIn;
        uint16 slippageBps;
        uint64 notBefore;
        uint64 expiresAt;
    }

    struct TaxExecutionResult {
        uint256 amountIn;
        uint256 expectedBuy;
        uint256 bought;
        uint256 probeAmount;
        uint256 expectedSell;
        uint256 recovered;
        uint256 forwarded;
        uint256 expectedRecipient;
        uint256 received;
        uint8 kind;
        address pool;
        uint24 fee;
    }

    uint16 internal constant BPS = 10_000;

    address public immutable owner;
    address public immutable wrappedNative;
    uint256 public immutable networkChainId;

    uint16 public maxSellLossBps = 1_000;
    bool public executed;
    bool public triggerArmed;
    uint256 public triggerEpoch;
    mapping(address => bool) public isTriggerWallet;

    TriggerPolicy private _triggerPolicy;
    bool private _entered;

    constructor(address initialOwner, address wrapped) {
        if (initialOwner == address(0) || wrapped.code.length == 0) revert InvalidConfiguration();
        owner = initialOwner;
        wrappedNative = wrapped;
        networkChainId = block.chainid;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    receive() external payable {}

    function depositNative() external payable nonReentrant {
        if (msg.value == 0) revert InsufficientInput();
        uint256 beforeDeposit = TokenOps.balanceOf(wrappedNative, address(this));
        IWETH(wrappedNative).deposit{value: msg.value}();
        if (TokenOps.balanceOf(wrappedNative, address(this)) != beforeDeposit + msg.value) {
            revert UnexpectedBalance();
        }
        emit NativeDeposited(msg.value);
    }

    function withdrawNative(address to, uint256 amount) external onlyOwner nonReentrant {
        _checkRecipient(to);
        _invalidateTrigger();
        uint256 nativeBalance = address(this).balance;
        if (amount == 0) amount = nativeBalance + TokenOps.balanceOf(wrappedNative, address(this));
        if (amount == 0) revert InsufficientInput();
        if (amount > nativeBalance) IWETH(wrappedNative).withdraw(amount - nativeBalance);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Withdrawn(address(0), to, amount);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        _checkRecipient(to);
        _invalidateTrigger();
        // An explicit amount remains recoverable for tokens with a broken balanceOf.
        if (amount == 0) amount = TokenOps.balanceOf(token, address(this));
        if (amount == 0) revert InsufficientInput();
        TokenOps.transfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setTriggerWallets(address[] calldata wallets, bool allowed) external onlyOwner nonReentrant {
        if (wallets.length == 0 || wallets.length > 500) revert InvalidTriggerWallets();
        for (uint256 i; i < wallets.length; ++i) {
            if (wallets[i] == address(0) || wallets[i] == address(this)) revert InvalidTriggerWallets();
            isTriggerWallet[wallets[i]] = allowed;
        }
        _invalidateTrigger();
        emit TriggerWalletsUpdated(wallets, allowed);
    }

    function armTrigger(uint256 amountIn, uint16 slippageBps, uint64 notBefore, uint64 expiresAt)
        external
        onlyOwner
        nonReentrant
    {
        if (_settingsInput() == address(0)) revert NotConfigured();
        if (executed) revert AlreadyExecuted();
        bool validPricePolicy = _settingsMinimum() == 0 ? slippageBps < BPS : slippageBps == BPS;
        if (!validPricePolicy || expiresAt <= block.timestamp || notBefore >= expiresAt) {
            revert InvalidTriggerPolicy();
        }
        ++triggerEpoch;
        _triggerPolicy = TriggerPolicy(amountIn, slippageBps, notBefore, expiresAt);
        triggerArmed = true;
        emit TriggerArmed(triggerEpoch, amountIn, slippageBps, notBefore, expiresAt);
    }

    function disarmTrigger() external onlyOwner nonReentrant {
        _invalidateTrigger();
    }

    function getTriggerPolicy() external view returns (TriggerPolicy memory) {
        return _triggerPolicy;
    }

    function buy(uint256 amountIn, uint256 minOut, uint256 deadline, uint256 expectedEpoch)
        external
        onlyOwner
        nonReentrant
        returns (uint256 bought, uint256 received, uint256 testInputRecovered)
    {
        _checkRound(expectedEpoch);
        if (block.timestamp > deadline) revert Expired();
        _beginTrade(amountIn);
        return _executeTrade(amountIn, minOut, deadline, 0, false);
    }

    function trigger(uint256 expectedEpoch)
        external
        nonReentrant
        returns (uint256 bought, uint256 received, uint256 testInputRecovered)
    {
        if (!isTriggerWallet[msg.sender]) revert NotTriggerWallet();
        _checkRound(expectedEpoch);
        if (!triggerArmed) revert TriggerNotArmed();
        TriggerPolicy memory policy = _triggerPolicy;
        if (block.timestamp < policy.notBefore) revert TriggerTooEarly();
        if (block.timestamp > policy.expiresAt) revert Expired();
        uint256 amountIn = policy.amountIn;
        if (amountIn == 0) amountIn = TokenOps.balanceOf(_settingsInput(), address(this));

        _beginTrade(amountIn);
        (bought, received, testInputRecovered) =
            _executeTrade(amountIn, 0, policy.expiresAt, policy.slippageBps, true);
        emit TriggerExecuted(msg.sender, expectedEpoch);
    }

    function _afterSettings(uint16 sellLossBps) internal {
        if (sellLossBps > BPS) revert InvalidSettings();
        maxSellLossBps = sellLossBps;
        executed = false;
        _invalidateTrigger();
        emit TaxLimitUpdated(sellLossBps);
    }

    function _invalidateTrigger() internal {
        ++triggerEpoch;
        triggerArmed = false;
        delete _triggerPolicy;
        emit TriggerDisarmed(triggerEpoch);
    }

    function _executionMinimum(uint256 quote, uint256 requestedMinimum, uint16 autoSlippageBps, bool automatic)
        internal
        view
        returns (uint256)
    {
        uint256 fixedMinimum = _settingsMinimum();
        if (fixedMinimum != 0) {
            if (requestedMinimum != 0) revert InvalidPriceProtection();
            return fixedMinimum;
        }
        uint256 minimum = automatic ? _lossFloor(quote, autoSlippageBps) : requestedMinimum;
        // A positive quote below one unit after integer rounding still requires output.
        return minimum == 0 ? 1 : minimum;
    }

    function _lossFloor(uint256 expected, uint16 lossBps) internal pure returns (uint256) {
        uint256 kept = BPS - lossBps;
        return (expected / BPS) * kept + ((expected % BPS) * kept) / BPS;
    }

    function _requiredAfterLoss(uint256 expected, uint16 maximumLossBps) internal pure returns (uint256) {
        // Round the allowed loss down so even small trades cannot exceed the cap.
        return expected - _lossFloor(expected, BPS - maximumLossBps);
    }

    function _checkRecipient(address to) internal view {
        if (to == address(0) || to == address(this)) revert InvalidSettings();
    }

    function _report(TaxExecutionResult memory r) internal pure {
        revert TaxReport(
            r.amountIn,
            r.expectedBuy,
            r.bought,
            r.probeAmount,
            r.expectedSell,
            r.recovered,
            r.forwarded,
            r.expectedRecipient,
            r.received,
            r.kind,
            r.pool,
            r.fee
        );
    }

    function _checkRound(uint256 expectedEpoch) private view {
        if (expectedEpoch != triggerEpoch) revert StaleTriggerEpoch();
        if (executed) revert AlreadyExecuted();
        if (_settingsInput() == address(0)) revert NotConfigured();
    }

    function _beginTrade(uint256 amountIn) private {
        if (amountIn == 0 || TokenOps.balanceOf(_settingsInput(), address(this)) < amountIn) {
            revert InsufficientInput();
        }
        executed = true;
        triggerArmed = false;
    }

    function _settingsInput() internal view virtual returns (address);
    function _settingsMinimum() internal view virtual returns (uint256);
    function _executeTrade(uint256 amountIn, uint256 requestedMinimum, uint256 deadline, uint16 autoSlippageBps, bool automatic)
        internal
        virtual
        returns (uint256 bought, uint256 received, uint256 testInputRecovered);
}
