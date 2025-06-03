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

// Initialisation en mode webhook (pas polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL);

// Configuration du serveur web pour les webhooks
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint pour recevoir les messages de Telegram
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Page d'accueil simple
app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 Bot Telegram Token Analyzer</h1>
        <p>✅ Bot actif et fonctionnel</p>
        <p>📱 Utilisez le bot sur Telegram</p>
        <p>⏰ Dernière mise à jour: ${new Date().toLocaleString('fr-FR')}</p>
    `);
});

// Démarrer le serveur
app.listen(PORT, async () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    
    // Configurer le webhook
    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/bot${TELEGRAM_BOT_TOKEN}`;
    
    try {
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook configuré: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Erreur webhook:', error);
    }
    
    console.log('🤖 Bot Telegram prêt!');
    console.log('🔗 Connecté à Ethereum');
});

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
            // Essayer plusieurs méthodes pour obtenir les infos du token
            
            // 1. Essayer l'API Etherscan pour les tokens vérifiés
            const etherscanUrl = `https://api.etherscan.io/api`;
            try {
                const response = await axios.get(etherscanUrl, {
                    params: {
                        module: 'token',
                        action: 'tokeninfo',
                        contractaddress: contractAddress,
                        apikey: ETHERSCAN_API_KEY
                    }
                });
                
                if (response.data.status === '1' && response.data.result && response.data.result.length > 0) {
                    const tokenData = response.data.result[0];
                    console.log('✅ Token info from Etherscan:', tokenData);
                    return {
                        name: tokenData.tokenName || 'Unknown Token',
                        symbol: tokenData.symbol || 'UNKNOWN',
                        decimals: parseInt(tokenData.divisor) || 18
                    };
                }
            } catch (etherscanError) {
                console.log('⚠️ Etherscan token API failed, trying contract...');
            }

            // 2. Essayer de lire directement le contrat
            const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            try {
                const [name, symbol, decimals] = await Promise.all([
                    contract.name().catch(() => 'Unknown Token'),
                    contract.symbol().catch(() => 'UNKNOWN'),
                    contract.decimals().catch(() => 18)
                ]);

                console.log('✅ Token info from contract:', { name, symbol, decimals: Number(decimals) });
                return { 
                    name: name || 'Unknown Token', 
                    symbol: symbol || 'UNKNOWN', 
                    decimals: Number(decimals) || 18 
                };
            } catch (contractError) {
                console.log('⚠️ Contract read failed');
            }

            // 3. Fallback : essayer via les logs de création du contrat
            try {
                const creationLogs = await this.provider.getLogs({
                    address: contractAddress,
                    fromBlock: 'earliest',
                    toBlock: 'latest',
                    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] // Transfer topic
                });
                
                if (creationLogs.length > 0) {
                    console.log('✅ Token has transfer logs, assume ERC20');
                    return {
                        name: 'New Token',
                        symbol: 'NEW',
                        decimals: 18
                    };
                }
            } catch (logError) {
                console.log('⚠️ Log search failed');
            }

            // Dernier recours
            return {
                name: 'Unknown Token',
                symbol: 'UNKNOWN',
                decimals: 18
            };
        } catch (error) {
            console.error('❌ Erreur complete token info:', error);
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

        // Adresses à ignorer (LP, routers, bridges communs)
        const ignoredAddresses = new Set([
            '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router
            '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 Router
            '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap V3 Router 2
            '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch
            '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Protocol
            contractAddress.toLowerCase() // Le contrat lui-même
        ]);

        for (const tx of transactions) {
            // Ignorer les mints depuis 0x0
            if (tx.from === '0x0000000000000000000000000000000000000000') continue;
            
            const buyerAddress = tx.to.toLowerCase();
            
            // Ignorer les adresses de LP/DEX/Routers
            if (ignoredAddresses.has(buyerAddress)) continue;
            
            // Vérifier si c'est un contrat (heuristique simple)
            if (await this.isContract(buyerAddress)) {
                console.log(`⚠️ Ignoré contrat: ${buyerAddress}`);
                continue;
            }
            
            if (!buyers.has(buyerAddress)) {
                buyers.set(buyerAddress, true);
                
                // Calculer la quantité avec les bonnes décimales
                let amount;
                try {
                    // Convertir le montant avec les vraies décimales
                    const rawAmount = ethers.formatUnits(tx.value, tokenInfo.decimals);
                    amount = parseFloat(rawAmount);
                } catch (error) {
                    console.warn(`⚠️ Erreur conversion montant pour ${tx.hash}:`, error);
                    amount = 0;
                }
                
                // Ne récupérer les détails gas que pour les premiers
                let txDetails = { gasPrice: 'N/A', priorityFee: '0' };
                if (results.length < 15) {
                    txDetails = await this.getTransactionDetails(tx.hash);
                }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to, // Adresse complète
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

    // Fonction pour vérifier si une adresse est un contrat
    async isContract(address) {
        try {
            const code = await this.provider.getCode(address);
            return code !== '0x';
        } catch (error) {
            return false;
        }
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
            message += `   💰 ${buyer.amount.toLocaleString('fr-FR', {maximumFractionDigits: 0})} ${tokenInfo.symbol}\n`;
            
            // Affichage du gas (sans confusion avec bribe)
            if (buyer.gasPrice !== 'N/A') {
                message += `   ⛽ ${buyer.gasPrice} Gwei`;
                if (parseFloat(buyer.priorityFee) > 0) {
                    message += ` (tip: +${buyer.priorityFee})`;
                }
            } else {
                message += `   ⛽ Gas info non disponible`;
            }
            
            message += `\n   🕒 ${buyer.timestamp.toLocaleString('fr-FR')}\n`;
            message += `   🔗 [Transaction](https://etherscan.io/tx/${buyer.txHash})\n\n`;
        });

        message += `\n💡 *Note: Les vrais "bribes" MEV ne sont pas visibles ici car ils sont envoyés via Flashbots ou transfers directs aux validators.*`;

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
bot.on('error', (error) => {
    console.error('❌ Erreur bot:', error);
});

console.log('✅ Bot configuré et prêt à analyser les tokens!');
