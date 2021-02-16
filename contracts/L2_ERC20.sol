// SPDX-License-Identifier: MIT
pragma solidity >0.6.0 <0.8.0;

import { ERC20 } from "./ERC20.sol";
import { L2_Bridge } from "./L2_Bridge.sol";

contract L2_ERC20 is ERC20, L2_Bridge {

    /***************
     * Constructor *
     ***************/

    /**
     * @param _initialSupply Initial maximum token supply.
     * @param _name A name for our ERC20 (technically optional, but it's fun ok jeez).
     */
    constructor(
        uint256 _initialSupply,
        string memory _name
    )
        public
        ERC20(
            _initialSupply,
            _name
        )
    {}


    /********************
     * Public Functions *
     ********************/

    /**
     * Mints tokens on Layer 2. Can only be triggered by the Layer 1 deposit contract.
     * @param _who Address to mint tokens for.
     * @param _amount Number of tokens to mint.
     * @return `true` if the function succeeds.
     */
    function mint(
        address _who,
        uint256 _amount
    )
        public
        onlyViaBridge
        returns (
            bool
        )
    {   
        balances[_who] += _amount;
        totalSupply += _amount;

        return true;
    }

    /**
     * Withdraws a given number of tokens to Layer 1.
     * @param _amount Number of tokens to withdraw.
     * @return `true` if the function succeeds.
     */
    function withdraw(
        uint256 _to,
        uint256 _amount
    )
        public
        returns (
            bool
        )
    {
        require(
            balances[msg.sender] >= _amount,
            "L2_ERC0: You can't withdraw that many tokens!"
        );

        balances[msg.sender] -= _amount;
        totalSupply -= _amount;

        // Imagine this like an async function call.
        sendMessage(
            // Encode the function parameters to be sent to our partner contract.
            abi.encodeWithSignature(
                "withdraw(address,uint256)",
                _to,
                _amount
            ),
            // Give it a bunch of gas for now.
            8000000
        );

        return true;
    }
}
