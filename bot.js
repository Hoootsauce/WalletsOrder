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

// Initialisation with retry and fallback
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
let provider;

// Configuration du provider avec fallback
try {
    provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL, {
        name: 'mainnet',
        chainId: 1
    async getTransactionDetails(txHash) {);
    console.log('🔗 Provider configured with main URL');
} catch (error) {
    console.error('❌ Main provider error:', error);
    provider = new ethers.JsonRpcProvider('https://rpc.ankr.com/eth', {
        name: 'mainnet', 
        chainId: 1
    });
    console.log('🔄 Fallback to public Ankr RPC');
}

// Express server
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

// Basic ABI
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

    async getBribeAmount(txHash) {
        try {
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
                // Chercher les Transfer directs (pas les Deposit/Swap)
                for (const tx of response.data.result) {
                    // Transfer direct = input vide ou très court (pas un swap complexe)
                    if (tx.input === '0x' || tx.input.length <= 10) {
                        const bribeAmount = parseFloat(ethers.formatEther(tx.value));
                        if (bribeAmount > 0) {
                            return bribeAmount;
                        }
                    }
                }
            }
            
            return 0;
        } catch (error) {
            console.warn(`⚠️ Bribe detection failed for ${txHash}:`, error.message);
            return 0;
        }
    }
        try {
            const response = await axios.get('https://api.etherscan.io/api', {
                params: {
                    module: 'proxy',
                    action: 'eth_getTransactionByHash',
                    txhash: txHash,
                    apikey: ETHERSCAN_API_KEY
                },
                timeout: 10000
            });
            
            if (response.data.result) {
                const tx = response.data.result;
                const gasPrice = parseInt(tx.gasPrice, 16);
                const maxPriorityFee = tx.maxPriorityFeePerGas ? parseInt(tx.maxPriorityFeePerGas, 16) : 0;
                
                return {
                    gasPrice: (gasPrice / 1e9).toFixed(1),
                    priorityFee: (maxPriorityFee / 1e9).toFixed(1),
                    transactionIndex: parseInt(tx.transactionIndex, 16)
                };
            }
            
            return { gasPrice: 'N/A', priorityFee: '0', transactionIndex: 999 };
        } catch (error) {
            console.warn(`⚠️ Gas details failed for ${txHash}:`, error.message);
            return { gasPrice: 'N/A', priorityFee: '0', transactionIndex: 999 };
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

    async analyzeFirstBuyers(contractAddress, limit = 100) {
        console.log(`🚀 Starting analysis ${contractAddress}`);
        
        const tokenInfo = await this.getTokenInfo(contractAddress);
        const transactions = await this.getTokenTransactions(contractAddress);
        
        if (transactions.length === 0) {
            throw new Error('No transactions found');
        }

        const buyers = new Map();
        const results = [];

        const skipAddresses = new Set([
            '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
            '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
            contractAddress.toLowerCase()
        ]);

        for (const tx of transactions) {
            if (tx.from === '0x0000000000000000000000000000000000000000') continue;
            
            const buyerAddress = tx.to.toLowerCase();
            
            if (skipAddresses.has(buyerAddress)) {
                console.log(`⚠️ Skip router: ${buyerAddress}`);
                continue;
            }
            
            if (!buyers.has(buyerAddress)) {
                buyers.set(buyerAddress, true);
                
                let amount = 0;
                let supplyPercent = 0;
                try {
                    amount = parseFloat(ethers.formatUnits(tx.value, tokenInfo.decimals));
                    
                    if (tokenInfo.totalSupply > 0 && amount > 0) {
                        supplyPercent = (amount / tokenInfo.totalSupply) * 100;
                    }
                } catch (error) {
                    console.warn(`⚠️ Amount error ${tx.hash}:`, error.message);
                    amount = 0;
                    supplyPercent = 0;
                }
                
                // Get gas details for first 100 buyers
                let gasDetails = { gasPrice: 'N/A', priorityFee: '0', transactionIndex: 999 };
                let bribeAmount = 0;
                
                if (results.length < 100) {
                    gasDetails = await this.getTransactionDetails(tx.hash);
                    // Get bribe amount for potential snipers (after we know if it's bundle or not)
                    bribeAmount = await this.getBribeAmount(tx.hash);
                }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to,
                    amount: amount,
                    supplyPercent: supplyPercent,
                    txHash: tx.hash,
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                    blockNumber: parseInt(tx.blockNumber),
                    gasPrice: parseFloat(gasDetails.gasPrice) || 0,
                    priorityFee: parseFloat(gasDetails.priorityFee) || 0,
                    transactionIndex: gasDetails.transactionIndex,
                    bribeAmount: bribeAmount
                });

                console.log(`✅ Buyer #${results.length}: ${tx.to} = ${amount.toLocaleString()} ${tokenInfo.symbol} (${supplyPercent.toFixed(2)}%)`);

                if (results.length >= limit) break;
            }
        }

        if (results.length === 0) {
            throw new Error('No buyers found');
        }

        // Filter out LP (usually the first buyer with massive supply %)
        let finalResults = results;
        if (results.length > 0 && results[0].supplyPercent > 50) {
            console.log(`🏊 Detected LP at rank 1 with ${results[0].supplyPercent.toFixed(2)}% supply - excluding from analysis`);
            finalResults = results.slice(1);
            
            // Rerank the remaining buyers
            finalResults = finalResults.map((buyer, index) => ({
                ...buyer,
                rank: index + 1
            }));
        }

        console.log(`🎯 ${finalResults.length} real buyers found (LP excluded)`);
        return { tokenInfo, buyers: finalResults, contractAddress };
    }

    formatResults(data, startRank = 1, endRank = 10) {
        const { tokenInfo, buyers, contractAddress } = data;
        
        let message = `🪙 **${tokenInfo.name} (${tokenInfo.symbol})**\n\n`;
        
        if (tokenInfo.totalSupply > 0) {
            message += `📈 **Total Supply:** ${tokenInfo.totalSupply.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}\n`;
        }
        
        if (buyers.length > 0) {
            message += `📅 **Trading Started:** ${buyers[0].timestamp.toLocaleString('en-US')}\n`;
            message += `🧱 **Block:** [${buyers[0].blockNumber}](https://etherscan.io/txs?block=${buyers[0].blockNumber})\n`;
        }
        
        message += `📝 [Contract](https://etherscan.io/token/${contractAddress})\n\n`;

        // Detect bundle vs snipers: CONSECUTIVE POSITIONS + SAME GAS
        let bundleEndRank = buyers.length;
        
        // Bundle = positions consécutives + même gas que les précédents
        for (let i = 1; i < buyers.length; i++) {
            const current = buyers[i];
            const previous = buyers[i - 1];
            
            // Positions non-consécutives (manque une position)
            const positionGap = current.transactionIndex - previous.transactionIndex;
            const notConsecutive = positionGap > 1;
            
            // Gas différent (hausse ou baisse)
            const gasChange = Math.abs(current.gasPrice - previous.gasPrice) > 0.1;
            
            // Fin du bundle = dès que positions non-consécutives OU gas change
            if (notConsecutive || gasChange) {
                bundleEndRank = i;
                console.log(`🔍 Bundle end detected at rank ${bundleEndRank}:`);
                if (notConsecutive) {
                    console.log(`   Position break: ${previous.transactionIndex} → ${current.transactionIndex} (gap: ${positionGap})`);
                }
                if (gasChange) {
                    console.log(`   Gas change: ${previous.gasPrice} → ${current.gasPrice} Gwei`);
                }
                break;
            }
        }
        
        const bundledBuyers = buyers.filter(buyer => buyer.rank <= bundleEndRank);
        const snipingBuyers = buyers.filter(buyer => buyer.rank > bundleEndRank);
        
        // Show bundle detection info
        if (bundledBuyers.length > 1) {
            const totalBundledSupply = bundledBuyers.reduce((sum, buyer) => sum + buyer.supplyPercent, 0);
            
            message += `⚠️ **BUNDLE DETECTED:** ${bundledBuyers.length} wallets (ranks 1-${bundleEndRank})\n`;
            message += `🎒 **Bundled Supply:** ${totalBundledSupply.toFixed(2)}% of total supply\n`;
            if (snipingBuyers.length > 0) {
                const firstSniper = snipingBuyers[0];
                message += `🎯 **First sniper at rank ${firstSniper.rank}** (${firstSniper.gasPrice} Gwei)\n`;
            }
            message += `🤖 **Consecutive positions + same gas pattern**\n\n`;
        }

        // Select requested range from ALL buyers
        const allBuyers = [...bundledBuyers, ...snipingBuyers];
        const displayBuyers = allBuyers.slice(startRank - 1, endRank);
        
        message += `📊 **Buyers ${startRank}-${Math.min(endRank, buyers.length)} of ${buyers.length} total**\n\n`;

        // Group display by bundled vs snipers within the requested range
        const displayBundled = displayBuyers.filter(buyer => buyer.rank <= bundleEndRank);
        const displaySnipers = displayBuyers.filter(buyer => buyer.rank > bundleEndRank);

        // Show bundled buyers first
        if (displayBundled.length > 0) {
            if (bundledBuyers.length > 1) {
                message += `🤖 **Bundled Buyers** (consecutive positions + same gas):\n`;
            }
            
            displayBundled.forEach((buyer) => {
                const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
                
                message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet})`;
                if (bundledBuyers.length > 1) message += ` 🤖`;
                message += `\n`;
                
                message += `   💰 ${buyer.amount.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}`;
                
                if (buyer.supplyPercent > 0) {
                    if (buyer.supplyPercent >= 0.01) {
                        message += ` **(${buyer.supplyPercent.toFixed(2)}% supply)**`;
                    } else {
                        message += ` **(${buyer.supplyPercent.toFixed(4)}% supply)**`;
                    }
                }
                message += '\n';
                
                if (buyer.gasPrice > 0) {
                    message += `   📍 Block pos: ${buyer.transactionIndex}\n`;
                }
                
                message += `   🔗 [TX](https://etherscan.io/tx/${buyer.txHash})\n\n`;
            });
        }

        // Show sniping buyers
        if (displaySnipers.length > 0) {
            if (bundledBuyers.length > 1 && displayBundled.length > 0) {
                message += `📊 **Sniping Buyers** (position break or gas change):\n`;
            }
            
            displaySnipers.forEach((buyer) => {
                const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
                
                message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet}) 🎯\n`;
                
                message += `   💰 ${buyer.amount.toLocaleString('en-US', {maximumFractionDigits: 0})} ${tokenInfo.symbol}`;
                
                if (buyer.supplyPercent > 0) {
                    if (buyer.supplyPercent >= 0.01) {
                        message += ` **(${buyer.supplyPercent.toFixed(2)}% supply)**`;
                    } else {
                        message += ` **(${buyer.supplyPercent.toFixed(4)}% supply)**`;
                    }
                }
                message += '\n';
                
                if (buyer.gasPrice > 0) {
                    message += `   📍 Block pos: ${buyer.transactionIndex}\n`;
                }
                
                // Show bribe for first 10 snipers
                if (buyer.bribeAmount > 0 && (buyer.rank - bundleEndRank) <= 10) {
                    message += `   💰 Bribe: ${buyer.bribeAmount.toFixed(3)} ETH\n`;
                }
                
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

// Bot commands
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

    if (startRank < 1 || endRank < startRank || endRank > 100) {
        bot.sendMessage(chatId, '❌ Invalid range. Use: 1-10, 11-20, etc. (max 100)');
        return;
    }

    try {
        const loadingMsg = await bot.sendMessage(
            chatId, 
            `🔍 Analysis in progress...\n⏳ Getting buyers ${startRank}-${endRank}`
        );
        
        const results = await analyzer.analyzeFirstBuyers(contractAddress, Math.max(endRank, 100));
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
