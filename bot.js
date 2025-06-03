const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

// Configuration depuis les variables d'environnement
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

// Vérification des variables
if (!TELEGRAM_BOT_TOKEN || !ETHEREUM_RPC_URL || !ETHERSCAN_API_KEY) {
    console.error('❌ Variables d\'environnement manquantes!');
    console.error('Vérifiez: TELEGRAM_BOT_TOKEN, ETHEREUM_RPC_URL, ETHERSCAN_API_KEY');
    process.exit(1);
}

// Initialisation
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL);

console.log('🤖 Bot Telegram démarré!');
console.log('🔗 Connecté à Ethereum');

// ABI pour les contrats ERC-20
const ERC20_ABI = [
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function name() external view returns (string)"
];

class TokenAnalyzer {
    constructor() {
        this.provider = provider;
    }

    async getTokenInfo(contractAddress) {
        try {
            const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            const [name, symbol, decimals] = await Promise.all([
                contract.name().catch(() => 'Unknown'),
                contract.symbol().catch(() => 'Unknown'),
                contract.decimals().catch(() => 18)
            ]);

            return { name, symbol, decimals };
        } catch (error) {
            console.error('Erreur info token:', error);
            return null;
        }
    }

    async getTokenTransactions(contractAddress) {
        try {
            const url = `https://api.etherscan.io/api`;
            const params = {
                module: 'account',
                action: 'tokentx',
                contractaddress: contractAddress,
                startblock: 0,
                endblock: 'latest',
                sort: 'asc',
                apikey: ETHERSCAN_API_KEY
            };

            const response = await axios.get(url, { params });
            
            if (response.data.status !== '1') {
                throw new Error('Aucune transaction trouvée');
            }
            
            return response.data.result || [];
        } catch (error) {
            console.error('Erreur Etherscan:', error);
            throw error;
        }
    }

    async getTransactionDetails(txHash) {
        try {
            const tx = await this.provider.getTransaction(txHash);
            const receipt = await this.provider.getTransactionReceipt(txHash);
            
            if (!tx || !receipt) {
                return { gasPrice: '0', gasUsed: '0', priorityFee: '0' };
            }
            
            return {
                gasPrice: ethers.formatUnits(tx.gasPrice || 0, 'gwei'),
                gasUsed: receipt.gasUsed.toString(),
                priorityFee: tx.maxPriorityFeePerGas ? 
                    ethers.formatUnits(tx.maxPriorityFeePerGas, 'gwei') : '0'
            };
        } catch (error) {
            return { gasPrice: '0', gasUsed: '0', priorityFee: '0' };
        }
    }

    async analyzeFirstBuyers(contractAddress, limit = 50) {
        console.log(`🔍 Analyse de ${contractAddress}...`);
        
        const tokenInfo = await this.getTokenInfo(contractAddress);
        if (!tokenInfo) {
            throw new Error('Token introuvable ou invalide');
        }

        const transactions = await this.getTokenTransactions(contractAddress);
        
        if (transactions.length === 0) {
            throw new Error('Aucune transaction trouvée');
        }

        const buyers = new Map();
        const results = [];

        for (const tx of transactions) {
            if (tx.from === '0x0000000000000000000000000000000000000000') continue;
            
            const buyerAddress = tx.to.toLowerCase();
            
            if (!buyers.has(buyerAddress)) {
                buyers.set(buyerAddress, true);
                
                const txDetails = await this.getTransactionDetails(tx.hash);
                const amount = ethers.formatUnits(tx.value, tokenInfo.decimals);
                
                results.push({
                    rank: results.length + 1,
                    wallet: buyerAddress,
                    amount: parseFloat(amount),
                    txHash: tx.hash,
                    blockNumber: parseInt(tx.blockNumber),
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                    gasPrice: txDetails.gasPrice,
                    priorityFee: txDetails.priorityFee
                });

                if (results.length >= limit) break;
            }
        }

        return { tokenInfo, buyers: results, contractAddress };
    }

    formatResults(data, range = '1-50') {
        const { tokenInfo, buyers, contractAddress } = data;
        
        let message = `🪙 **${tokenInfo.name} (${tokenInfo.symbol})**\n\n`;
        message += `📊 **Top ${buyers.length} premiers acheteurs**\n`;
        message += `📝 \`${contractAddress}\`\n\n`;

        buyers.forEach((buyer) => {
            message += `**${buyer.rank}.** \`${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}\`\n`;
            message += `   💰 ${buyer.amount.toLocaleString()} ${tokenInfo.symbol}\n`;
            message += `   ⛽ ${parseFloat(buyer.gasPrice).toFixed(1)} Gwei`;
            if (parseFloat(buyer.priorityFee) > 0) {
                message += ` (+${parseFloat(buyer.priorityFee).toFixed(1)} bribe)`;
            }
            message += `\n   🕒 ${buyer.timestamp.toLocaleString('fr-FR')}\n\n`;
        });

        return message;
    }
}

const analyzer = new TokenAnalyzer();

// Commandes du bot
bot.onText(/\/start/, (msg) => {
    const welcomeMessage = `
🤖 **Analyseur de Tokens Ethereum**

**Comment utiliser :**
1️⃣ Envoyez l'adresse d'un contrat de token
2️⃣ Obtenez la liste des premiers acheteurs

**Exemple :**
\`0x1234567890123456789012345678901234567890\`

**Ou utilisez :**
\`/analyze 0x1234567890123456789012345678901234567890\`

⏱️ *L'analyse prend 1-2 minutes*
    `;
    
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
});

// Analyser une adresse directement ou avec /analyze
bot.onText(/^(0x[a-fA-F0-9]{40})$|^\/analyze (0x[a-fA-F0-9]{40})/, async (msg, match) => {
    const chatId = msg.chat.id;
    const contractAddress = match[1] || match[2];
    
    if (!ethers.isAddress(contractAddress)) {
        bot.sendMessage(chatId, '❌ Adresse invalide');
        return;
    }

    try {
        const loadingMsg = await bot.sendMessage(
            chatId, 
            `🔍 Analyse en cours...\n⏳ Patientez 1-2 minutes`, 
            { parse_mode: 'Markdown' }
        );
        
        const results = await analyzer.analyzeFirstBuyers(contractAddress, 50);
        const message = analyzer.formatResults(results);
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        // Diviser si trop long
        if (message.length > 4000) {
            const parts = message.match(/[\s\S]{1,4000}/g);
            for (const part of parts) {
                await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
            }
        } else {
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
        
    } catch (error) {
        console.error('Erreur:', error);
        bot.sendMessage(chatId, `❌ Erreur: ${error.message}`);
    }
});

// Gestion des erreurs
bot.on('error', console.error);
bot.on('polling_error', console.error);

console.log('✅ Bot prêt à analyser les tokens!');
