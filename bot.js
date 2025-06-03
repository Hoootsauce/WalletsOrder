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
            // Essayer d'abord avec Etherscan API pour avoir les infos
            const etherscanUrl = `https://api.etherscan.io/api?module=token&action=tokeninfo&contractaddress=${contractAddress}&apikey=${ETHERSCAN_API_KEY}`;
            
            try {
                const response = await axios.get(etherscanUrl);
                if (response.data.status === '1' && response.data.result && response.data.result.length > 0) {
                    const tokenData = response.data.result[0];
                    return {
                        name: tokenData.tokenName || 'Unknown Token',
                        symbol: tokenData.symbol || 'UNKNOWN',
                        decimals: parseInt(tokenData.divisor) || 18
                    };
                }
            } catch (etherscanError) {
                console.log('Etherscan failed, trying contract directly...');
            }

            // Si Etherscan échoue, essayer le contrat directement
            const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            const [name, symbol, decimals] = await Promise.all([
                contract.name().catch(() => 'Unknown Token'),
                contract.symbol().catch(() => 'UNKNOWN'),
                contract.decimals().catch(() => 18)
            ]);

            return { name, symbol, decimals: Number(decimals) };
        } catch (error) {
            console.error('Erreur info token:', error);
            // Retourner des valeurs par défaut
            return {
                name: 'Unknown Token',
                symbol: 'UNKNOWN',
                decimals: 18
            };
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
            // Récupérer les détails via Etherscan API (plus fiable)
            const url = `https://api.etherscan.io/api`;
            const params = {
                module: 'proxy',
                action: 'eth_getTransactionByHash',
                txhash: txHash,
                apikey: ETHERSCAN_API_KEY
            };

            const response = await axios.get(url, { params });
            
            if (response.data.result) {
                const tx = response.data.result;
                const gasPrice = parseInt(tx.gasPrice, 16);
                const maxPriorityFee = tx.maxPriorityFeePerGas ? parseInt(tx.maxPriorityFeePerGas, 16) : 0;
                
                return {
                    gasPrice: (gasPrice / 1e9).toFixed(1), // Convertir en Gwei
                    priorityFee: (maxPriorityFee / 1e9).toFixed(1)
                };
            }
            
            // Fallback vers provider direct
            const tx = await this.provider.getTransaction(txHash);
            if (tx && tx.gasPrice) {
                return {
                    gasPrice: ethers.formatUnits(tx.gasPrice, 'gwei'),
                    priorityFee: tx.maxPriorityFeePerGas ? 
                        ethers.formatUnits(tx.maxPriorityFeePerGas, 'gwei') : '0'
                };
            }
            
            return { gasPrice: 'N/A', priorityFee: '0' };
        } catch (error) {
            console.error('Erreur transaction details:', error);
            return { gasPrice: 'N/A', priorityFee: '0' };
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
                
                // Calculer la quantité avec les bonnes décimales
                let amount;
                try {
                    amount = parseFloat(ethers.formatUnits(tx.value, tokenInfo.decimals));
                } catch (error) {
                    // Si erreur de formatage, essayer avec 18 décimales par défaut
                    amount = parseFloat(ethers.formatUnits(tx.value, 18));
                }
                
                // Ne récupérer les détails que pour les premiers (pour économiser les appels API)
                let txDetails = { gasPrice: 'N/A', priorityFee: '0' };
                if (results.length < 20) { // Seulement pour les 20 premiers
                    txDetails = await this.getTransactionDetails(tx.hash);
                }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to, // Adresse complète, pas en minuscules
                    amount: amount,
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
        message += `📝 [Contrat sur Etherscan](https://etherscan.io/token/${contractAddress})\n\n`;

        buyers.forEach((buyer) => {
            // Adresse complète avec lien cliquable
            const fullAddress = buyer.wallet;
            const shortAddress = `${fullAddress.slice(0, 6)}...${fullAddress.slice(-4)}`;
            
            message += `**${buyer.rank}.** [${shortAddress}](https://etherscan.io/address/${fullAddress})\n`;
            message += `   💰 ${buyer.amount.toLocaleString('fr-FR', {maximumFractionDigits: 3})} ${tokenInfo.symbol}\n`;
            message += `   ⛽ ${buyer.gasPrice} Gwei`;
            
            if (parseFloat(buyer.priorityFee) > 0) {
                message += ` (+${buyer.priorityFee} bribe)`;
            }
            
            message += `\n   🕒 ${buyer.timestamp.toLocaleString('fr-FR')}\n`;
            message += `   🔗 [Transaction](https://etherscan.io/tx/${buyer.txHash})\n\n`;
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
