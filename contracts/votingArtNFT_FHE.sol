pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract VotingArtNFTFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public currentBatchId;
    bool public batchOpen;

    mapping(uint256 => euint32) public encryptedWarmVotes;
    mapping(uint256 => euint32) public encryptedColdVotes;
    mapping(uint256 => euint32) public encryptedTotalVotes;
    mapping(uint256 => euint32) public encryptedWarmPercentage;
    mapping(uint256 => euint32) public encryptedColdPercentage;
    mapping(uint256 => ebool) public encryptedIsWarmWinning;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event VoteSubmitted(address indexed provider, uint256 indexed batchId, uint256 warmVotes, uint256 coldVotes);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 warmPercentage, uint256 coldPercentage, bool isWarmWinning);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error BatchAlreadyOpen();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Effectively, "already unpaused"
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchAlreadyOpen();
        currentBatchId++;
        batchOpen = true;
        // Initialize encrypted state for the new batch
        encryptedWarmVotes[currentBatchId] = FHE.asEuint32(0);
        encryptedColdVotes[currentBatchId] = FHE.asEuint32(0);
        encryptedTotalVotes[currentBatchId] = FHE.asEuint32(0);
        encryptedWarmPercentage[currentBatchId] = FHE.asEuint32(0);
        encryptedColdPercentage[currentBatchId] = FHE.asEuint32(0);
        encryptedIsWarmWinning[currentBatchId] = FHE.asEbool(false);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitVote(
        uint256 warmVotes,
        uint256 coldVotes,
        bytes memory encryptedWarmVoteCiphertext,
        bytes memory encryptedColdVoteCiphertext
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        lastSubmissionTime[msg.sender] = block.timestamp;

        euint32 memory ew = FHE.asEuint32(warmVotes);
        euint32 memory ec = FHE.asEuint32(coldVotes);

        // Add to current batch's encrypted totals
        encryptedWarmVotes[currentBatchId] = encryptedWarmVotes[currentBatchId].add(ew, encryptedWarmVoteCiphertext);
        encryptedColdVotes[currentBatchId] = encryptedColdVotes[currentBatchId].add(ec, encryptedColdVoteCiphertext);

        emit VoteSubmitted(msg.sender, currentBatchId, warmVotes, coldVotes);
    }

    function requestTallyDecryption() external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchOpen) revert BatchNotOpen(); // Batch must be closed to tally
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        // Order: warmVotes, coldVotes, totalVotes, warmPercentage, coldPercentage, isWarmWinning
        bytes32[] memory cts = new bytes32[](6);
        cts[0] = FHE.toBytes32(encryptedWarmVotes[currentBatchId]);
        cts[1] = FHE.toBytes32(encryptedColdVotes[currentBatchId]);

        // Calculate total votes (warm + cold)
        encryptedTotalVotes[currentBatchId] = encryptedWarmVotes[currentBatchId].add(encryptedColdVotes[currentBatchId]);
        cts[2] = FHE.toBytes32(encryptedTotalVotes[currentBatchId]);

        // Calculate percentages (warm * 100 / total, cold * 100 / total)
        // Note: FHE.div is not available, so this is a conceptual representation.
        // For actual FHE, this would require more complex arithmetic or lookup tables.
        // Here, we'll assume these are pre-calculated or use a simplified model.
        // For this example, we'll just pass the sum ciphertexts.
        // In a real scenario, these would be results of FHE operations.
        // For the purpose of this example, we'll just pass the sum ciphertexts again for percentages.
        // This part would need to be replaced with actual FHE percentage calculation logic.
        // For now, we'll just use placeholder ciphertexts for percentages and isWarmWinning.
        // The key is that these ciphertexts are determined *before* the state hash.
        // For this example, we'll assume they are derived from the sums.
        // Let's assume percentages are calculated as (value * 100) / total.
        // This is complex in FHE. For this example, we'll use a simplified model:
        // If total is not zero, percentage = (value * 100) / total. Otherwise 0.
        // This requires FHE comparison and conditional logic, which is advanced.
        // For this example, we'll just pass the sum ciphertexts for percentages as well,
        // acknowledging this is a simplification.
        cts[3] = cts[0]; // Placeholder for warmPercentage
        cts[4] = cts[1]; // Placeholder for coldPercentage

        // Determine if warm is winning (warm > cold)
        encryptedIsWarmWinning[currentBatchId] = encryptedWarmVotes[currentBatchId].ge(encryptedColdVotes[currentBatchId]);
        cts[5] = FHE.toBytes32(encryptedIsWarmWinning[currentBatchId]);


        // 2. Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayDetected();

        // b. State Verification
        // Rebuild cts in the exact same order as in requestTallyDecryption
        bytes32[] memory cts = new bytes32[](6);
        cts[0] = FHE.toBytes32(encryptedWarmVotes[ctx.batchId]);
        cts[1] = FHE.toBytes32(encryptedColdVotes[ctx.batchId]);
        cts[2] = FHE.toBytes32(encryptedTotalVotes[ctx.batchId]);
        cts[3] = FHE.toBytes32(encryptedWarmPercentage[ctx.batchId]); // Placeholder
        cts[4] = FHE.toBytes32(encryptedColdPercentage[ctx.batchId]); // Placeholder
        cts[5] = FHE.toBytes32(encryptedIsWarmWinning[ctx.batchId]);

        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != ctx.stateHash) revert StateMismatch();

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // d. Decode & Finalize
        // Cleartexts are expected in the same order: warmVotes, coldVotes, totalVotes, warmPercentage, coldPercentage, isWarmWinning
        uint256 warmVotesCleartext = abi.decode(cleartexts[0:32], (uint256));
        uint256 coldVotesCleartext = abi.decode(cleartexts[32:64], (uint256));
        uint256 totalVotesCleartext = abi.decode(cleartexts[64:96], (uint256));
        uint256 warmPercentageCleartext = abi.decode(cleartexts[96:128], (uint256));
        uint256 coldPercentageCleartext = abi.decode(cleartexts[128:160], (uint256));
        bool isWarmWinningCleartext = abi.decode(cleartexts[160:192], (bool));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, warmPercentageCleartext, coldPercentageCleartext, isWarmWinningCleartext);
    }

    // Internal helper functions
    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage s, uint256 value) internal {
        if (!FHE.isInitialized(s)) {
            s = FHE.asEuint32(value);
        }
    }

    function _requireInitialized(euint32 storage s) internal view {
        if (!FHE.isInitialized(s)) revert("NotInitialized");
    }
}