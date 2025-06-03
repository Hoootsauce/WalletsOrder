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
    }const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

// Vérification
if (!TELEGRAM_BOT_TOKEN || !ETHEREUM_RPC_URL || !ETHERSCAN_API_KEY) {
    console.error('❌ Variables manquantes!');
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
        <h1>🤖 Bot Token Analyzer</h1>
        <p>✅ Bot actif</p>
        <p>⏰ ${new Date().toLocaleString('fr-FR')}</p>
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
            console.log(`🔍 Token info pour: ${contractAddress}`);
            
            // Méthode simple : lecture directe
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
            
            // Convertir la supply en nombre lisible
            let readableSupply = 0;
            if (tokenTotalSupply > 0n) {
                readableSupply = parseFloat(ethers.formatUnits(tokenTotalSupply, tokenDecimals));
            }
            
            console.log(`✅ Token: ${tokenName} (${tokenSymbol}) - ${tokenDecimals} decimals`);
            console.log(`📊 Supply: ${readableSupply.toLocaleString('fr-FR')} ${tokenSymbol}`);
            
            return { 
                name: tokenName, 
                symbol: tokenSymbol, 
                decimals: tokenDecimals,
                totalSupply: readableSupply
            };
        } catch (error) {
            console.error('❌ Erreur token info:', error.message);
            return {
                name: 'Unknown Token',
                symbol: 'TOKEN',
                decimals: 18,
                totalSupply: 0
            };
        }
    }

    async getTokenTransactions(contractAddress) {
        try {
            console.log(`📡 Récupération transactions...`);
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
                throw new Error('Pas de transactions trouvées');
            }
            
            console.log(`✅ ${response.data.result.length} transactions trouvées`);
            return response.data.result || [];
        } catch (error) {
            console.error('❌ Erreur transactions:', error.message);
            throw error;
        }
    }

    async analyzeFirstBuyers(contractAddress, limit = 50) {
        console.log(`🚀 Début analyse ${contractAddress}`);
        
        const tokenInfo = await this.getTokenInfo(contractAddress);
        const transactions = await this.getTokenTransactions(contractAddress);
        
        if (transactions.length === 0) {
            throw new Error('Aucune transaction trouvée');
        }

        const buyers = new Map();
        const results = [];

        // Ignorer seulement les adresses vraiment évidentes
        const skipAddresses = new Set([
            '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2
            '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3
            contractAddress.toLowerCase() // Le contrat lui-même
        ]);

        for (const tx of transactions) {
            // Skip les mints
            if (tx.from === '0x0000000000000000000000000000000000000000') continue;
            
            const buyerAddress = tx.to.toLowerCase();
            
            // Skip seulement les vrais routers
            if (skipAddresses.has(buyerAddress)) {
                console.log(`⚠️ Skip router: ${buyerAddress}`);
                continue;
            }
            
            if (!buyers.has(buyerAddress)) {
                buyers.set(buyerAddress, true);
                
                // Calcul simple du montant
                let amount = 0;
                let supplyPercent = 0;
                try {
                    amount = parseFloat(ethers.formatUnits(tx.value, tokenInfo.decimals));
                    
                    // Calculer le % de supply si on a la supply totale
                    if (tokenInfo.totalSupply > 0 && amount > 0) {
                        supplyPercent = (amount / tokenInfo.totalSupply) * 100;
                    }
                } catch (error) {
                    console.warn(`⚠️ Erreur montant ${tx.hash}:`, error.message);
                    amount = 0;
                    supplyPercent = 0;
                }
                
                // Récupérer les détails gas pour les 15 premiers
                let gasDetails = { gasPrice: 'N/A', priorityFee: '0' };
                if (results.length < 15) {
                    gasDetails = await this.getTransactionDetails(tx.hash);
                }
                
                results.push({
                    rank: results.length + 1,
                    wallet: tx.to,
                    amount: amount,
                    supplyPercent: supplyPercent,
                    txHash: tx.hash,
                    timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                    gasPrice: gasDetails.gasPrice,
                    priorityFee: gasDetails.priorityFee
                });

                console.log(`✅ Acheteur #${results.length}: ${tx.to} = ${amount} ${tokenInfo.symbol}`);

                if (results.length >= limit) break;
            }
        }

        if (results.length === 0) {
            throw new Error('Aucun acheteur trouvé');
        }

        console.log(`🎯 ${results.length} acheteurs trouvés`);
        return { tokenInfo, buyers: results, contractAddress };
    }

    formatResults(data) {
        const { tokenInfo, buyers, contractAddress } = data;
        
        let message = `🪙 **${tokenInfo.name} (${tokenInfo.symbol})**\n\n`;
        message += `📊 **${buyers.length} premiers acheteurs**\n`;
        
        // Afficher la supply totale si disponible
        if (tokenInfo.totalSupply > 0) {
            message += `📈 **Supply totale:** ${tokenInfo.totalSupply.toLocaleString('fr-FR', {maximumFractionDigits: 0})} ${tokenInfo.symbol}\n`;
        }
        
        message += `📝 [Contrat](https://etherscan.io/token/${contractAddress})\n\n`;

        // Limiter à 10 pour éviter les messages trop longs
        const displayBuyers = buyers.slice(0, 10);

        displayBuyers.forEach((buyer) => {
            const shortAddr = `${buyer.wallet.slice(0, 6)}...${buyer.wallet.slice(-4)}`;
            
            message += `**${buyer.rank}.** [${shortAddr}](https://etherscan.io/address/${buyer.wallet})\n`;
            message += `   💰 ${buyer.amount.toLocaleString('fr-FR', {maximumFractionDigits: 0})} ${tokenInfo.symbol}`;
            
            // Ajouter le pourcentage de supply si disponible
            if (buyer.supplyPercent > 0) {
                if (buyer.supplyPercent >= 0.01) {
                    message += ` **(${buyer.supplyPercent.toFixed(2)}% supply)**`;
                } else {
                    message += ` **(${buyer.supplyPercent.toFixed(4)}% supply)**`;
                }
            }
            message += '\n';
            
            // Affichage du gas
            if (buyer.gasPrice && buyer.gasPrice !== 'N/A') {
                message += `   ⛽ ${buyer.gasPrice} Gwei`;
                if (parseFloat(buyer.priorityFee) > 0) {
                    message += ` (tip: +${buyer.priorityFee})`;
                }
                message += '\n';
            }
            
            message += `   🕒 ${buyer.timestamp.toLocaleString('fr-FR')}\n`;
            message += `   🔗 [TX](https://etherscan.io/tx/${buyer.txHash})\n\n`;
        });

        if (buyers.length > 10) {
            message += `\n📋 *Affichage des 10 premiers sur ${buyers.length} total*`;
        }
        
        message += `\n\n💡 *Note: "tip" = priority fee standard. Les vrais bribes MEV sont cachés via Flashbots.*`;

        return message;
    }
}

const analyzer = new SimpleTokenAnalyzer();

// Commandes du bot
bot.onText(/\/start/, (msg) => {
    const welcomeMessage = `
🤖 **Analyseur de Tokens Ethereum**

**Envoyez simplement l'adresse du contrat :**
\`0x1234567890123456789012345678901234567890\`

⏱️ *Analyse en 1-2 minutes*
    `;
    
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
});

// Analyser une adresse
bot.onText(/^(0x[a-fA-F0-9]{40})$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const contractAddress = match[1];
    
    console.log(`📨 Demande d'analyse: ${contractAddress}`);
    
    if (!ethers.isAddress(contractAddress)) {
        bot.sendMessage(chatId, '❌ Adresse invalide');
        return;
    }

    try {
        const loadingMsg = await bot.sendMessage(
            chatId, 
            `🔍 Analyse en cours...\n⏳ Patientez 1-2 minutes`
        );
        
        const results = await analyzer.analyzeFirstBuyers(contractAddress, 50);
        const message = analyzer.formatResults(results);
        
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        
        console.log(`📤 Envoi résultats (${message.length} chars)`);
        
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
        
        console.log(`✅ Analyse terminée pour ${contractAddress}`);
        
    } catch (error) {
        console.error('❌ Erreur analyse:', error.message);
        bot.sendMessage(chatId, `❌ Erreur: ${error.message}`);
    }
});

// Gestion des erreurs
bot.on('error', (error) => {
    console.error('❌ Erreur bot:', error.message);
});

// Démarrage serveur
app.listen(PORT, async () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    
    try {
        const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/bot${TELEGRAM_BOT_TOKEN}`;
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook: ${webhookUrl}`);
    } catch (error) {
        console.error('❌ Erreur webhook:', error.message);
    }
    
    console.log('🤖 Bot Simple prêt!');
});
