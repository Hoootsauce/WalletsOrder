const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

// Verification
if (!TELEGRAM_BOT_TOKEN || !ETHEREUM_RPC_URL || !ETHERSCAN_API_KEY) {
    console.error('❌ Missing environment variables!');
    process.exit(1);
}

// Initialisation
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL);

// Serveur Express
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 Token Analyzer Bot</h1>
        <p>✅ Bot is active</p>
        <p>⏰ ${new Date().toLocaleString('en-US')}</p>
    `);
});

// ABI basique
const ERC20_ABI = [
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function name() external view returns (string)",
    "function totalSupply() external view returns (uint256)"
];

class SimpleTokenAnalyzer {
    constructor() {
        this.provider = provider;
    }

    async getTokenInfo(contractAddress) {
        try {
            console.log(`🔍 Getting token info for: ${contractAddress}`);
            
            // Simple method: direct reading
            const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
                contract.name(),
                contract.symbol(), 
                contract.decimals(),
                contract.totalSupply()
            ]);

            const tokenName = name.status === 'fulfilled' ? name.value : 'Unknown Token';
            const tokenSymbol = symbol.status === 'fulfilled' ? symbol.value : 'TOKEN';
            const tokenDecimals = decimals.status === 'fulfilled' ? Number(decimals.value) : 18;
            const tokenTotalSupply = totalSupply.status === 'fulfilled' ? totalSupply.value : 0n;
            
            // Convert supply to readable number
            let readableSupply = 0;
            if (tokenTotalSupply > 0n) {
                readableSupply = parseFloat(ethers.formatUnits(tokenTotalSupply, tokenDecimals));
            }
            
            console.log(`✅ Token: ${tokenName} (${tokenSymbol}) - ${tokenDecimals} decimals`);
            console.log(`📊 Supply: ${readableSupply.toLocaleString('en-US')} ${tokenSymbol}`);
            
            return { 
                name: tokenName, 
                symbol: tokenSymbol, 
                decimals: tokenDecimals,
                totalSupply: readableSupply
            };
        } catch (error) {
            console.error('❌ Token info error:', error.message);
            return {
                name: 'Unknown Token',
                symbol: 'TOKEN',
                decimals: 18,
                totalSupply: 0
            };
        }
    }

    async getTransactionBribe(txHash) {
        try {
            // Get internal transactions to detect bribes (ETH transfers)
            const response = await axios.get('https://api.etherscan.io/api', {
                params: {
                    module: 'account',
                    action: 'txlistinternal',
                    txhash: txHash,
                    apikey: ETHERSCAN_API_KEY
                },
                timeout: 10000
            });
            
            if (response.data.status === '1' && response.data.result) {
                // Look for ETH transfers (potential bribes)
                const internalTxs = response.data.result;
                let totalBribe = 0;
                
                for (const tx of internalTxs) {
                    // Skip if no value or zero value
                    if (!tx.value || tx.value === '0') continue;
                    
                    // Skip normal contract interactions (to/from token contracts, routers, etc.)
                    const isNormalSwap = 
                        tx.to.toLowerCase().includes('7a250d5630b4cf539739df2c5dacb4c659f2488d') || // Uniswap V2 Router
                        tx.to.toLowerCase().includes('e592427a0aece92de3edee1f18e0157c05861564') || // Uniswap V3 Router
                        tx.to.toLowerCase().includes('c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'); // WETH
                    
                    if (isNormalSwap) continue;
                    
                    // Potential bribe = ETH transfer to unknown address
                    const valueInEth = parseFloat(ethers.formatEther(tx.value));
                    if (valueInEth > 0.001) { // Minimum 0.001 ETH to be considered a bribe
                        totalBribe += valueInEth;
                    }
                }
                
                return totalBribe;
            }
            
            return 0;
        } catch (error) {
            console.warn(`⚠️ Bribe detection failed for ${txHash}:`, error.message);
            return 0;
        }
    }

    async getTokenTransactions(contractAddress) {
        try {
            console.log(`📡 Getting transactions...`);
            const response = await axios.get('https://api.etherscan.io/api', {
                params: {
                    module: 'account',
                    action: 'tokentx',
                    contractaddress: contractAddress,
                    startblock: 0,
                    endblock: 'latest',
                    sort: 'asc',
                    apikey: ETHERSCAN_API_KEY
                },
                timeout: 15000
            });
            
            if (response.data.status !== '1') {
                throw new Error('No transactions found');
            }
            
            console.log(`✅ ${response.data.result.length} transactions found`);
            return response.data.result || [];
        } catch (error) {
            console.error('❌ Transactions error:', error.message);
            throw error;
        }
    }

    async analyzeFirstBuyers(contractAddress, limit = 50) {
        console.log(`🚀 Starting analysis ${contractAddress}`);
        
        const tokenInfo = await this.getTokenInfo(contractAddress);
        const transactions = await this.getTokenTransactions(contractAddress);
        
        if (transactions.length === 0) {
            throw new Error('No transactions found');
        }

        const buyers = new Map();
        const results = [];

        // Skip only really obvious addresses
        const skipAddresses = new Set([
            '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
            '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
            contractAddress.toLowerCase() // The contract itself
        ]);

        for (const tx of transactions) {
            // Skip mints
            if (tx.from === '0x0000000000000000000000000000000000000000') continue;
            
            const buyerAddress = tx.to.toLowerCase();
            
            // Skip only real routers
            if (skipAddresses.has(buyerAddress)) {
                console.log(`⚠️ Skip router: ${buyerAddress}`);
                continue;
            }
            
            if (!buyers.has(buyerAddress)) {
                buyers.set(buyerAddress, true);
                
                // Simple amount calculation
                let amount = 0;
                let supplyPercent = 0;
                try {
                    amount = parseFloat(ethers.formatUnits(tx.value, tokenInfo.decimals));
                    
                    // Calculate supply % if we have total supply
                    if (tokenInfo.totalSupply > 0 && amount > 0) {
                        supplyPercent = (amount / tokenInfo.totalSupply) * 100;
                    }
                } catch (error) {
                    console.warn(`⚠️ Amount error ${tx.hash}:`, error.message);
                    amount = 0;
                    supplyPercent = 0;
                }
                
                // Detect real bribe for the first 30 buyers (to avoid too many API calls)
                let bribeAmount = 0;
                if (results.length < 30) {
                    bribeAmount = await this.getTransactionBribe(tx.hash);
                }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to,
                    amount: amount,
                    supplyPercent: supplyPercent,
                    txHash: tx.hash,
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                    blockNumber: parseInt(tx.blockNumber),
                    bribe: bribeAmount
                });

                console.log(`✅ Buyer #${results.length}: ${tx.to} = ${amount.toLocaleString()} ${tokenInfo.symbol} (${supplyPercent.toFixed(2)}%)`);

                if (results.length >= limit) break;
            }
        }

        if (results.length === 0) {
            throw new Error('No buyers found');
        }

        console.log(`🎯 ${results.length} buyers found`);
        return { tokenInfo, buyers: results, contractAddress };
    }

    formatResults(data, startRank = 1, endRank = 10) {
        const { tokenInfo, buyers, contractAddress } = data;
        
        let message = `🪙 **${tokenInfo.name} (${tokenInfo.symbol})**\n\n`;
        
        // Display total supply if available
        if (tokenInfo.totalSupply > 0) {
            message += `📈 **Total Supply:** ${tokenInfo.totalSupply.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}\n`;
        }
        
        // Add timestamp and block of first trade
        if (buyers.length > 0) {
            message += `📅 **Trading Started:** ${buyers[0].timestamp.toLocaleString('en-US')}\n`;
            message += `🧱 **Block:** [${buyers[0].blockNumber}](https://etherscan.io/txs?block=${buyers[0].blockNumber})\n`;
        }
        
        message += `📝 [Contract](https://etherscan.io/token/${contractAddress})\n\n`;

        // Detect bundle vs snipers based on REAL BRIBES (not same block)
        const firstBlock = buyers.length > 0 ? buyers[0].blockNumber : 0;
        const bundledBuyers = buyers.filter(buyer => buyer.bribe === 0); // No bribe = bundled
        const snipingBuyers = buyers.filter(buyer => buyer.bribe > 0);   // With bribe = snipers
        
        // Show bundle warning if detected
        if (bundledBuyers.length > 1) {
            message += `⚠️ **BUNDLE DETECTED:** ${bundledBuyers.length} wallets without bribes\n`;
            message += `🤖 **Coordinated launch suspected**\n\n`;
        }

        // Select requested range from ALL buyers (bundled + snipers)
        const allBuyers = [...bundledBuyers, ...snipingBuyers];
        const displayBuyers = allBuyers.slice(startRank - 1, endRank);
        
        message += `📊 **Buyers ${startRank}-${Math.min(endRank, buyers.length)} of ${buyers.length} total**\n\n`;

        // Group display by bundled vs snipers within the requested range
        const displayBundled = displayBuyers.filter(buyer => buyer.bribe === 0);
        const displaySnipers = displayBuyers.filter(buyer => buyer.bribe > 0);

        // Show bundled buyers first (if any in range)
        if (displayBundled.length > 0) {
            if (bundledBuyers.length > 1) {
                message += `🤖 **Bundled Buyers** (no bribes):\n`;
            }
            
            displayBundled.forEach((buyer) => {
                const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
                
                message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet})`;
                if (bundledBuyers.length > 1) message += ` 🤖`;
                message += `\n`;
                
                message += `   💰 ${buyer.amount.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}`;
                
                // Add supply percentage if available
                if (buyer.supplyPercent > 0) {
                    if (buyer.supplyPercent >= 0.01) {
                        message += ` **(${buyer.supplyPercent.toFixed(2)}% supply)**`;
                    } else {
                        message += ` **(${buyer.supplyPercent.toFixed(4)}% supply)**`;
                    }
                }
                message += '\n';
                
                message += `   🔗 [TX](https://etherscan.io/tx/${buyer.txHash})\n\n`;
            });
        }

        // Show sniping buyers (if any in range)
        if (displaySnipers.length > 0) {
            if (bundledBuyers.length > 1 && displayBundled.length > 0) {
                message += `📊 **Sniping Buyers** (with bribes):\n`;
            }
            
            displaySnipers.forEach((buyer) => {
                const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
                
                message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet})`;
                if (buyer.bribe > 0) {
                    message += ` 💸 (${buyer.bribe.toFixed(3)} ETH bribe)`;
                }
                message += `\n`;
                
                message += `   💰 ${buyer.amount.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}`;
                
                // Add supply percentage if available
                if (buyer.supplyPercent > 0) {
                    if (buyer.supplyPercent >= 0.01) {
                        message += ` **(${buyer.supplyPercent.toFixed(2)}% supply)**`;
                    } else {
                        message += ` **(${buyer.supplyPercent.toFixed(4)}% supply)**`;
                    }
                }
                message += '\n';
                
                message += `   🔗 [TX](https://etherscan.io/tx/${buyer.txHash})\n\n`;
            });
        }

        // Instructions to see other ranges
        if (buyers.length > 10) {
            message += `\n💡 **To see other buyers:**\n`;
            message += `📋 Type: \`${contractAddress} 11-20\` to see buyers 11-20\n`;
            message += `📋 Type: \`${contractAddress} 21-30\` to see buyers 21-30\n`;
            message += `📋 etc...`;
        }

        return message;
    }
}

const analyzer = new SimpleTokenAnalyzer();

// Commandes du bot
bot.onText(/\/start/, (msg) => {
    const welcomeMessage = `
🤖 **Ethereum Token Analyzer**

**Commands:**
• \`0x1234...\` → First 10 buyers
• \`0x1234... 11-20\` → Buyers 11-20  
• \`0x1234... 21-30\` → Buyers 21-30

⏱️ *Analysis takes 1-2 minutes*
    `;
    
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
});

// Analyze an address (with or without range)
bot.onText(/^(0x[a-fA-F0-9]{40})(?:\s+(\d+)-(\d+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const contractAddress = match[1];
    const startRank = match[2] ? parseInt(match[2]) : 1;
    const endRank = match[3] ? parseInt(match[3]) : 10;
    
    console.log(`📨 Analysis request: ${contractAddress} (${startRank}-${endRank})`);
    
    if (!ethers.isAddress(contractAddress)) {
        bot.sendMessage(chatId, '❌ Invalid address');
        return;
    }

    // Check if range is valid
    if (startRank < 1 || endRank < startRank || endRank > 100) {
        bot.sendMessage(chatId, '❌ Invalid range. Use: 1-10, 11-20, etc. (max 100)');
        return;
    }

    try {
        const loadingMsg = await bot.sendMessage(
            chatId, 
            `🔍 Analysis in progress...\n⏳ Getting buyers ${startRank}-${endRank}`
        );
        
        const results = await analyzer.analyzeFirstBuyers(contractAddress, Math.max(endRank, 50));
        const message = analyzer.formatResults(results, startRank, endRank);
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        console.log(`📤 Sending results ${startRank}-${endRank} (${message.length} chars)`);
        
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
        
        console.log(`✅ Analysis completed for ${contractAddress} (${startRank}-${endRank})`);
        
    } catch (error) {
        console.error('❌ Analysis error:', error.message);
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
});

// Server startup
app.listen(PORT, async () => {
    console.log(`🚀 Server started on port ${PORT}`);
    
    try {
        const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/bot${TELEGRAM_BOT_TOKEN}`;
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
    
    // Keep-alive system to prevent Render from sleeping
    const keepAlive = () => {
        const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
        console.log(`🏓 Keep-alive ping to ${url}`);
        
        axios.get(url)
            .then(() => console.log('✅ Keep-alive successful'))
            .catch(err => console.log('⚠️ Keep-alive failed:', err.message));
    };
    
    // Ping every 10 minutes (600,000ms)
    setInterval(keepAlive, 10 * 60 * 1000);
    console.log('🔄 Keep-alive system activated (ping every 10 minutes)');
    
    console.log('🤖 Bot ready and will stay awake!');
});
