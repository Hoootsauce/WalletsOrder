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

    async getTransactionDetails(txHash) {
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
                    priorityFee: (maxPriorityFee / 1e9).toFixed(1)
                };
            }
            
            return { gasPrice: 'N/A', priorityFee: '0' };
        } catch (error) {
            console.warn(`⚠️ Gas details failed for ${txHash}:`, error.message);
            return { gasPrice: 'N/A', priorityFee: '0' };
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
                
                // Gas details for first 15 (optional now)
                // let gasDetails = { gasPrice: 'N/A', priorityFee: '0' };
                // if (results.length < 15) {
                //     gasDetails = await this.getTransactionDetails(tx.hash);
                // }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to,
                    amount: amount,
                    supplyPercent: supplyPercent,
                    txHash: tx.hash,
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000)
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
        
        // Add timestamp of first trade
        if (buyers.length > 0) {
            message += `📅 **Trading Started:** ${buyers[0].timestamp.toLocaleString('en-US')}\n`;
        }
        
        message += `📝 [Contract](https://etherscan.io/token/${contractAddress})\n\n`;
        message += `📊 **Buyers ${startRank}-${Math.min(endRank, buyers.length)} of ${buyers.length} total**\n\n`;

        // Select requested range
        const displayBuyers = buyers.slice(startRank - 1, endRank);

        displayBuyers.forEach((buyer) => {
            const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
            
            message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet})\n`;
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
    
    console.log('🤖 Simple Bot ready!');
});
