// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

library TokenOps {
    error TokenOperationFailed(address token);

    function balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory result) =
            token.staticcall(abi.encodeWithSelector(bytes4(0x70a08231), account));
        if (!ok || result.length != 32) revert TokenOperationFailed(token);
        return abi.decode(result, (uint256));
    }

    function transfer(address token, address to, uint256 amount) internal {
        if (!_call(token, abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount))) {
            revert TokenOperationFailed(token);
        }
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        if (_call(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount))) return;
        if (!_call(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, 0))) {
            revert TokenOperationFailed(token);
        }
        if (!_call(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount))) {
            revert TokenOperationFailed(token);
        }
    }

    function _call(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory result) = token.call(data);
        if (!ok) return false;
        if (result.length == 0) return token.code.length != 0;
        return result.length == 32 && abi.decode(result, (uint256)) == 1;
    }
}
