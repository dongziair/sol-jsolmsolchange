import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { DateTime } from 'luxon';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';
import * as crypto from 'crypto';

dotenv.config();

const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
};

const PROTOCOL_MINTS = [
    { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', name: 'JitoSOL' },
    { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', name: 'mSOL' },
    { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', name: 'bSOL' },
];

const TIME_ZONE = 'Asia/Shanghai';
const DFLOW_API = process.env.DFLOW_API || 'https://quote-api.dflow.net';
const JUP_API = process.env.JUP_API || 'https://api.jup.ag';
const JUP_API_KEY = process.env.JUP_API_KEY || '';
const RAYDIUM_API = process.env.RAYDIUM_API || 'https://transaction-v1.raydium.io';

// --- OKX DEX 签名工具 ---
function okxSign(timestamp: string, method: string, path: string, body: string): string {
    const secret = process.env.OKX_SECRET_KEY || '';
    const prehash = timestamp + method + path + body;
    return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

function okxHeaders(method: string, path: string, body = ''): Record<string, string> {
    const ts = new Date().toISOString();
    return {
        'OK-ACCESS-KEY': process.env.OKX_API_KEY || '',
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE || '',
        'OK-ACCESS-SIGN': okxSign(ts, method, path, body),
        'Content-Type': 'application/json',
    };
}

// --- Provider 接口 ---
interface SwapResult {
    transaction: VersionedTransaction;
    provider: string;
}

interface SwapProvider {
    name: string;
    available: boolean;
    getSwap(from: string, to: string, amountLamports: number, signer: string, agent?: SocksProxyAgent): Promise<SwapResult>;
}

// --- DFlow Provider (优先级 1, 零手续费) ---
class DFlowProvider implements SwapProvider {
    name = 'DFlow';
    available = true;

    async getSwap(from: string, to: string, amountLamports: number, signer: string, agent?: SocksProxyAgent): Promise<SwapResult> {
        const res = await axios.get(`${DFLOW_API}/order`, {
            params: {
                inputMint: from,
                outputMint: to,
                amount: amountLamports,
                signer,
            },
            httpsAgent: agent,
            timeout: 15000,
        });

        if (!res.data?.transaction) {
            throw new Error('DFlow 未返回 transaction');
        }

        const tx = VersionedTransaction.deserialize(Buffer.from(res.data.transaction, 'base64'));
        return { transaction: tx, provider: this.name };
    }
}

// --- Raydium Provider (优先级 2, 零手续费) ---
class RaydiumProvider implements SwapProvider {
    name = 'Raydium';
    available = true;

    async getSwap(from: string, to: string, amountLamports: number, signer: string, agent?: SocksProxyAgent): Promise<SwapResult> {
        const slippage = Math.floor(Math.random() * 50) + 30;

        const quoteRes = await axios.get(`${RAYDIUM_API}/compute/swap-base-in`, {
            params: { inputMint: from, outputMint: to, amount: amountLamports, slippageBps: slippage, txVersion: 'V0' },
            httpsAgent: agent,
            timeout: 15000,
        });

        if (!quoteRes.data?.success) throw new Error('Raydium 报价失败: ' + JSON.stringify(quoteRes.data));

        const swapRes = await axios.post(`${RAYDIUM_API}/transaction/swap-base-in`, {
            computeUnitPriceMicroLamports: '50000',
            swapResponse: quoteRes.data,
            txVersion: 'V0',
            wallet: signer,
            wrapSol: true,
            unwrapSol: true,
        }, {
            httpsAgent: agent,
            timeout: 15000,
        });

        if (!swapRes.data?.success) throw new Error('Raydium 构建交易失败: ' + JSON.stringify(swapRes.data));

        const txBase64 = swapRes.data?.data?.[0]?.transaction;
        if (!txBase64) throw new Error('Raydium 未返回 transaction: ' + JSON.stringify(swapRes.data));

        const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
        return { transaction: tx, provider: this.name };
    }
}

// --- Jupiter Provider (优先级 3, 零手续费 via lite-api) ---
class JupiterProvider implements SwapProvider {
    name = 'Jupiter';
    available = true;

    async getSwap(from: string, to: string, amountLamports: number, signer: string, agent?: SocksProxyAgent): Promise<SwapResult> {
        const slippage = Math.floor(Math.random() * 50) + 30;
        const headers: Record<string, string> = {};
        if (JUP_API_KEY) headers['x-api-key'] = JUP_API_KEY;

        const quoteRes = await axios.get(`${JUP_API}/quote`, {
            params: { inputMint: from, outputMint: to, amount: amountLamports, slippageBps: slippage },
            headers,
            httpsAgent: agent,
            timeout: 15000,
        });

        const swapRes = await axios.post(`${JUP_API}/swap`, {
            quoteResponse: quoteRes.data,
            userPublicKey: signer,
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto',
        }, {
            headers,
            httpsAgent: agent,
            timeout: 15000,
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        return { transaction: tx, provider: this.name };
    }
}

// --- OKX DEX Provider (优先级 4, 0.25-0.85% 手续费, 需 API Key) ---
class OKXDexProvider implements SwapProvider {
    name = 'OKX DEX';
    available: boolean;

    constructor() {
        this.available = !!(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
    }

    async getSwap(from: string, to: string, amountLamports: number, signer: string, agent?: SocksProxyAgent): Promise<SwapResult> {
        if (!this.available) throw new Error('OKX DEX 未配置 API Key');

        const path = '/api/v5/dex/aggregator/swap';
        const params = new URLSearchParams({
            chainId: '501',
            fromTokenAddress: from,
            toTokenAddress: to,
            amount: amountLamports.toString(),
            slippage: '0.005',
            userWalletAddress: signer,
        });
        const fullPath = `${path}?${params.toString()}`;

        const res = await axios.get(`https://www.okx.com${fullPath}`, {
            headers: okxHeaders('GET', fullPath),
            httpsAgent: agent,
            timeout: 15000,
        });

        const txData = res.data?.data?.[0]?.tx?.data;
        if (!txData) throw new Error('OKX DEX 未返回 tx data');

        const tx = VersionedTransaction.deserialize(Buffer.from(txData, 'base64'));
        return { transaction: tx, provider: this.name };
    }
}

// --- 钱包上下文 ---
interface WalletContext {
    keypair: Keypair;
    agent?: SocksProxyAgent;
    connection: Connection;
    label: string;
}

const createAxiosFetch = (agent?: SocksProxyAgent) => {
    return async (url: any, options?: any) => {
        const urlStr = typeof url === 'string' ? url : url.url;
        const res = await axios({
            url: urlStr,
            method: options?.method || 'GET',
            data: options?.body,
            headers: options?.headers,
            httpsAgent: agent,
            httpAgent: agent,
            responseType: 'text',
            validateStatus: () => true,
        });
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            statusText: res.statusText,
            url: urlStr,
            headers: { get: (name: string) => res.headers[name.toLowerCase()] },
            text: async () => res.data,
            json: async () => typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
            clone: function () { return this; },
        } as any;
    };
};

class MultiProtocolBot {
    private wallets: WalletContext[] = [];
    private providers: SwapProvider[];
    private dailyTxCount = 0;
    private lastResetDate = '';

    constructor() {
        this.initWallets();
        this.providers = [
            new DFlowProvider(),
            new RaydiumProvider(),
            new JupiterProvider(),
            new OKXDexProvider(),
        ];
        const active = this.providers.filter(p => p.available).map(p => p.name);
        console.log(`可用渠道: ${active.join(' → ')}`);
    }

    private initWallets() {
        Object.keys(process.env).forEach(key => {
            if (!key.startsWith('WALLET_')) return;
            const raw = process.env[key]!;
            const [pk, proxyStr] = raw.split('|');

            let agent: SocksProxyAgent | undefined;
            if (proxyStr) {
                const [ip, port, user, pass] = proxyStr.split(':');
                agent = new SocksProxyAgent(`socks5://${user}:${pass}@${ip}:${port}`);
            }

            const kp = Keypair.fromSecretKey(bs58.decode(pk));
            const connection = new Connection(process.env.RPC_URL!, {
                commitment: 'confirmed',
                fetch: createAxiosFetch(agent),
            });

            this.wallets.push({ keypair: kp, agent, connection, label: kp.publicKey.toBase58().slice(0, 6) });
        });
    }

    private isWorkTime(): boolean {
        const now = DateTime.now().setZone(TIME_ZONE);
        return now.hour >= 8 && now.hour < 24;
    }

    private resetDailyCounter() {
        const today = DateTime.now().setZone(TIME_ZONE).toISODate()!;
        if (today !== this.lastResetDate) {
            console.log(`[系统] 日期切换 → ${today}，计数器归零 (昨日: ${this.dailyTxCount} tx)`);
            this.dailyTxCount = 0;
            this.lastResetDate = today;
        }
    }

    private async executeSwap(ctx: WalletContext, from: string, to: string, amount: number): Promise<boolean> {
        const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
        const signer = ctx.keypair.publicKey.toString();

        for (const provider of this.providers) {
            if (!provider.available) continue;

            try {
                console.log(`[${ctx.label}] 尝试 ${provider.name}...`);
                const { transaction, provider: usedProvider } = await provider.getSwap(from, to, amountLamports, signer, ctx.agent);
                transaction.sign([ctx.keypair]);

                const txid = await ctx.connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: true,
                    maxRetries: 3,
                });

                this.dailyTxCount++;
                console.log(`[${ctx.label}] ✅ ${usedProvider} 成功 (今日第 ${this.dailyTxCount} tx): https://solscan.io/tx/${txid}`);
                return true;
            } catch (e: any) {
                const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.log(`[${ctx.label}] ⚠️ ${provider.name} 失败: ${msg}`);
            }
        }

        console.error(`[${ctx.label}] ❌ 所有渠道均失败`);
        return false;
    }

    async start() {
        console.log('多协议并发脚本启动 | DFlow → Raydium → Jupiter → OKX DEX');
        console.log(`钱包数: ${this.wallets.length} | 目标: ~100 tx/天 | 窗口: 08:00-24:00 UTC+8`);

        while (true) {
            this.resetDailyCounter();

            if (!this.isWorkTime()) {
                console.log('[休息] 非交易窗口，等待 10 分钟...');
                await new Promise(r => setTimeout(r, 600000));
                continue;
            }

            if (this.dailyTxCount >= 120) {
                console.log(`[系统] 今日已达 ${this.dailyTxCount} tx，暂停至次日`);
                await new Promise(r => setTimeout(r, 600000));
                continue;
            }

            const shuffled = [...this.wallets].sort(() => Math.random() - 0.5);

            for (const wallet of shuffled) {
                const target = PROTOCOL_MINTS[Math.floor(Math.random() * PROTOCOL_MINTS.length)];
                const amount = Number((Math.random() * (0.001 - 0.0001) + 0.0001).toFixed(6));

                console.log(`[${wallet.label}] SOL → ${target.name} | 金额: ${amount}`);

                const ok = await this.executeSwap(wallet, MINTS.SOL, target.mint, amount);

                if (ok) {
                    const wait = Math.floor(Math.random() * 240) + 120;
                    console.log(`[${wallet.label}] 等待 ${wait}s 后卖回...`);
                    await new Promise(r => setTimeout(r, wait * 1000));

                    await this.executeSwap(wallet, target.mint, MINTS.SOL, amount * 0.995);
                }

                await new Promise(r => setTimeout(r, (Math.random() * 40 + 20) * 1000));
            }

            // 8-10 分钟间隔，16h 工作窗口 ≈ 96-120 轮
            const loopWait = Math.floor(Math.random() * 120) + 480;
            console.log(`[系统] 本轮结束 (今日 ${this.dailyTxCount} tx)。休眠 ${loopWait}s...`);
            await new Promise(r => setTimeout(r, loopWait * 1000));
        }
    }
}

new MultiProtocolBot().start().catch(console.error);