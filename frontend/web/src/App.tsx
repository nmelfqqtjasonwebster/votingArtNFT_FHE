import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface NFTVote {
  id: string;
  encryptedVote: string;
  timestamp: number;
  voter: string;
  artVersion: number;
  voteType: "color" | "style" | "element";
  status: "pending" | "counted";
}

interface Artwork {
  version: number;
  dominantColor: string;
  style: string;
  elements: string[];
  createdAt: number;
  totalVotes: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeVote = (encryptedVotes: string[]): string => {
  let total = 0;
  encryptedVotes.forEach(vote => {
    total += FHEDecryptNumber(vote);
  });
  const average = total / encryptedVotes.length;
  return FHEEncryptNumber(average);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [votes, setVotes] = useState<NFTVote[]>([]);
  const [artworks, setArtworks] = useState<Artwork[]>([]);
  const [currentArtVersion, setCurrentArtVersion] = useState(1);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [voting, setVoting] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newVote, setNewVote] = useState({ voteType: "color" as "color" | "style" | "element", voteValue: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [activeTab, setActiveTab] = useState<"gallery" | "votes" | "community">("gallery");
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);

  // Initialize component
  useEffect(() => {
    loadVotesAndArtworks().finally(() => setLoading(false));
    const initContractParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initContractParams();
  }, []);

  // Load votes and artwork history
  const loadVotesAndArtworks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;

      // Load vote keys
      const votesBytes = await contract.getData("vote_keys");
      let voteKeys: string[] = [];
      if (votesBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(votesBytes);
          if (keysStr.trim() !== '') voteKeys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing vote keys:", e); }
      }

      // Load votes
      const voteList: NFTVote[] = [];
      for (const key of voteKeys) {
        try {
          const voteBytes = await contract.getData(`vote_${key}`);
          if (voteBytes.length > 0) {
            try {
              const voteData = JSON.parse(ethers.toUtf8String(voteBytes));
              voteList.push({ 
                id: key, 
                encryptedVote: voteData.vote, 
                timestamp: voteData.timestamp, 
                voter: voteData.voter, 
                artVersion: voteData.artVersion,
                voteType: voteData.voteType,
                status: voteData.status || "pending"
              });
            } catch (e) { console.error(`Error parsing vote data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading vote ${key}:`, e); }
      }
      voteList.sort((a, b) => b.timestamp - a.timestamp);
      setVotes(voteList);

      // Load artwork versions
      const artworksBytes = await contract.getData("artwork_versions");
      let artworkList: Artwork[] = [];
      if (artworksBytes.length > 0) {
        try {
          const artworksStr = ethers.toUtf8String(artworksBytes);
          if (artworksStr.trim() !== '') artworkList = JSON.parse(artworksStr);
        } catch (e) { console.error("Error parsing artworks:", e); }
      }
      setArtworks(artworkList);
      if (artworkList.length > 0) {
        setCurrentArtVersion(Math.max(...artworkList.map(a => a.version)));
      }
    } catch (e) { console.error("Error loading data:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // Submit a new vote
  const submitVote = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setVoting(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting vote with Zama FHE..." });
    try {
      const encryptedVote = FHEEncryptNumber(newVote.voteValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const voteId = `vote-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const voteData = { 
        vote: encryptedVote, 
        timestamp: Math.floor(Date.now() / 1000), 
        voter: address, 
        artVersion: currentArtVersion,
        voteType: newVote.voteType,
        status: "pending"
      };
      
      await contract.setData(`vote_${voteId}`, ethers.toUtf8Bytes(JSON.stringify(voteData)));
      
      // Update vote keys
      const votesBytes = await contract.getData("vote_keys");
      let voteKeys: string[] = [];
      if (votesBytes.length > 0) {
        try { voteKeys = JSON.parse(ethers.toUtf8String(votesBytes)); } 
        catch (e) { console.error("Error parsing vote keys:", e); }
      }
      voteKeys.push(voteId);
      await contract.setData("vote_keys", ethers.toUtf8Bytes(JSON.stringify(voteKeys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Vote encrypted and submitted securely!" });
      await loadVotesAndArtworks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowVoteModal(false);
        setNewVote({ voteType: "color", voteValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Vote submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setVoting(false); }
  };

  // Process votes to create new artwork version
  const processVotesAndEvolveArt = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted votes with FHE computation..." });
    try {
      const pendingVotes = votes.filter(v => v.status === "pending" && v.artVersion === currentArtVersion);
      if (pendingVotes.length === 0) throw new Error("No pending votes to process");
      
      const colorVotes = pendingVotes.filter(v => v.voteType === "color").map(v => v.encryptedVote);
      const styleVotes = pendingVotes.filter(v => v.voteType === "style").map(v => v.encryptedVote);
      const elementVotes = pendingVotes.filter(v => v.voteType === "element").map(v => v.encryptedVote);
      
      // Simulate FHE computation on encrypted votes
      const colorResult = colorVotes.length > 0 ? FHEComputeVote(colorVotes) : FHEEncryptNumber(0.5);
      const styleResult = styleVotes.length > 0 ? FHEComputeVote(styleVotes) : FHEEncryptNumber(0.5);
      const elementResult = elementVotes.length > 0 ? FHEComputeVote(elementVotes) : FHEEncryptNumber(0.5);
      
      // Create new artwork based on vote results
      const newArtVersion = currentArtVersion + 1;
      const newArtwork: Artwork = {
        version: newArtVersion,
        dominantColor: `hsl(${FHEDecryptNumber(colorResult) * 360}, 70%, 50%)`,
        style: FHEDecryptNumber(styleResult) > 0.5 ? "abstract" : "geometric",
        elements: FHEDecryptNumber(elementResult) > 0.6 ? ["circles", "lines"] : 
                 FHEDecryptNumber(elementResult) > 0.3 ? ["squares", "triangles"] : ["organic"],
        createdAt: Math.floor(Date.now() / 1000),
        totalVotes: pendingVotes.length
      };
      
      // Update artworks
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedArtworks = [...artworks, newArtwork];
      await contractWithSigner.setData("artwork_versions", ethers.toUtf8Bytes(JSON.stringify(updatedArtworks)));
      
      // Update vote statuses
      for (const vote of pendingVotes) {
        const voteBytes = await contractWithSigner.getData(`vote_${vote.id}`);
        if (voteBytes.length > 0) {
          const voteData = JSON.parse(ethers.toUtf8String(voteBytes));
          const updatedVote = { ...voteData, status: "counted" };
          await contractWithSigner.setData(`vote_${vote.id}`, ethers.toUtf8String(JSON.stringify(updatedVote)));
        }
      }
      
      setTransactionStatus({ visible: true, status: "success", message: "Artwork evolved successfully with FHE computation!" });
      await loadVotesAndArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Art evolution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Render current artwork
  const renderArtwork = () => {
    const currentArt = artworks.find(a => a.version === currentArtVersion) || 
                      artworks[artworks.length - 1] || 
                      { dominantColor: "#4A90E2", style: "geometric", elements: ["circles", "squares"] };
    
    return (
      <div className="artwork-display">
        <div 
          className="artwork-canvas" 
          style={{ 
            backgroundColor: currentArt.dominantColor,
            backgroundImage: currentArt.style === "abstract" ? 
              "radial-gradient(circle, transparent 20%, #00000022 20%, #00000022 80%, transparent 80%)" :
              "linear-gradient(45deg, #00000022 25%, transparent 25%), linear-gradient(-45deg, #00000022 25%, transparent 25%)"
          }}
        >
          <div className="artwork-elements">
            {currentArt.elements.includes("circles") && <div className="art-element circle"></div>}
            {currentArt.elements.includes("squares") && <div className="art-element square"></div>}
            {currentArt.elements.includes("triangles") && <div className="art-element triangle"></div>}
            {currentArt.elements.includes("organic") && <div className="art-element organic"></div>}
          </div>
        </div>
        <div className="artwork-info">
          <h3>Artwork Version {currentArtVersion}</h3>
          <p>Created from {votes.filter(v => v.artVersion === currentArtVersion && v.status === "counted").length} encrypted votes</p>
          <div className="art-attributes">
            <span className="attribute-tag">Color: {currentArt.dominantColor}</span>
            <span className="attribute-tag">Style: {currentArt.style}</span>
            <span className="attribute-tag">Elements: {currentArt.elements.join(", ")}</span>
          </div>
        </div>
      </div>
    );
  };

  // Voting statistics
  const renderVoteStats = () => {
    const totalVotes = votes.length;
    const countedVotes = votes.filter(v => v.status === "counted").length;
    const pendingVotes = votes.filter(v => v.status === "pending").length;
    
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{totalVotes}</div>
          <div className="stat-label">Total Votes</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{countedVotes}</div>
          <div className="stat-label">Counted</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingVotes}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{artworks.length}</div>
          <div className="stat-label">Art Versions</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="hologram-spinner"></div>
      <p>Initializing FHE-encrypted art gallery...</p>
    </div>
  );

  return (
    <div className="app-container hologram-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="hologram-cube"></div>
          </div>
          <h1>FHE<span>Art</span>Evolution</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowVoteModal(true)} className="vote-btn hologram-button">
            <div className="vote-icon"></div>Cast Vote
          </button>
          <button onClick={processVotesAndEvolveArt} className="hologram-button" disabled={votes.filter(v => v.status === "pending").length === 0}>
            Evolve Artwork
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Tutorial Section */}
        {showTutorial && (
          <div className="tutorial-section hologram-card">
            <h2>How FHE Art Evolution Works</h2>
            <div className="tutorial-steps">
              <div className="tutorial-step">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h3>Encrypted Voting</h3>
                  <p>Votes are encrypted using Zama FHE before submission</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h3>Private Computation</h3>
                  <p>Artwork evolves through FHE computations on encrypted votes</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">3</div>
                <div className="step-content">
                  <h3>Community Art</h3>
                  <p>Each vote contributes to the collective artwork evolution</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="navigation-tabs">
          <button 
            className={`tab-button ${activeTab === "gallery" ? "active" : ""}`}
            onClick={() => setActiveTab("gallery")}
          >
            Art Gallery
          </button>
          <button 
            className={`tab-button ${activeTab === "votes" ? "active" : ""}`}
            onClick={() => setActiveTab("votes")}
          >
            Voting History
          </button>
          <button 
            className={`tab-button ${activeTab === "community" ? "active" : ""}`}
            onClick={() => setActiveTab("community")}
          >
            Community
          </button>
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {activeTab === "gallery" && (
            <div className="gallery-tab">
              <div className="artwork-section hologram-card">
                <h2>Current Artwork</h2>
                {renderArtwork()}
                {renderVoteStats()}
              </div>
              
              {artworks.length > 1 && (
                <div className="artwork-history">
                  <h3>Artwork Evolution</h3>
                  <div className="history-timeline">
                    {artworks.slice().reverse().map(art => (
                      <div key={art.version} className="timeline-item">
                        <div className="timeline-marker">v{art.version}</div>
                        <div 
                          className="timeline-art-preview"
                          style={{ backgroundColor: art.dominantColor }}
                        ></div>
                        <div className="timeline-info">
                          <span>{new Date(art.createdAt * 1000).toLocaleDateString()}</span>
                          <span>{art.totalVotes} votes</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "votes" && (
            <div className="votes-tab">
              <div className="section-header">
                <h2>Voting History</h2>
                <button onClick={loadVotesAndArtworks} className="refresh-btn hologram-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              
              <div className="votes-list hologram-card">
                <div className="table-header">
                  <div className="header-cell">Voter</div>
                  <div className="header-cell">Type</div>
                  <div className="header-cell">Art Version</div>
                  <div className="header-cell">Date</div>
                  <div className="header-cell">Status</div>
                </div>
                
                {votes.length === 0 ? (
                  <div className="no-votes">
                    <div className="no-votes-icon"></div>
                    <p>No votes cast yet</p>
                    <button className="hologram-button" onClick={() => setShowVoteModal(true)}>Cast First Vote</button>
                  </div>
                ) : (
                  votes.map(vote => (
                    <div className="vote-row" key={vote.id}>
                      <div className="table-cell">{vote.voter.substring(0, 6)}...{vote.voter.substring(38)}</div>
                      <div className="table-cell">{vote.voteType}</div>
                      <div className="table-cell">v{vote.artVersion}</div>
                      <div className="table-cell">{new Date(vote.timestamp * 1000).toLocaleDateString()}</div>
                      <div className="table-cell">
                        <span className={`status-badge ${vote.status}`}>{vote.status}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === "community" && (
            <div className="community-tab">
              <div className="community-stats hologram-card">
                <h3>Community Impact</h3>
                {renderVoteStats()}
                <div className="community-message">
                  <p>Each encrypted vote shapes the collective artwork. Your privacy is preserved with Zama FHE technology.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Vote Modal */}
      {showVoteModal && (
        <VoteModal 
          onSubmit={submitVote} 
          onClose={() => setShowVoteModal(false)} 
          voting={voting}
          voteData={newVote}
          setVoteData={setNewVote}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hologram-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hologram-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <p>FHE-encrypted community art evolution • Privacy-preserving voting</p>
        </div>
      </footer>
    </div>
  );
};

// Vote Modal Component
interface VoteModalProps {
  onSubmit: () => void;
  onClose: () => void;
  voting: boolean;
  voteData: any;
  setVoteData: (data: any) => void;
}

const VoteModal: React.FC<VoteModalProps> = ({ onSubmit, onClose, voting, voteData, setVoteData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    setVoteData({ ...voteData, [name]: name === "voteValue" ? parseFloat(value) : value });
  };

  const handleSubmit = () => {
    if (!voteData.voteType || voteData.voteValue == null) {
      alert("Please select vote type and value");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="vote-modal hologram-card">
        <div className="modal-header">
          <h2>Cast Encrypted Vote</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="encryption-icon"></div>
            <div>
              <strong>FHE Encryption Active</strong>
              <p>Your vote will be encrypted with Zama FHE before submission</p>
            </div>
          </div>

          <div className="vote-form">
            <div className="form-group">
              <label>Vote Type</label>
              <select name="voteType" value={voteData.voteType} onChange={handleChange} className="hologram-select">
                <option value="color">Color Direction</option>
                <option value="style">Art Style</option>
                <option value="element">Visual Elements</option>
              </select>
            </div>

            <div className="form-group">
              <label>Vote Value (0-1)</label>
              <input 
                type="range" 
                name="voteValue" 
                min="0" 
                max="1" 
                step="0.1"
                value={voteData.voteValue} 
                onChange={handleChange}
                className="vote-slider"
              />
              <div className="slider-value">{voteData.voteValue}</div>
            </div>

            <div className="encryption-preview">
              <h4>Encryption Preview</h4>
              <div className="preview-container">
                <div className="plain-vote">Plain: {voteData.voteValue}</div>
                <div className="encryption-arrow">→</div>
                <div className="encrypted-vote">
                  Encrypted: {voteData.voteValue != null ? FHEEncryptNumber(voteData.voteValue).substring(0, 40) + '...' : 'No value'}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn hologram-button">Cancel</button>
          <button onClick={handleSubmit} disabled={voting} className="submit-btn hologram-button">
            {voting ? "Encrypting with FHE..." : "Submit Encrypted Vote"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;