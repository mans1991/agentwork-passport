// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Registry Agent ID TIRUAN untuk uji lokal saja. BUKAN untuk deploy.
// Meniru satu fungsi yang dipakai AgentWorkPassport: balanceOf(address).
contract MockAgentRegistry {
    mapping(address => uint256) private _bal;
    function giveAgentId(address who) external { _bal[who] = 1; }
    function balanceOf(address account) external view returns (uint256) { return _bal[account]; }
}
