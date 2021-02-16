pragma solidity >0.6.0 <0.8.0;

interface ERC20Like {
    function transferFrom(address src, address dst, uint wad) external returns (bool);
    function transfer(address dst, uint wad) external returns (bool);
}

// Interface for the L2 ERC20 contract
interface L2ERC20 {
    function withdraw(address,uint256) external;
}

interface Messenger {
    function relayedMessages(bytes32) external view returns (bool);
    function successfulMessages(bytes32) external view returns (bool);
}

contract XChainRegistry {
    address public owner = msg.sender;

    // registry of ERC20 to L2-aware deposit lockboxes
    mapping(address => address) public l1DepositBoxes;

    // registry of L1 <> L2 mirrors
    mapping(address => address) public l2Mirrors;

    // registers the L1 Deposit box for the token, so that we can check that the
    // relayed message is sent to the correct place
    function registerDepositBox(address token, address box) public {
        require(msg.sender == owner, "err unauthorized");
        l1DepositBoxes[token] = box;
    }

    // registers the L2 Mirror of the L1 token, so that we can check that
    // the relayed message is from the correct token
    function registerMirror(address token, address l2Token) public {
        require(msg.sender == owner, "err unauthorized");
        l2Mirrors[token] = l2Token;
    }
}

// L1 contract which greenlights fast withdrawals from a user
// TODO: This should probably be behind a centralized delegate proxy since it'd be a
// service where users send money to?
contract MarketMaker is XChainRegistry {
    Messenger messenger;

    // checks if a withdrawal has been greenlit from the mm
    mapping (bytes32 => bool) greenlighted;

    constructor(Messenger _messenger) {
        messenger = _messenger;
    }

    // we assume that the market maker has cold wallets with which they have approved
    // the contract to transact with. this separates inventory from the bot logic
    // TODO: Allow greenlightingMany to do this in a loop!
    function greenlight(ERC20Like token, address inventory, address to, uint256 amount) public {
        // TODO: Add greenlight-by-signature
        require(msg.sender == owner, "not owner");

        require(!isGreenlighted(token, to, amount), "already greenlighted");

        // send the funds out
        token.transferFrom(inventory, to, amount);

        // transfer is done
        greenlighted[keccak256(abi.encodePacked(token, to, amount))] = true;
    }

    // Sends the funds to the Owner if they have greenlit the message, or sends it to the
    // original beneficiary.
    function claim(ERC20Like token, address to, uint256 amount, uint256 messageNonce) public {
        // ensure that the message is relayed
        require(isSuccessfulMsg(token, to, amount, messageNonce), "err message not relayed");

        // if you are not the owner, you can only claim if they haven't greenlit you yet
        if (msg.sender == owner) {
            // the owner can only claim if they have greenlit it
            require(isGreenlighted(token, to, amount), "message not greenlighted");
        } else {
            // 1. Only the beneficiary can claim
            require(msg.sender == to, "sender must be receiver of the deposit");

            // 2. The beneficiary must not have been greenlit by the time the message is posted
            require(!isGreenlighted(token, to, amount), "message already greenlighted");

            // 3. Prevent it from being greenlit again
            greenlighted[keccak256(abi.encodePacked(token, to, amount))] = true;
        }

        // send the funds to the beneficiary
        require(token.transfer(to, amount), "err could not transfer");
    }

    // TODO: Can the withdrawal message be augmented to include fee information?
    function isSuccessfulMsg(ERC20Like token, address to, uint256 amount, uint256 messageNonce) public view returns (bool) {
        // Checks that `l1DepositBoxes[token].withdraw(to, amount, { from: l2Mirror[token] })` has been relayed.
        bytes memory call = abi.encodeWithSelector(L2ERC20.withdraw.selector, to, amount);
        bytes memory message = abi.encodeWithSignature(
            "relayMessage(address,address,bytes,uint256)",
            l1DepositBoxes[address(token)],
            l2Mirrors[address(token)], // the contract which executed the withdrawal
            call,
            messageNonce
        );

        // TODO: Maybe also check messenger.relayedMessages?
        return messenger.successfulMessages(keccak256(message));
    }

    function isGreenlighted(ERC20Like token, address to, uint256 amount) public view returns (bool) {
        return greenlighted[keccak256(abi.encodePacked(token, to, amount))];
    }
}
