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
                const internalTxs = response.data.result;
                let totalBribe = 0;
                
                // Known addresses that are NOT bribes (normal DeFi operations + MEV bots)
                const legitimateAddresses = new Set([
                    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
                    '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
                    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 Router 2
                    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
                    '0xa0b86a33e6dd3d49f8c5c31c1ed1c5478d9fc59f', // WETH9
                    '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch
                    '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Protocol
                    '0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49', // Banana Gun Router
                    '0x00000000a991c429ee2ec6df19d40fe0c80088b8', // Banana Gun Router 2
                    '0x37a8f295612602f2774d331e562be9e61b83a327', // Maestro Router
                    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'  // BonkBot Router
                ]);
                
                for (const tx of internalTxs) {
                    // Skip if no value or zero value
                    if (!tx.value || tx.value === '0') continue;
                    
                    const toAddress = tx.to.toLowerCase();
                    const fromAddress = tx.from.toLowerCase();
                    
                    // Skip normal DeFi operations (swaps, deposits, etc.) and MEV bots
                    if (legitimateAddresses.has(toAddress) || legitimateAddresses.has(fromAddress)) {
                        continue;
                    }
                    
                    // Skip transactions between known contracts and MEV bot interactions
                    if (tx.type === 'call' && (
                        toAddress.startsWith('0xc02aaa') || 
                        toAddress.includes('uniswap') ||
                        toAddress.includes('3328f7f4') || // Banana Gun patterns
                        fromAddress.includes('3328f7f4')
                    )) {
                        continue;
                    }
                    
                    // Check if it's a potential bribe (ETH to validator/builder)
                    const valueInEth = parseFloat(ethers.formatEther(tx.value));
                    
                    // Only consider as bribe if:
                    // 1. Value > 0.001 ETH (any amount above dust)
                    // 2. Not going to a known DeFi contract or MEV bot
                    // 3. Going to a validator/builder address (not a contract)
                    if (valueInEth > 0.001) {
                        // Check if destination looks like a validator/builder
                        const isValidatorLike = 
                            !legitimateAddresses.has(toAddress) &&
                            !toAddress.includes('3328f7f4') && // Not Banana Gun
                            !toAddress.includes('uniswap') &&
                            toAddress.length === 42 && // Valid ETH address
                            tx.type !== 'staticcall'; // Not a view call
                        
                        // Additional check: get block info to see if it's the coinbase (validator)
                        // For now, assume unknown addresses receiving ETH are potential bribes
                        if (isValidatorLike) {
                            console.log(`🔍 Potential bribe detected: ${valueInEth} ETH to ${toAddress} (possible validator/builder)`);
                            totalBribe += valueInEth;
                        }
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
                
                // Detect real bribe only until we find the first one + 4 more (total 5 bribes)
                let bribeAmount = 0;
                
                // Check if we already found the end of bundle in previous iterations
                const bundleEndFound = results.some(r => r.bribe > 0);
                const bribesFound = results.filter(r => r.bribe > 0).length;
                
                if ((!bundleEndFound || bribesFound < 5) && results.length < 50) { // Check until 5 bribes found
                    bribeAmount = await this.getTransactionBribe(tx.hash);
                    if (bribeAmount > 0) {
                        console.log(`🔍 Bribe #${bribesFound + 1} detected at position ${results.length + 1}: ${bribeAmount} ETH`);
                    }
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

        // Filter out LP (usually the first buyer with massive supply %)
        let filteredResults = results;
        if (results.length > 0 && results[0].supplyPercent > 50) {
            console.log(`🏊 Detected LP at rank 1 with ${results[0].supplyPercent.toFixed(2)}% supply - excluding from analysis`);
            filteredResults = results.slice(1); // Remove first buyer (LP)
            
            // Rerank the remaining buyers
            filteredResults = filteredResults.map((buyer, index) => ({
                ...buyer,
                rank: index + 1
            }));
        }

        console.log(`🎯 ${filteredResults.length} real buyers found (LP excluded)`);
        return { tokenInfo, buyers: filteredResults, contractAddress };
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

        // Detect bundle vs snipers based on REAL BRIBES
        // Bundle = all buyers BEFORE the first bribe is detected
        let bundleEndRank = buyers.length; // Default: all are bundled if no bribe found
        
        for (let i = 0; i < buyers.length; i++) {
            if (buyers[i].bribe > 0) {
                bundleEndRank = buyers[i].rank - 1; // Bundle ends just before first bribe
                console.log(`🔍 Bundle ends at rank ${bundleEndRank}, first bribe at rank ${buyers[i].rank}`);
                break;
            }
        }
        
        const bundledBuyers = buyers.filter(buyer => buyer.rank <= bundleEndRank);
        const snipingBuyers = buyers.filter(buyer => buyer.rank > bundleEndRank);
        
        // Show bundle detection info
        if (bundledBuyers.length > 1) {
            // Calculate total supply bundled
            const totalBundledSupply = bundledBuyers.reduce((sum, buyer) => sum + buyer.supplyPercent, 0);
            
            message += `⚠️ **BUNDLE DETECTED:** ${bundledBuyers.length} wallets (ranks 1-${bundleEndRank})\n`;
            message += `🎒 **Bundled Supply:** ${totalBundledSupply.toFixed(2)}% of total supply\n`;
            if (snipingBuyers.length > 0) {
                message += `🎯 **First bribe at rank ${bundleEndRank + 1}** - bundle ends here\n`;
            }
            message += `🤖 **Coordinated launch confirmed**\n\n`;
        }

        // Select requested range from ALL buyers (bundled + snipers)
        const allBuyers = [...bundledBuyers, ...snipingBuyers];
        const displayBuyers = allBuyers.slice(startRank - 1, endRank);
        
        message += `📊 **Buyers ${startRank}-${Math.min(endRank, buyers.length)} of ${buyers.length} total**\n\n`;

        // Group display by bundled vs snipers within the requested range
        const displayBundled = displayBuyers.filter(buyer => buyer.rank <= bundleEndRank);
        const displaySnipers = displayBuyers.filter(buyer => buyer.rank > bundleEndRank);

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
                
                // Show bribe amount if detected (for first 5 snipers)
                if (buyer.bribe > 0) {
                    message += ` 💸 **${buyer.bribe.toFixed(3)} ETH bribe**`;
                } else if (buyer.rank > bundleEndRank) {
                    // This is a sniper but we didn't check their bribe (beyond first 5)
                    message += ` 🎯`;
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
