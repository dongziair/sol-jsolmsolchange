import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { DateTime } from 'luxon';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

// --- 代币池 (多协议并发基础) ---
const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // 主要目标: DFlow
    mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // Marinade
    bSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // BlazeStake
};

// 实际生产环境请使用正确的 Mint 地址
const PROTOCOL_MINTS = [
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL (DFlow)
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL (Marinade)
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'   // bSOL (BlazeStake)
];

const TIME_ZONE = 'Asia/Shanghai';

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
            validateStatus: () => true
        });
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            statusText: res.statusText,
            url: urlStr,
            headers: {
                get: (name: string) => res.headers[name.toLowerCase()]
            },
            text: async () => res.data,
            json: async () => {
                if (typeof res.data === 'string') { return JSON.parse(res.data); }
                return res.data;
            },
            clone: function () { return this; }
        } as any;
    };
};

interface WalletContext {
    keypair: Keypair;
    agent?: SocksProxyAgent;
    connection: Connection;
    label: string;
}

class MultiProtocolBot {
    private wallets: WalletContext[] = [];

    constructor() {
        this.initWallets();
    }

    private initWallets() {
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('WALLET_')) {
                const raw = process.env[key]!;
                const [pk, proxyStr] = raw.split('|');

                let agent: SocksProxyAgent | undefined;
                if (proxyStr) {
                    const [ip, port, user, pass] = proxyStr.split(':');
                    agent = new SocksProxyAgent(`socks5://${user}:${pass}@${ip}:${port}`);
                }

                const kp = Keypair.fromSecretKey(bs58.decode(pk));

                // 给每个钱包配属独立的代理 RPC 隧道
                const connection = new Connection(process.env.RPC_URL!, {
                    commitment: 'confirmed',
                    fetch: createAxiosFetch(agent)
                });

                this.wallets.push({ keypair: kp, agent: agent, connection, label: kp.publicKey.toBase58().slice(0, 6) });
            }
        });
    }

    private isWorkTime(): boolean {
        const now = DateTime.now().setZone(TIME_ZONE);
        // 08:00 - 24:00 (UTC+8)
        return now.hour >= 8 && now.hour < 24;
    }

    private async fetchWithRetry<T>(ctx: WalletContext, operation: () => Promise<T>, maxRetries = 3): Promise<T> {
        let lastError: any;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;
                const msg = (error.message || '').toLowerCase();
                // 仅针对网络、超时、代理相关的报错进行重试
                if (msg.includes('socket') || msg.includes('timeout') || msg.includes('proxy') || msg.includes('network') || msg.includes('econnreset') || msg.includes('econnrefused')) {
                    console.log(`[${ctx.label}] ⚠️ 代理波动 (${error.message}), 正在进行第 ${i + 1}/${maxRetries} 次重试...`);
                    await new Promise(r => setTimeout(r, 2000 * (i + 1))); // 退避延迟
                    continue;
                }
                throw error; // 非网络相关的关键错误直接抛出
            }
        }
        throw lastError;
    }

    private async executeSwap(ctx: WalletContext, from: string, to: string, amount: number) {
        try {
            // 随机化滑点 0.3% - 0.8%
            const slippage = Math.floor(Math.random() * 50) + 30;

            // 1. 获取报价 (携带自动重试)
            const quoteRes = await this.fetchWithRetry(ctx, () => axios.get(`${process.env.JUP_API}/quote`, {
                params: {
                    inputMint: from,
                    outputMint: to,
                    amount: Math.floor(amount * LAMPORTS_PER_SOL),
                    slippageBps: slippage,
                    // 允许所有协议，增加 Meteora/Orca 等并发交互
                },
                httpsAgent: ctx.agent,
                timeout: 15000 // 限制每次拉取超时为15秒
            }));

            // 2. 获取交易体 (携带自动重试)
            const swapRes = await this.fetchWithRetry(ctx, () => axios.post(`${process.env.JUP_API}/swap`, {
                quoteResponse: quoteRes.data,
                userPublicKey: ctx.keypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto' // 自动竞争 Gas
            }, {
                httpsAgent: ctx.agent,
                timeout: 15000
            }));

            const swapTransaction = swapRes.data.swapTransaction;
            const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            transaction.sign([ctx.keypair]);

            // RPC 请求现在通过 ctx.connection，强制走了钱包专属 Socks5 代理
            const txid = await ctx.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: 3
            });

            console.log(`[${ctx.label}] ✅ 协议交互成功: https://solscan.io/tx/${txid}`);
            return true;
        } catch (e: any) {
            const apiError = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            console.error(`[${ctx.label}] ❌ 交互最终失败: ${apiError}`);
            return false;
        }
    }

    async start() {
        console.log("多协议并发脚本启动 | 监控时段: 08:00-24:00 UTC+8");

        while (true) {
            if (!this.isWorkTime()) {
                console.log("[休息] 非交易窗口，等待 10 分钟...");
                await new Promise(r => setTimeout(r, 600000));
                continue;
            }

            // 1. 钱包乱序
            const shuffled = [...this.wallets].sort(() => Math.random() - 0.5);

            for (const wallet of shuffled) {
                // 2. 随机选择本次要交互的 LST 协议 (JitoSOL 或 mSOL)
                const targetMint = PROTOCOL_MINTS[Math.floor(Math.random() * PROTOCOL_MINTS.length)];

                // 3. 随机金额 (0.0001 - 0.001 SOL)
                const amount = Number((Math.random() * (0.001 - 0.0001) + 0.0001).toFixed(6));

                console.log(`[${wallet.label}] 行为: SOL -> ${targetMint === PROTOCOL_MINTS[0] ? 'JitoSOL(DFlow)' : 'mSOL(Marinade)'} | 金额: ${amount}`);

                // 第一阶段：买入
                const ok = await this.executeSwap(wallet, MINTS.SOL, targetMint, amount);

                if (ok) {
                    // 4. 模拟真人思考时间 (2-6 分钟)
                    const wait = Math.floor(Math.random() * 240) + 120;
                    console.log(`[${wallet.label}] 等待 ${wait}s 后执行对冲卖出...`);
                    await new Promise(r => setTimeout(r, wait * 1000));

                    // 第二阶段：卖回 (对冲，保持 SOL 余额稳定)
                    await this.executeSwap(wallet, targetMint, MINTS.SOL, amount * 0.995);
                }

                // 钱包间的短间隔
                await new Promise(r => setTimeout(r, (Math.random() * 40 + 20) * 1000));
            }

            // 5. 动态计算大循环间隔，维持每日 150-200 次
            const loopWait = Math.floor(Math.random() * 180) + 300; // 5-8 分钟
            console.log(`[系统] 本轮轮询结束。休眠 ${loopWait} 秒...`);
            await new Promise(r => setTimeout(r, loopWait * 1000));
        }
    }
}

new MultiProtocolBot().start().catch(console.error);