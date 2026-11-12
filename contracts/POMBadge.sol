// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ProofOfMass Badge — a SOULBOUND (non-transferable) proof-of-standing badge.
/// One per wallet. Image/metadata are dynamic, served from the ProofOfMass server,
/// so the badge reflects the agent's live PoA-derived mass. Experimental; not financial.
contract ProofOfMassBadge is ERC721, Ownable {
    uint256 public nextId = 1;
    uint256 public mintFee;         // wei; 0 on testnet
    string private baseURI;         // e.g. https://mass.arwyn.party/api/nft/

    event BadgeMinted(address indexed to, uint256 indexed tokenId);

    constructor(address initialOwner, string memory baseURI_)
        ERC721("ProofOfMass Badge", "MASS")
        Ownable(initialOwner)
    {
        baseURI = baseURI_;
    }

    /// Mint your soulbound badge. One per wallet. Pays `mintFee` to the contract.
    function mint() external payable returns (uint256) {
        require(msg.value >= mintFee, "insufficient fee");
        require(balanceOf(msg.sender) == 0, "one badge per wallet");
        uint256 id = nextId++;
        _mint(msg.sender, id);
        emit BadgeMinted(msg.sender, id);
        return id;
    }

    /// SOULBOUND: permit mint (from 0) and burn (to 0); block any wallet-to-wallet transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert("Soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }

    /// Let a holder burn their own badge (the only way to "leave").
    function burn(uint256 tokenId) external {
        require(_ownerOf(tokenId) == msg.sender, "not owner");
        _burn(tokenId);
    }

    function _baseURI() internal view override returns (string memory) { return baseURI; }
    function setBaseURI(string calldata u) external onlyOwner { baseURI = u; }
    function setMintFee(uint256 f) external onlyOwner { mintFee = f; }
    function withdraw(address payable to) external onlyOwner { to.transfer(address(this).balance); }
}
