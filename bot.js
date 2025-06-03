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

// Initialisation avec retry et fallback
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
let provider;

// Configuration du provider avec fallback
try {
    provider = new ethers.JsonRpcProvider(ETHEREUM_RPC_URL, {
        name: 'mainnet',
        chainId: 1
    });
    console.log('🔗 Provider configuré avec URL principale');
} catch (error) {
    console.error('❌ Erreur provider principal:', error);
    // Fallback sur un RPC public
    provider = new ethers.JsonRpcProvider('https://rpc.ankr.com/eth', {
        name: 'mainnet', 
        chainId: 1
    });
    console.log('🔄 Fallback vers RPC public Ankr');
}

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
            console.log(`🔍 Récupération infos token: ${contractAddress}`);
            
            // 1. Essayer l'API Etherscan pour les infos générales du contrat
            try {
                const response = await axios.get('https://api.etherscan.io/api', {
                    params: {
                        module: 'contract',
                        action: 'getsourcecode',
                        address: contractAddress,
                        apikey: ETHERSCAN_API_KEY
                    },
                    timeout: 10000
                });
                
                if (response.data.status === '1' && response.data.result[0]) {
                    const contractData = response.data.result[0];
                    if (contractData.ContractName && contractData.ContractName !== '') {
                        console.log('✅ Infos depuis Etherscan contract:', contractData.ContractName);
                        
                        // Essayer de deviner le symbole depuis le nom
                        let symbol = contractData.ContractName.toUpperCase();
                        if (symbol.includes('TOKEN')) symbol = symbol.replace('TOKEN', '');
                        if (symbol.includes('COIN')) symbol = symbol.replace('COIN', '');
                        symbol = symbol.slice(0, 10); // Limiter la longueur
                        
                        return {
                            name: contractData.ContractName,
                            symbol: symbol,
                            decimals: 18
                        };
                    }
                }
            } catch (etherscanError) {
                console.log('⚠️ Etherscan contract API failed:', etherscanError.message);
            }

            // 2. Essayer de lire directement le contrat
            try {
                console.log('📞 Tentative lecture directe du contrat...');
                const contract = new ethers.Contract(contractAddress, ERC20_ABI, provider);
                
                // Test de connection d'abord
                await provider.getBlockNumber();
                console.log('✅ Provider connecté');
                
                const [name, symbol, decimals] = await Promise.allSettled([
                    contract.name(),
                    contract.symbol(),
                    contract.decimals()
                ]);

                const tokenName = name.status === 'fulfilled' ? name.value : 'Unknown Token';
                const tokenSymbol = symbol.status === 'fulfilled' ? symbol.value : 'UNKNOWN';
                const tokenDecimals = decimals.status === 'fulfilled' ? Number(decimals.value) : 18;
                
                console.log('✅ Token info depuis contrat:', { name: tokenName, symbol: tokenSymbol, decimals: tokenDecimals });
                
                return { 
                    name: tokenName, 
                    symbol: tokenSymbol, 
                    decimals: tokenDecimals 
                };
            } catch (contractError) {
                console.log('⚠️ Lecture contrat échouée:', contractError.message);
            }

            // 3. Dernier recours : analyser les premières transactions pour deviner
            try {
                const firstTxs = await this.getTokenTransactions(contractAddress);
                if (firstTxs.length > 0) {
                    console.log('✅ Token a des transactions, probablement ERC20');
                    
                    // Essayer de deviner le nom depuis l'adresse ou autre
                    const shortAddr = contractAddress.slice(2, 8).toUpperCase();
                    
                    return {
                        name: `Token_${shortAddr}`,
                        symbol: shortAddr,
                        decimals: 18
                    };
                }
            } catch (txError) {
                console.log('⚠️ Analyse transactions échouée:', txError.message);
            }

            // Vraiment dernier recours
            console.log('⚠️ Utilisation valeurs par défaut');
            const shortAddr = contractAddress.slice(2, 8).toUpperCase();
            return {
                name: `Unknown_${shortAddr}`,
                symbol: shortAddr,
                decimals: 18
            };
            
        } catch (error) {
            console.error('❌ Erreur complète token info:', error);
            const shortAddr = contractAddress.slice(2, 8).toUpperCase();
            return {
                name: `Error_${shortAddr}`,
                symbol: shortAddr,
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
        
        // Diviser en plusieurs messages si trop long
        const maxBuyersPerMessage = 10;
        const messages = [];
        
        // Message d'en-tête
        let headerMessage = `🪙 **${tokenInfo.name} (${tokenInfo.symbol})**\n\n`;
        headerMessage += `📊 **Top ${buyers.length} premiers acheteurs**\n`;
        headerMessage += `📝 [Contrat](https://etherscan.io/token/${contractAddress})\n\n`;
        
        // Diviser les acheteurs en chunks
        for (let i = 0; i < buyers.length; i += maxBuyersPerMessage) {
            const chunk = buyers.slice(i, i + maxBuyersPerMessage);
            let message = '';
            
            // Ajouter l'en-tête seulement au premier message
            if (i === 0) {
                message = headerMessage;
            } else {
                message = `**Acheteurs ${i + 1}-${Math.min(i + maxBuyersPerMessage, buyers.length)} :**\n\n`;
            }
            
            chunk.forEach((buyer) => {
                const fullAddress = buyer.wallet;
                const shortAddress = `${fullAddress.slice(0, 6)}...${fullAddress.slice(-4)}`;
                
                message += `**${buyer.rank}.** [${shortAddress}](https://etherscan.io/address/${fullAddress})\n`;
                message += `   💰 ${buyer.amount.toLocaleString('fr-FR', {maximumFractionDigits: 0})} ${tokenInfo.symbol}\n`;
                
                if (buyer.gasPrice !== 'N/A') {
                    message += `   ⛽ ${buyer.gasPrice} Gwei`;
                    if (parseFloat(buyer.priorityFee) > 0) {
                        message += ` (tip: +${buyer.priorityFee})`;
                    }
                } else {
                    message += `   ⛽ Gas: N/A`;
                }
                
                message += `\n   🕒 ${buyer.timestamp.toLocaleString('fr-FR')}\n`;
                message += `   🔗 [TX](https://etherscan.io/tx/${buyer.txHash})\n\n`;
            });
            
            // Ajouter note seulement au dernier message
            if (i + maxBuyersPerMessage >= buyers.length) {
                message += `💡 *Note: Priority fee ≠ MEV bribe. Vrais bribes via Flashbots/coinbase transfers.*`;
            }
            
            messages.push(message);
        }
        
        return messages;
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
