'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi';
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector';
import sdk from '@farcaster/miniapp-sdk';
import { useMiniAppContext } from '@/hooks/use-mini-app-context';
import { useUsdcBalanceOf } from '@/neynar-web-sdk/src/blockchain';
import { useOnchainNetworkNewPools, useSimplePrice } from '@/neynar-web-sdk/src/coingecko';
import type { OnchainPool } from '@/neynar-web-sdk/src/coingecko';
import { useCreateTransactionPayFrame } from '@/neynar-web-sdk/src/neynar/api-hooks/hooks/transactions';
import { ShareButton } from '@/neynar-farcaster-sdk/mini';

// USDC contract on Base
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// App's server wallet address — deposits go here
const APP_WALLET = process.env.NEXT_PUBLIC_APP_WALLET_ADDRESS ?? process.env.NEXT_PUBLIC_NEYNAR_WALLET_ADDRESS ?? '';

// ─── Design tokens ─────────────────────────────────────────────────────────────
// Primary palette: dark charcoal bg + dull amber/gold accent
const C = {
  bg:       '#0d0d0a',
  surface:  '#131310',
  surfaceHi:'#1a1a15',
  border:   'rgba(212,180,80,0.12)',
  borderHi: 'rgba(212,180,80,0.25)',
  gold:     '#c8a84b',
  goldSoft: '#d4b450',
  goldDim:  'rgba(200,168,75,0.15)',
  green:    '#4ade80',
  red:      '#f87171',
  muted:    'rgba(255,255,255,0.35)',
  dimmed:   'rgba(255,255,255,0.18)',
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TraderSettings {
  maxAmount: number;    // max $ per auto-copied trade
  stopLoss: number;     // stop copying if trader loses X% in 24h
  slippage: number;     // slippage tolerance %
}

const DEFAULT_TRADER_SETTINGS: TraderSettings = { maxAmount: 100, stopLoss: 20, slippage: 1 };

interface Trader {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
  // Current period PnL (changes with period selector)
  pnl: number;
  pnlFormatted: string;
  pnlPct: string;
  winRate: string;
  trades: number;
  badge: string;
  isFollowing: boolean;
  // All three period PnL values (always shown on card)
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
}

interface LiveTrade {
  id: string;
  trader: string;
  traderPfp: string;
  chain: 'base' | 'solana';
  action: 'BUY' | 'SELL';
  token: string;
  tokenIcon: string;
  amount: string;
  rawAmount: number;
  price: string;
  time: string;
  copied: boolean;
  isNew?: boolean;
  poolAddress?: string;
  dex?: string;
}

type Tab    = 'traders' | 'feed' | 'portfolio' | 'profile';
type Period = '1d' | '7d' | '30d';
type Chain  = 'all' | 'base' | 'solana';

const PERIOD_SCALE:  Record<Period, number>  = { '30d': 1, '7d': 0.35, '1d': 0.08 };

// ─── Pool → LiveTrade ──────────────────────────────────────────────────────────

const DEX_TRADERS: Record<string, { name: string; pfp: string }> = {
  uniswap:   { name: 'uni_whale',   pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=uniwhale'   },
  aerodrome: { name: 'aero_degen',  pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=aerodegen'  },
  raydium:   { name: 'ray_alpha',   pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=rayalpha'   },
  orca:      { name: 'orca_pro',    pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=orcapro'    },
  jupiter:   { name: 'jup_trader',  pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=juptrader'  },
  default:   { name: 'degen_alpha', pfp: 'https://api.dicebear.com/9.x/lorelei/svg?seed=default'    },
};

function poolToTrade(pool: OnchainPool, chain: 'base' | 'solana'): LiveTrade {
  // Use the typed fields directly — pool.tokens.base_token/quote_token are the real structure
  const baseToken  = pool.tokens?.base_token?.symbol  ?? pool.name?.split(' / ')[0] ?? pool.name?.split('/')[0] ?? '???';
  const quoteToken = pool.tokens?.quote_token?.symbol ?? pool.name?.split(' / ')[1] ?? pool.name?.split('/')[1] ?? 'USDC';
  const volume24h  = pool.volume_24h?.usd ?? 0;
  const dexId      = (pool.dex_id ?? 'default').toLowerCase();
  const dexInfo    = DEX_TRADERS[Object.keys(DEX_TRADERS).find(k => dexId.includes(k)) ?? 'default'] ?? DEX_TRADERS.default;
  const tradeSize  = Math.max(50, Math.min(volume24h / 100, 50000));
  const isBuy      = Math.random() > 0.4;
  const sym        = baseToken.toUpperCase();
  const icon       = sym === 'SOL' || sym === 'WSOL' ? '◎'
                   : sym === 'ETH'  || sym === 'WETH' ? '⟠'
                   : sym === 'USDC' || sym === 'USDT' ? '₮'
                   : chain === 'solana' ? '◎' : '●';

  // Use pool.name for display if it looks good, otherwise construct from symbols
  const pairName = (baseToken !== '???' && quoteToken !== 'USDC')
    ? `${baseToken}/${quoteToken}`
    : pool.name ?? `${baseToken}/${quoteToken}`;

  // Age from pool creation or price change as proxy
  const priceChange1h = pool.price_change_percentage?.['1h'];
  const isNew = priceChange1h !== undefined && Math.abs(priceChange1h) > 5;

  return {
    id: pool.id ?? String(Math.random()),
    trader: dexInfo.name, traderPfp: dexInfo.pfp, chain,
    action: isBuy ? 'BUY' : 'SELL',
    token: pairName, tokenIcon: icon,
    amount: `$${Math.round(tradeSize).toLocaleString()}`, rawAmount: tradeSize,
    price: '—', // price not directly available in new-pools endpoint
    time: 'just now', copied: false, isNew,
    poolAddress: pool.address, dex: dexId,
  };
}

// ─── Tiny reusable pieces ──────────────────────────────────────────────────────

function GoldDot({ pulse = false }: { pulse?: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
      {pulse && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#c8a84b] opacity-60" />}
      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#c8a84b]" />
    </span>
  );
}

function Badge({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'buy' | 'sell' | 'default' | 'chain-base' | 'chain-sol' | 'new' }) {
  const styles: Record<string, string> = {
    buy:        'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    sell:       'bg-red-500/10 text-red-400 border border-red-500/20',
    default:    'bg-white/6 text-white/50 border border-white/8',
    'chain-base':'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    'chain-sol': 'bg-purple-500/10 text-purple-400 border border-purple-500/20',
    new:        'bg-[#c8a84b]/10 text-[#c8a84b] border border-[#c8a84b]/20',
  };
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${styles[variant]}`}>{children}</span>;
}

function Pill({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all duration-200 ${
        active
          ? 'bg-[#c8a84b] text-[#0d0d0a]'
          : 'bg-white/5 text-white/40 hover:text-white/60 border border-white/6'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="border-t border-[rgba(212,180,80,0.08)]" />;
}

function AnimatedValue({ value, className }: { value: string; className?: string }) {
  const [key, setKey] = useState(0);
  const prev = useRef(value);
  useEffect(() => { if (prev.current !== value) { setKey(k => k + 1); prev.current = value; } }, [value]);
  return <span key={key} className={`ct-number-pop inline-block ${className ?? ''}`}>{value}</span>;
}

function TraderSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div className="bg-[#131310] rounded-2xl p-4 border border-[rgba(212,180,80,0.08)] ct-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start gap-3">
        <div className="w-3 h-2.5 rounded ct-shimmer mt-1" />
        <div className="w-10 h-10 rounded-full ct-shimmer flex-shrink-0" />
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex justify-between">
            <div className="flex flex-col gap-1.5">
              <div className="w-28 h-3 rounded ct-shimmer" />
              <div className="w-20 h-2.5 rounded ct-shimmer" />
            </div>
            <div className="w-16 h-8 rounded-xl ct-shimmer" />
          </div>
          <div className="grid grid-cols-4 gap-2 mt-1">
            {[0,1,2,3].map(i => <div key={i} className="h-9 rounded-xl ct-shimmer" />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Collapsible ───────────────────────────────────────────────────────────────

function Collapsible({ title, subtitle, defaultOpen = false, accent = false, children }: {
  title: string; subtitle?: string; defaultOpen?: boolean; accent?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-2xl border overflow-hidden transition-colors duration-200 ${accent ? 'bg-[#1a1a15] border-[rgba(212,180,80,0.2)]' : 'bg-[#131310] border-[rgba(212,180,80,0.1)]'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3.5 text-left gap-3">
        <div className="min-w-0">
          <p className={`text-sm font-semibold truncate ${accent ? 'text-[#c8a84b]' : 'text-white'}`}>{title}</p>
          {subtitle && <p className="text-xs text-white/30 mt-0.5 truncate">{subtitle}</p>}
        </div>
        <svg
          className={`w-4 h-4 text-white/30 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-[rgba(212,180,80,0.08)] ct-fade-up" style={{ animationDuration: '0.18s' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Deposit Modal ─────────────────────────────────────────────────────────────

function DepositModal({ onClose, onDeposit }: { onClose: () => void; onDeposit: (n: number) => void }) {
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'select' | 'pending' | 'success' | 'error'>('select');
  const [errorMsg, setErrorMsg] = useState('');
  const val = parseFloat(amount) || 0;

  const createPayFrame = useCreateTransactionPayFrame({
    onSuccess: (data) => {
      // Open the Neynar pay frame URL in the Farcaster client
      const frameUrl = data?.transaction_frame?.url;
      if (frameUrl) {
        sdk.actions.openUrl(frameUrl);
        setStep('success');
        // Credit the balance optimistically after a short delay
        setTimeout(() => { onDeposit(val); onClose(); }, 2000);
      } else {
        setStep('error');
        setErrorMsg('No payment URL returned. Please try again.');
      }
    },
    onError: (err: unknown) => {
      setStep('error');
      const msg = err instanceof Error ? err.message : 'Payment setup failed';
      setErrorMsg(msg);
    },
  });

  const handleDeposit = () => {
    if (!APP_WALLET) {
      setStep('error');
      setErrorMsg('App wallet not configured.');
      return;
    }
    setStep('pending');
    createPayFrame.mutate({
      transaction: {
        to: {
          address: APP_WALLET,
          network: 'base',
          token_contract_address: USDC_BASE,
          amount: val,
        },
      },
      config: {
        line_items: [{ name: 'CopyTrade Deposit', description: `Add $${val} USDC to your CopyTrade balance` }],
        action: { text: `Deposit $${val}`, button_color: '#c8a84b', text_color: '#0d0d0a' },
      },
      idem: `deposit-${Date.now()}`,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full bg-[#131310] rounded-t-3xl border-t border-[rgba(212,180,80,0.2)] p-5 ct-fade-up" style={{ maxHeight: '88vh', overflowY: 'auto' }}>

        {step === 'select' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-white">Add Funds</h2>
              <button onClick={onClose} className="w-7 h-7 rounded-full bg-white/6 flex items-center justify-center text-white/50 text-sm">✕</button>
            </div>
            {/* USDC only — Base network */}
            <div className="flex items-center gap-2 bg-[rgba(200,168,75,0.06)] rounded-xl px-4 py-3 mb-4 border border-[rgba(200,168,75,0.15)]">
              <span className="text-lg">₮</span>
              <div>
                <p className="text-sm font-bold text-white">USDC on Base</p>
                <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>Fast, low fees · Real on-chain transfer</p>
              </div>
              <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(200,168,75,0.15)', color: '#c8a84b' }}>Selected</span>
            </div>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[50, 100, 250, 500].map(p => (
                <button key={p} onClick={() => setAmount(String(p))} className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${amount === String(p) ? 'bg-[#c8a84b] text-[#0d0d0a]' : 'bg-white/6 text-white/40 border border-white/8'}`}>${p}</button>
              ))}
            </div>
            <div className="flex items-center gap-2 bg-white/4 rounded-xl px-4 py-3 border border-[rgba(212,180,80,0.2)] mb-4">
              <span className="text-white/30 text-sm">$</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="bg-transparent text-white text-lg font-bold outline-none flex-1" />
              <span className="text-xs text-white/30 uppercase font-mono">USDC</span>
            </div>
            <div className="bg-white/3 rounded-xl p-3 mb-5 text-xs text-white/30 space-y-1.5">
              <div className="flex justify-between"><span>Network</span><span className="text-[#c8a84b]">Base</span></div>
              <div className="flex justify-between"><span>Min. deposit</span><span className="text-white/50">$10</span></div>
              <div className="flex justify-between"><span>Settlement</span><span className="text-white/50">~30s on-chain</span></div>
            </div>
            <button
              onClick={handleDeposit}
              disabled={val < 10}
              className="w-full py-3.5 rounded-2xl bg-[#c8a84b] text-[#0d0d0a] font-bold text-sm disabled:opacity-30 transition-all active:scale-[0.98]"
            >
              Deposit ${val > 0 ? val.toLocaleString() : '—'} USDC
            </button>
          </>
        )}

        {step === 'pending' && (
          <div className="flex flex-col items-center justify-center py-14 ct-fade-up gap-4">
            <div className="w-14 h-14 rounded-full border-2 border-[#c8a84b] border-t-transparent animate-spin" />
            <p className="text-base font-bold text-white">Opening payment…</p>
            <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,0.4)' }}>Complete the transfer in the Farcaster window that opens</p>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center justify-center py-12 ct-bounce-in gap-3">
            <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center text-3xl">✓</div>
            <p className="text-lg font-bold text-white">Payment Opened</p>
            <p className="text-sm text-center" style={{ color: 'rgba(255,255,255,0.4)' }}>Confirm the USDC transfer in your wallet. Your balance will update on-chain.</p>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center justify-center py-12 ct-bounce-in gap-3">
            <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center text-3xl">⚠</div>
            <p className="text-base font-bold text-white">Something went wrong</p>
            <p className="text-xs text-center text-red-400">{errorMsg}</p>
            <button onClick={() => setStep('select')} className="mt-2 px-5 py-2 rounded-xl text-sm font-bold" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>← Try Again</button>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── Copy Trade Modal ──────────────────────────────────────────────────────────

function CopyTradeModal({ trade, walletBalance, defaultAmount, onClose, onConfirm }: {
  trade: LiveTrade; walletBalance: number; defaultAmount: number;
  onClose: () => void; onConfirm: (n: number) => void;
}) {
  const [amount, setAmount] = useState(String(defaultAmount));
  const [confirmed, setConfirmed] = useState(false);
  const val        = parseFloat(amount) || 0;
  const insufficient = val > walletBalance;

  const handleConfirm = () => {
    if (val > 0 && !insufficient) { setConfirmed(true); setTimeout(() => { onConfirm(val); onClose(); }, 1500); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full bg-[#131310] rounded-t-3xl border-t border-[rgba(212,180,80,0.2)] p-5 ct-fade-up">
        {confirmed ? (
          <div className="flex flex-col items-center justify-center py-10 ct-bounce-in">
            <div className="w-14 h-14 rounded-full bg-[#c8a84b]/15 border border-[#c8a84b]/25 flex items-center justify-center text-2xl mb-3">⚡</div>
            <p className="text-base font-bold text-white">Trade Opened!</p>
            <p className="text-sm text-white/40 mt-1">{trade.action} {trade.token} · <span className="text-[#c8a84b]">${val.toLocaleString()}</span></p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-white">Copy Trade</h2>
              <button onClick={onClose} className="w-7 h-7 rounded-full bg-white/6 flex items-center justify-center text-white/50 text-sm">✕</button>
            </div>
            <div className="flex items-center gap-3 bg-white/4 rounded-2xl p-3 mb-4 border border-[rgba(212,180,80,0.1)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={trade.traderPfp} alt={trade.trader} className="w-9 h-9 rounded-full" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                  <Badge variant={trade.action === 'BUY' ? 'buy' : 'sell'}>{trade.action}</Badge>
                  <span className="text-sm font-bold text-white">{trade.tokenIcon} {trade.token}</span>
                  <Badge variant={trade.chain === 'base' ? 'chain-base' : 'chain-sol'}>{trade.chain === 'base' ? '● Base' : '◎ Sol'}</Badge>
                </div>
                <p className="text-xs text-white/30">via {trade.dex ?? 'DEX'} · {trade.price}</p>
              </div>
            </div>
            <div className={`flex items-center gap-2 rounded-xl px-4 py-3 border mb-1 ${insufficient ? 'border-red-500/30 bg-red-500/5' : 'border-[rgba(212,180,80,0.25)] bg-white/4'}`}>
              <span className="text-white/30">$</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="bg-transparent text-white text-xl font-bold outline-none flex-1" placeholder="100" autoFocus />
              <span className="text-xs text-white/30 font-mono">USDC</span>
            </div>
            {insufficient && <p className="text-xs text-red-400 mb-2 ct-fade-in">Insufficient — add funds in Profile</p>}
            <div className="flex gap-2 my-3">
              {[25, 50, 100, 250].map(p => (
                <button key={p} onClick={() => setAmount(String(p))} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${amount === String(p) ? 'bg-[#c8a84b] text-[#0d0d0a]' : 'bg-white/5 text-white/40 border border-white/8'}`}>${p}</button>
              ))}
            </div>
            <div className="flex justify-between text-xs text-white/25 mb-5">
              <span>Balance: <span className="text-[#c8a84b]">${walletBalance.toLocaleString()}</span></span>
              <button onClick={() => setAmount(String(walletBalance))} className="text-[#c8a84b]">Max</button>
            </div>
            <button
              onClick={handleConfirm}
              disabled={val <= 0 || insufficient}
              className="w-full py-3.5 rounded-2xl bg-[#c8a84b] text-[#0d0d0a] font-bold text-sm disabled:opacity-30 transition-all active:scale-[0.98]"
            >
              {trade.action === 'BUY' ? '⚡ Open Buy' : '⚡ Open Sell'} · ${val > 0 ? val.toLocaleString() : '—'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Stat tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, gold = false }: { label: string; value: string; sub?: string; gold?: boolean }) {
  return (
    <div className={`rounded-xl p-3 border ${gold ? 'bg-[rgba(212,180,80,0.08)] border-[rgba(212,180,80,0.2)]' : 'bg-white/3 border-white/6'}`}>
      <p className="text-[10px] text-white/35 leading-none mb-1.5">{label}</p>
      <p className={`text-sm font-bold leading-none ${gold ? 'text-[#c8a84b]' : 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-white/25 mt-1">{sub}</p>}
    </div>
  );
}

// ─── Main app ──────────────────────────────────────────────────────────────────

export function MiniApp() {
  const { context } = useMiniAppContext();
  const user = context?.user;

  // ── Wallet ────────────────────────────────────────────────────────────────────
  const { address: evmAddress, isConnected } = useAccount();
  const { connect }    = useConnect();
  const { disconnect } = useDisconnect();
  const { data: ethBalance }  = useBalance({ address: evmAddress, query: { enabled: !!evmAddress } });
  const { data: usdcRaw }     = useUsdcBalanceOf(evmAddress ?? '0x0', { enabled: !!evmAddress });

  const connectWallet = () => {
    try { connect({ connector: farcasterMiniApp() }); } catch { /* ignore */ }
  };

  // Solana address
  const userVerified = (user as Record<string, unknown>)?.verified_addresses as Record<string, unknown> | undefined;
  const primary = userVerified?.primary as Record<string, unknown> | undefined;
  const solAddresses = userVerified?.sol_addresses as string[] | undefined;
  const solAddress = (primary?.sol_address as string | undefined) ?? solAddresses?.[0] ?? null;

  // ── Prices ────────────────────────────────────────────────────────────────────
  const { data: prices } = useSimplePrice(['ethereum', 'solana', 'usd-coin'], ['usd'], { include24hrChange: true });
  const ethPrice  = prices?.ethereum?.usd ?? 0;
  const solPrice  = prices?.solana?.usd   ?? 0;
  const ethChange = prices?.ethereum?.usd_24h_change ?? 0;
  const solChange = prices?.solana?.usd_24h_change   ?? 0;

  // ── Derived balances ──────────────────────────────────────────────────────────
  const usdcBalance   = usdcRaw ? Number(usdcRaw) / 1e6 : 0;
  const ethBalanceNum = ethBalance ? parseFloat(ethBalance.formatted) : 0;
  const ethValueUsd   = ethBalanceNum * ethPrice;
  const solValueUsd   = 0; // read-only display; no wagmi for Solana

  // ── Tabs ──────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('traders');
  const [tabKey, setTabKey]       = useState(0);
  const switchTab = (tab: Tab) => { setActiveTab(tab); setTabKey(k => k + 1); };

  // ── Traders ───────────────────────────────────────────────────────────────────
  const [traders, setTraders]               = useState<Trader[]>([]);
  const [tradersLoading, setTradersLoading] = useState(true);
  const [tradersError, setTradersError]     = useState(false);
  const [period, setPeriod]                 = useState<Period>('30d');
  const [searchQuery, setSearchQuery]       = useState('');
  const [minPnl, setMinPnl]                 = useState(2000);
  const [minPnlInput, setMinPnlInput]       = useState('2000');
  const [filterKey, setFilterKey]           = useState(0);

  // ── Live feed ─────────────────────────────────────────────────────────────────
  const [chainFilter, setChainFilter] = useState<Chain>('all');
  const [feedTrades, setFeedTrades]   = useState<LiveTrade[]>([]);
  const seenIds = useRef(new Set<string>());

  const { data: basePools   } = useOnchainNetworkNewPools('base',   { per_page: 20 });
  const { data: solanaPools } = useOnchainNetworkNewPools('solana', { per_page: 20 });

  useEffect(() => {
    const incoming: LiveTrade[] = [];
    const basePoolsData = basePools as Record<string, unknown> | undefined;
    const solanaPoolsData = solanaPools as Record<string, unknown> | undefined;
    const rawBase   = (basePoolsData?.data as OnchainPool[]) ?? (Array.isArray(basePools)   ? basePools   : []);
    const rawSolana = (solanaPoolsData?.data as OnchainPool[]) ?? (Array.isArray(solanaPools) ? solanaPools : []);
    for (const pool of rawBase)   { if (!seenIds.current.has(pool.id)) { seenIds.current.add(pool.id); incoming.push(poolToTrade(pool, 'base'));   } }
    for (const pool of rawSolana) { if (!seenIds.current.has(pool.id)) { seenIds.current.add(pool.id); incoming.push(poolToTrade(pool, 'solana')); } }
    if (incoming.length > 0) {
      setFeedTrades(prev => [...incoming, ...prev].slice(0, 40));
      setTimeout(() => { setFeedTrades(prev => prev.map(t => incoming.some(i => i.id === t.id) ? { ...t, isNew: false } : t)); }, 15000);
    }
  }, [basePools, solanaPools]);

  const displayedFeed = chainFilter === 'all' ? feedTrades : feedTrades.filter(t => t.chain === chainFilter);

  // ── Per-trader settings ───────────────────────────────────────────────────────
  const [traderSettings, setTraderSettings] = useState<Record<number, TraderSettings>>({});
  const [expandedSettings, setExpandedSettings] = useState<number | null>(null);

  const getTraderSettings = (fid: number): TraderSettings =>
    traderSettings[fid] ?? DEFAULT_TRADER_SETTINGS;

  const updateTraderSetting = <K extends keyof TraderSettings>(fid: number, key: K, value: TraderSettings[K]) => {
    setTraderSettings(prev => ({
      ...prev,
      [fid]: { ...getTraderSettings(fid), [key]: value },
    }));
  };

  // ── In-app wallet + copy settings ────────────────────────────────────────────
  const [inAppBalance, setInAppBalance]           = useState(0);
  const [showDeposit, setShowDeposit]             = useState(false);
  const [copyModalTrade, setCopyModalTrade]       = useState<LiveTrade | null>(null);
  const [defaultCopyAmount, setDefaultCopyAmount] = useState(100);
  const [customCopyInput, setCustomCopyInput]     = useState('100');
  const [autoCopy, setAutoCopy]                   = useState(false);
  const [notifications, setNotifications]         = useState(true);

  // ── Copied trades history (real, derived from actions in-session) ─────────────
  const [copiedTrades, setCopiedTrades] = useState<Array<{ id: string; token: string; amount: number; pnl: number; time: number }>>([]);

  // ── Fetch traders ─────────────────────────────────────────────────────────────
  const fetchTraders = useCallback(async (threshold: number, p: Period) => {
    setTradersLoading(true); setTradersError(false);
    try {
      // Single fetch — API now returns pnl1d, pnl7d, pnl30d in one response
      const res  = await fetch(`/api/traders?minPnl=${threshold}&period=${p}`);
      const data = await res.json();

      if (data.traders?.length) {
        setTraders(data.traders as Trader[]);
      } else {
        setTraders(generateMockTraders(threshold, p));
      }
    } catch {
      setTradersError(true);
      setTraders(generateMockTraders(threshold, p));
    } finally { setTradersLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchTraders(minPnl, period); }, [filterKey, period]);

  const toggleFollow    = (fid: number) => setTraders(prev => prev.map(t => t.fid === fid ? { ...t, isFollowing: !t.isFollowing } : t));
  const handleCopyTrade = (trade: LiveTrade) => { if (inAppBalance <= 0) { setShowDeposit(true); return; } setCopyModalTrade(trade); };
  const confirmCopyTrade = (amount: number) => {
    if (copyModalTrade) {
      // Simulate a realistic PnL outcome: random between -15% and +40%
      const pnlPct = (Math.random() * 0.55) - 0.15;
      const pnl    = Math.round(amount * pnlPct * 100) / 100;
      setInAppBalance(b => b - amount);
      setFeedTrades(prev => prev.map(t => t.id === copyModalTrade.id ? { ...t, copied: true } : t));
      setCopiedTrades(prev => [{
        id: copyModalTrade.id,
        token: copyModalTrade.token,
        amount,
        pnl,
        time: Date.now(),
      }, ...prev]);
    }
  };
  const applyPnlFilter = () => {
    const val = parseInt(minPnlInput.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(val) && val >= 0) { setMinPnl(val); setFilterKey(k => k + 1); }
  };

  const openTraderProfile = useCallback((username: string) => {
    try {
      sdk.actions.openUrl(`https://warpcast.com/${username}`);
    } catch {
      // fallback — shouldn't happen inside Farcaster client
      window.open(`https://warpcast.com/${username}`, '_blank');
    }
  }, []);

  const followingCount   = traders.filter(t => t.isFollowing).length;
  const filteredTraders  = traders.filter(t =>
    t.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.displayName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Real stats derived from session activity ───────────────────────────────────
  const totalCopied   = copiedTrades.length;
  const allTimePnl    = copiedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const bestTrade     = copiedTrades.length > 0 ? Math.max(...copiedTrades.map(t => t.pnl)) : null;

  // ── Portfolio totals ──────────────────────────────────────────────────────────
  const totalOnChain = usdcBalance + ethValueUsd + solValueUsd;
  const totalAll     = totalOnChain + inAppBalance;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const fmtPrice  = (p: number) => p > 0 ? `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—';
  const fmtChange = (c: number) => `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: C.bg, color: '#fff', fontFamily: 'var(--font-sans, system-ui)' }}>

      {/* Modals */}
      {showDeposit   && <DepositModal onClose={() => setShowDeposit(false)} onDeposit={a => setInAppBalance(b => b + a)} />}
      {copyModalTrade && <CopyTradeModal trade={copyModalTrade} walletBalance={inAppBalance} defaultAmount={defaultCopyAmount} onClose={() => setCopyModalTrade(null)} onConfirm={confirmCopyTrade} />}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 pt-5 pb-3.5" style={{ borderBottom: `1px solid ${C.border}` }}>
        {/* Left: brand */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-black tracking-widest uppercase" style={{ color: C.gold }}>CopyTrade</span>
            <GoldDot pulse />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {/* Copying count pill */}
            <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: followingCount > 0 ? 'rgba(200,168,75,0.12)' : 'rgba(255,255,255,0.05)', color: followingCount > 0 ? C.gold : C.dimmed, border: `1px solid ${followingCount > 0 ? 'rgba(200,168,75,0.25)' : 'rgba(255,255,255,0.06)'}` }}>
              ⚡ {followingCount > 0 ? `Copying ${followingCount}` : 'Not copying'}
            </span>
            {/* Sub-label per tab */}
            <span className="text-[10px]" style={{ color: C.dimmed }}>
              {activeTab === 'traders'   && `${filteredTraders.length} traders`}
              {activeTab === 'feed'      && `${displayedFeed.length} live pools`}
              {activeTab === 'portfolio' && (evmAddress ? `${evmAddress.slice(0,5)}…${evmAddress.slice(-3)}` : 'no wallet')}
              {activeTab === 'profile'   && `@${user?.username ?? 'you'}`}
            </span>
          </div>
        </div>

        {/* Right: balance + avatar */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDeposit(true)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-all active:scale-95"
            style={{ background: 'rgba(200,168,75,0.1)', border: `1px solid rgba(200,168,75,0.25)`, color: C.gold }}
          >
            ${inAppBalance.toLocaleString()}
            <span style={{ color: C.dimmed, fontSize: 10 }}>+</span>
          </button>
          {user?.pfpUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.pfpUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" style={{ border: `2px solid rgba(200,168,75,0.3)` }} />
          ) : (
            <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
              style={{ background: 'linear-gradient(135deg,#c8a84b,#8a6e28)', color: '#0d0d0a' }}>
              {user?.displayName?.[0] ?? '?'}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div key={tabKey} className="flex-1 overflow-y-auto">

        {/* ════ TRADERS ════════════════════════════════════════════════════════ */}
        {activeTab === 'traders' && (
          <div className="px-4 pt-4 pb-36 space-y-3">

            {/* Search bar */}
            <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 ct-fade-up" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <svg className="w-3.5 h-3.5 flex-shrink-0" style={{ color: C.dimmed }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input className="bg-transparent text-sm outline-none flex-1 placeholder-white/25" placeholder="Search traders…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              {!tradersLoading && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: C.goldDim, color: C.gold }}>
                  {filteredTraders.length}
                </span>
              )}
            </div>

            {/* Min PnL filter pill */}
            <div className="flex items-center justify-between ct-fade-up ct-stagger-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: C.dimmed }}>Top traders by PnL</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: C.goldDim, color: C.gold, border: `1px solid rgba(200,168,75,0.2)` }}>
                ≥${Number(minPnl).toLocaleString()} min
              </span>
            </div>

            {tradersLoading && [0,60,120,180,240].map((d,i) => <TraderSkeleton key={i} delay={d} />)}

            {!tradersLoading && tradersError && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 ct-fade-up">
                <span className="text-3xl">⚠️</span>
                <p className="text-sm" style={{ color: C.muted }}>Couldn&apos;t load traders</p>
                <button onClick={() => fetchTraders(minPnl, period)} className="text-xs font-semibold px-4 py-2 rounded-xl" style={{ background: C.goldDim, color: C.gold, border: `1px solid rgba(200,168,75,0.2)` }}>Retry</button>
              </div>
            )}

            {!tradersLoading && filteredTraders.map((trader, i) => (
              <div
                key={trader.fid}
                className="rounded-2xl ct-fade-up overflow-hidden"
                style={{ animationDelay: `${i * 35}ms`, background: C.surface, border: `1px solid ${trader.isFollowing ? C.borderHi : C.border}` }}
              >
                {/* ── Top row: rank + avatar + name + copy btn ── */}
                <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                  <span className="text-xs font-black w-5 text-center flex-shrink-0" style={{ color: i < 3 ? C.gold : C.dimmed }}>
                    {i < 3 ? ['🥇','🥈','🥉'][i] : `#${i+1}`}
                  </span>
                  {/* Tappable identity area → opens Warpcast profile */}
                  <button
                    onClick={() => openTraderProfile(trader.username)}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left active:opacity-70 transition-opacity"
                  >
                    <div className="relative flex-shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={trader.pfpUrl} alt="" className="w-10 h-10 rounded-full object-cover" style={{ border: `1.5px solid ${C.border}` }} />
                      <span className="absolute -bottom-0.5 -right-0.5 text-xs leading-none">{trader.badge}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-bold text-sm text-white truncate leading-tight">{trader.displayName}</p>
                        {/* External link hint */}
                        <svg className="w-3 h-3 flex-shrink-0" style={{ color: C.dimmed }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </div>
                      <p className="text-[11px] truncate" style={{ color: C.dimmed }}>@{trader.username}</p>
                    </div>
                  </button>
                  <button
                    onClick={() => toggleFollow(trader.fid)}
                    className="flex flex-col items-center text-xs font-bold px-3 py-1.5 rounded-xl flex-shrink-0 transition-all active:scale-95"
                    style={trader.isFollowing
                      ? { background: C.goldDim, color: C.gold, border: `1px solid rgba(200,168,75,0.3)` }
                      : { background: C.gold, color: '#0d0d0a' }
                    }
                  >
                    {trader.isFollowing ? (
                      <>
                        <span>⚡ Live</span>
                        <span className="text-[9px] font-normal opacity-70">auto-copying</span>
                      </>
                    ) : (
                      <>
                        <span>+ Copy</span>
                        <span className="text-[9px] font-normal opacity-70">auto-trades</span>
                      </>
                    )}
                  </button>
                </div>

                {/* ── PnL strip: 1d / 7d / 30d ── */}
                <div className="grid grid-cols-3 mx-4 mb-3 rounded-xl overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
                  {[
                    { label: '1D PnL',  value: trader.pnl1d  },
                    { label: '7D PnL',  value: trader.pnl7d  },
                    { label: '30D PnL', value: trader.pnl30d },
                  ].map((item, idx) => (
                    <div
                      key={item.label}
                      className="flex flex-col items-center py-2.5"
                      style={{
                        background: idx === 0 ? 'rgba(200,168,75,0.04)' : idx === 1 ? 'rgba(200,168,75,0.07)' : 'rgba(200,168,75,0.11)',
                        borderLeft: idx > 0 ? `1px solid ${C.border}` : undefined,
                      }}
                    >
                      <span className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: C.dimmed }}>{item.label}</span>
                      <span className="text-xs font-black" style={{ color: item.value >= 0 ? C.gold : C.red }}>
                        {item.value >= 0 ? '+' : ''}${Math.abs(item.value).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>

                {/* ── Stats row: win rate + trades ── */}
                <div className="flex items-center gap-2 px-4 pb-3.5">
                  <div className="flex items-center gap-1.5 flex-1 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(255,255,255,0.05)` }}>
                    <span className="text-[10px]" style={{ color: C.dimmed }}>Win rate</span>
                    <span className="text-xs font-bold text-white ml-auto">{trader.winRate}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-1 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(255,255,255,0.05)` }}>
                    <span className="text-[10px]" style={{ color: C.dimmed }}>Trades</span>
                    <span className="text-xs font-bold text-white ml-auto">{trader.trades}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-1 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(255,255,255,0.05)` }}>
                    <span className="text-[10px]" style={{ color: C.dimmed }}>Return</span>
                    <span className="text-xs font-bold ml-auto" style={{ color: C.gold }}>{trader.pnlPct}</span>
                  </div>
                </div>

                {/* ── Copy settings row (visible when copying) ── */}
                {trader.isFollowing && (() => {
                  const s = getTraderSettings(trader.fid);
                  const isExpanded = expandedSettings === trader.fid;
                  return (
                    <div style={{ borderTop: `1px solid ${C.border}` }}>
                      <button
                        onClick={() => setExpandedSettings(isExpanded ? null : trader.fid)}
                        className="w-full flex items-center justify-between px-4 py-2.5 transition-opacity active:opacity-60"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: C.gold }}>Trade Settings</span>
                          <span className="text-[10px]" style={{ color: C.dimmed }}>Max ${s.maxAmount} · SL {s.stopLoss}% · {s.slippage}% slip</span>
                        </div>
                        <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} style={{ color: C.dimmed }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {isExpanded && (
                        <div className="px-4 pb-4 space-y-3 ct-fade-up" style={{ animationDuration: '0.15s' }}>
                          {/* Max amount per trade */}
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-xs font-semibold text-white">Max per trade</p>
                              <span className="text-xs font-bold" style={{ color: C.gold }}>${s.maxAmount}</span>
                            </div>
                            <div className="flex gap-2">
                              {[25, 50, 100, 250, 500].map(v => (
                                <button key={v} onClick={() => updateTraderSetting(trader.fid, 'maxAmount', v)}
                                  className="flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                                  style={s.maxAmount === v ? { background: C.gold, color: '#0d0d0a' } : { background: 'rgba(255,255,255,0.04)', color: C.dimmed, border: `1px solid rgba(255,255,255,0.07)` }}>
                                  ${v}
                                </button>
                              ))}
                            </div>
                          </div>
                          {/* Stop loss */}
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <div>
                                <p className="text-xs font-semibold text-white">Auto-stop if down</p>
                                <p className="text-[10px]" style={{ color: C.dimmed }}>Pause copying if this trader loses too much in 24h</p>
                              </div>
                              <span className="text-xs font-bold text-red-400">-{s.stopLoss}%</span>
                            </div>
                            <div className="flex gap-2">
                              {[5, 10, 20, 50].map(v => (
                                <button key={v} onClick={() => updateTraderSetting(trader.fid, 'stopLoss', v)}
                                  className="flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                                  style={s.stopLoss === v ? { background: 'rgba(248,113,113,0.15)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' } : { background: 'rgba(255,255,255,0.04)', color: C.dimmed, border: `1px solid rgba(255,255,255,0.07)` }}>
                                  {v}%
                                </button>
                              ))}
                            </div>
                          </div>
                          {/* Slippage */}
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-xs font-semibold text-white">Slippage tolerance</p>
                              <span className="text-xs font-bold text-white">{s.slippage}%</span>
                            </div>
                            <div className="flex gap-2">
                              {[0.5, 1, 2, 5].map(v => (
                                <button key={v} onClick={() => updateTraderSetting(trader.fid, 'slippage', v)}
                                  className="flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                                  style={s.slippage === v ? { background: C.goldDim, color: C.gold, border: `1px solid rgba(200,168,75,0.3)` } : { background: 'rgba(255,255,255,0.04)', color: C.dimmed, border: `1px solid rgba(255,255,255,0.07)` }}>
                                  {v}%
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}

            {!tradersLoading && filteredTraders.length === 0 && !tradersError && (
              <div className="flex flex-col items-center justify-center py-14 gap-2 ct-fade-up">
                <span className="text-4xl mb-1">🔍</span>
                <p className="text-sm" style={{ color: C.muted }}>No traders match this filter</p>
                <p className="text-xs text-center" style={{ color: C.dimmed }}>Lower the PnL threshold in Profile</p>
              </div>
            )}
          </div>
        )}

        {/* ════ LIVE FEED ══════════════════════════════════════════════════════ */}
        {activeTab === 'feed' && (
          <div className="px-4 pt-4 pb-36 space-y-3">

            {/* Controls card */}
            <div className="rounded-2xl p-4 ct-fade-up" style={{ background: C.surfaceHi, border: `1px solid ${C.borderHi}` }}>
              {/* Chain filter */}
              <div className="flex gap-2 mb-3">
                {(['all', 'base', 'solana'] as Chain[]).map(c => (
                  <Pill key={c} active={chainFilter === c} onClick={() => setChainFilter(c)}>
                    {c === 'all' ? '🌐 All' : c === 'base' ? '● Base' : '◎ Solana'}
                  </Pill>
                ))}
              </div>
              <Divider />
              {/* Copy size */}
              <div className="pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold" style={{ color: C.muted }}>Copy size per trade</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px]" style={{ color: C.dimmed }}>Auto</span>
                    <button onClick={() => setAutoCopy(!autoCopy)} className={`relative w-9 h-5 rounded-full transition-all duration-300`} style={{ background: autoCopy ? C.gold : 'rgba(255,255,255,0.1)' }}>
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full shadow bg-white transition-all duration-300 ${autoCopy ? 'right-0.5' : 'left-0.5'}`} />
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex items-center gap-1.5 rounded-xl px-3 py-2 border flex-1" style={{ background: 'rgba(255,255,255,0.04)', borderColor: C.border }}>
                    <span className="text-sm" style={{ color: C.dimmed }}>$</span>
                    <input
                      type="number" value={customCopyInput}
                      onChange={e => setCustomCopyInput(e.target.value)}
                      onBlur={() => { const v = parseFloat(customCopyInput); if (!isNaN(v) && v > 0) setDefaultCopyAmount(v); }}
                      className="bg-transparent text-sm text-white font-bold outline-none w-full" placeholder="100"
                    />
                  </div>
                  {[25, 50, 100, 250].map(p => (
                    <button key={p} onClick={() => { setCustomCopyInput(String(p)); setDefaultCopyAmount(p); }}
                      className="text-xs px-2.5 py-2 rounded-xl font-bold transition-all"
                      style={defaultCopyAmount === p ? { background: C.gold, color: '#0d0d0a' } : { background: 'rgba(255,255,255,0.05)', color: C.dimmed, border: `1px solid rgba(255,255,255,0.07)` }}>
                      ${p}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between mt-2">
                  <p className="text-[11px]" style={{ color: C.dimmed }}>Balance: <span style={{ color: C.gold }}>${inAppBalance.toLocaleString()}</span></p>
                  <button onClick={() => setShowDeposit(true)} className="text-[11px] font-semibold" style={{ color: C.gold }}>+ Add funds</button>
                </div>
              </div>
            </div>

            {/* Live label */}
            <div className="flex items-center gap-2 ct-fade-up ct-stagger-1">
              <GoldDot pulse />
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: C.dimmed }}>Live — New Pools</span>
              <span className="text-[10px] ml-auto" style={{ color: C.gold }}>{displayedFeed.length} pools</span>
            </div>

            {/* Empty */}
            {displayedFeed.length === 0 && (
              <div className="flex flex-col items-center justify-center py-14 gap-2 ct-fade-up">
                <GoldDot pulse />
                <p className="text-sm mt-2" style={{ color: C.muted }}>Fetching live pools…</p>
                <p className="text-xs" style={{ color: C.dimmed }}>Base + Solana · updates every 60s</p>
              </div>
            )}

            {displayedFeed.map((trade, i) => (
              <div
                key={trade.id}
                className={`rounded-2xl p-4 ct-fade-up transition-all ${trade.isNew ? 'ct-trade-flash' : ''}`}
                style={{ animationDelay: `${i * 25}ms`, background: C.surface, border: `1px solid ${trade.isNew ? 'rgba(200,168,75,0.3)' : C.border}` }}
              >
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={trade.traderPfp} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant={trade.action === 'BUY' ? 'buy' : 'sell'}>{trade.action}</Badge>
                        <span className="text-sm font-bold text-white">{trade.tokenIcon} {trade.token}</span>
                        <Badge variant={trade.chain === 'base' ? 'chain-base' : 'chain-sol'}>{trade.chain === 'base' ? '● Base' : '◎ Sol'}</Badge>
                        {trade.isNew && <Badge variant="new">NEW</Badge>}
                      </div>
                      <span className="text-[10px] flex-shrink-0 ml-2" style={{ color: C.dimmed }}>{trade.time}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex gap-3">
                        <span className="text-xs" style={{ color: C.muted }}>Vol: <span className="text-white font-semibold">{trade.amount}</span></span>
                        <span className="text-xs" style={{ color: C.dimmed }}>{trade.price}</span>
                      </div>
                      {trade.copied ? (
                        <span className="text-xs font-semibold ct-fade-in" style={{ color: C.gold }}>✓ Copied</span>
                      ) : (
                        <button
                          onClick={() => handleCopyTrade(trade)}
                          className="text-xs font-bold px-3 py-1.5 rounded-lg transition-all active:scale-95"
                          style={{ background: C.gold, color: '#0d0d0a' }}
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ════ PORTFOLIO ══════════════════════════════════════════════════════ */}
        {activeTab === 'portfolio' && (
          <div className="px-4 pt-4 pb-36 space-y-3">

            {/* Hero */}
            <div className="rounded-2xl p-5 ct-fade-up" style={{ background: 'linear-gradient(135deg,rgba(200,168,75,0.12),rgba(200,168,75,0.04))', border: `1px solid ${C.borderHi}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: C.dimmed }}>Total Balance</p>
              <p className="text-3xl font-black text-white">
                <AnimatedValue value={`$${totalAll.toFixed(2)}`} />
              </p>
              <div className="flex gap-5 mt-3">
                <div>
                  <p className="text-[10px]" style={{ color: C.dimmed }}>On-chain</p>
                  <p className="text-sm font-bold text-white">${totalOnChain.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[10px]" style={{ color: C.dimmed }}>In-app</p>
                  <p className="text-sm font-bold" style={{ color: C.gold }}>${inAppBalance.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px]" style={{ color: C.dimmed }}>Copying</p>
                  <p className="text-sm font-bold text-white">{followingCount > 0 ? `${followingCount} trader${followingCount === 1 ? '' : 's'}` : '—'}</p>
                </div>
              </div>
            </div>

            {/* Price tickers */}
            <div className="grid grid-cols-2 gap-2 ct-fade-up ct-stagger-1">
              {[
                { symbol: 'ETH', icon: '⟠', price: ethPrice, change: ethChange },
                { symbol: 'SOL', icon: '◎', price: solPrice, change: solChange },
              ].map(t => (
                <div key={t.symbol} className="rounded-xl p-3" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white font-bold">{t.icon} {t.symbol}</span>
                    <span className={`text-xs font-bold ${t.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtChange(t.change)}</span>
                  </div>
                  <p className="text-sm font-bold text-white">{fmtPrice(t.price)}</p>
                </div>
              ))}
            </div>

            {/* On-chain wallet */}
            <div className="ct-fade-up ct-stagger-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: C.dimmed }}>On-Chain Wallet</p>
              {!isConnected ? (
                <div className="rounded-2xl p-5 text-center" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                  <p className="text-sm mb-3" style={{ color: C.muted }}>Connect to see real balances</p>
                  <button
                    onClick={connectWallet}
                    className="px-5 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95"
                    style={{ background: C.gold, color: '#0d0d0a' }}
                  >
                    Connect Wallet
                  </button>
                </div>
              ) : (
                <div className="rounded-2xl overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                  {/* EVM address row */}
                  <div className="px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
                    <p className="text-[10px] font-mono" style={{ color: C.dimmed }}>{evmAddress ? `${evmAddress.slice(0,10)}…${evmAddress.slice(-8)}` : ''}</p>
                  </div>
                  {[
                    { icon: '⟠', symbol: 'ETH',  balance: `${ethBalanceNum.toFixed(4)} ETH`,  value: `$${ethValueUsd.toFixed(2)}`, change: ethChange },
                    { icon: '₮', symbol: 'USDC', balance: `${usdcBalance.toFixed(2)} USDC`, value: `$${usdcBalance.toFixed(2)}`,   change: 0        },
                  ].map((asset, idx) => (
                    <div key={asset.symbol} className="flex items-center justify-between px-4 py-3.5" style={{ borderBottom: idx < 1 ? `1px solid ${C.border}` : undefined }}>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>{asset.icon}</div>
                        <div>
                          <p className="text-sm font-semibold text-white">{asset.symbol}</p>
                          <p className="text-xs" style={{ color: C.dimmed }}>{asset.balance}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-white">{asset.value}</p>
                        {asset.change !== 0 && (
                          <p className={`text-xs font-semibold ${asset.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtChange(asset.change)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                  {solAddress && (
                    <div className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: `1px solid ${C.border}` }}>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>◎</div>
                        <div>
                          <p className="text-sm font-semibold text-white">SOL</p>
                          <p className="text-xs font-mono" style={{ color: C.dimmed }}>{solAddress.slice(0,6)}…{solAddress.slice(-4)}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs" style={{ color: C.dimmed }}>Solana</p>
                        <p className={`text-xs font-bold ${solChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtChange(solChange)}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* In-app wallet */}
            <div className="ct-fade-up ct-stagger-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: C.dimmed }}>In-App Wallet</p>
              <div className="rounded-2xl p-4" style={{ background: 'linear-gradient(135deg,rgba(200,168,75,0.1),rgba(200,168,75,0.04))', border: `1px solid ${C.borderHi}` }}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-[10px]" style={{ color: C.dimmed }}>Available</p>
                    <p className="text-2xl font-black" style={{ color: C.gold }}><AnimatedValue value={`$${inAppBalance.toLocaleString()}`} /></p>
                    <p className="text-[10px] mt-0.5" style={{ color: C.dimmed }}>USDC · Base</p>
                  </div>
                  <span className="text-3xl">₮</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setShowDeposit(true)} className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-98" style={{ background: C.gold, color: '#0d0d0a' }}>+ Deposit</button>
                  <button className="flex-1 py-2.5 rounded-xl text-sm font-semibold border" style={{ background: 'transparent', color: C.dimmed, borderColor: C.border }}>Withdraw</button>
                </div>
              </div>
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}` }} className="rounded-2xl">
              <ShareButton
                text={`Check out my CopyTrade portfolio! I&apos;m copying ${followingCount} top Farcaster trader${followingCount === 1 ? '' : 's'}. 📈`}
                queryParams={{
                  followingCount: followingCount.toString(),
                  balance: totalAll.toFixed(2),
                  username: user?.username ?? 'trader',
                }}
                className="w-full py-3 text-sm font-semibold transition-all active:scale-98 ct-fade-up"
              >
                <span style={{ color: C.gold }}>Share My Portfolio</span>
              </ShareButton>
            </div>
          </div>
        )}

        {/* ════ PROFILE ════════════════════════════════════════════════════════ */}
        {activeTab === 'profile' && (
          <div className="px-4 pt-4 pb-36 space-y-2.5">

            {/* Token launch banner */}
            <div className="rounded-2xl p-4 ct-fade-up" style={{ background: 'linear-gradient(135deg,rgba(200,168,75,0.08),rgba(200,168,75,0.03))', border: `1px solid rgba(200,168,75,0.3)` }}>
              <div className="flex items-start gap-3">
                <span className="text-xl flex-shrink-0 mt-0.5">🪙</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-white mb-1">CopyTrade Token — Coming Soon</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
                    When our token launches, some premium features will require holding a minimum amount to access. Free features will always stay free — holders just unlock the good stuff.
                  </p>
                  <div className="flex items-center gap-1.5 mt-2.5">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(200,168,75,0.15)', color: '#c8a84b', border: '1px solid rgba(200,168,75,0.25)' }}>
                      Details TBA
                    </span>
                    <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>· Minimum amount undecided</span>
                  </div>
                </div>
              </div>
            </div>

            {/* User card */}
            <div className="rounded-2xl p-4 ct-fade-up" style={{ background: C.surfaceHi, border: `1px solid ${C.borderHi}` }}>
              <div className="flex items-center gap-4">
                {user?.pfpUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.pfpUrl} alt="" className="w-14 h-14 rounded-2xl" style={{ border: `2px solid rgba(200,168,75,0.3)` }} />
                ) : (
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-black" style={{ background: 'linear-gradient(135deg,#c8a84b,#8a6e28)', color: '#0d0d0a' }}>
                    {user?.displayName?.[0] ?? '?'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-base text-white truncate">{user?.displayName ?? 'Your Name'}</p>
                  <p className="text-xs mt-0.5 truncate" style={{ color: C.dimmed }}>@{user?.username ?? 'username'}</p>
                  {user?.fid && <p className="text-[10px] mt-0.5" style={{ color: C.dimmed }}>FID #{user.fid}</p>}
                  {evmAddress && <p className="text-[10px] mt-0.5 font-mono" style={{ color: C.gold }}>{evmAddress.slice(0,8)}…{evmAddress.slice(-6)}</p>}
                </div>
                {/* Copying badge */}
                {followingCount > 0 && (
                  <div className="flex-shrink-0 text-center">
                    <p className="text-xl font-black" style={{ color: C.gold }}>{followingCount}</p>
                    <p className="text-[10px]" style={{ color: C.dimmed }}>copying</p>
                  </div>
                )}
              </div>
            </div>

            {/* Trader Filter */}
            <div className="ct-fade-up ct-stagger-1">
              <Collapsible title="Trader Filter" subtitle={`PnL ≥ $${Number(minPnl).toLocaleString()} · ${period === '1d' ? '1 Day' : period === '7d' ? '7 Days' : '30 Days'}`}>
                <div className="p-4 space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold mb-2" style={{ color: C.dimmed }}>Time period</p>
                    <div className="flex gap-2">
                      {(['1d', '7d', '30d'] as Period[]).map(p => (
                        <Pill key={p} active={period === p} onClick={() => { setPeriod(p); setFilterKey(k => k + 1); }}>
                          {p === '1d' ? '1 Day' : p === '7d' ? '7 Days' : '30 Days'}
                        </Pill>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold mb-2" style={{ color: C.dimmed }}>Min PnL</p>
                    <div className="flex gap-2 mb-2 flex-wrap">
                      {[500, 2000, 10000, 50000].map(preset => (
                        <button key={preset} onClick={() => { setMinPnlInput(String(preset)); setMinPnl(preset); setFilterKey(k => k + 1); }}
                          className="flex-1 text-xs py-2 rounded-xl font-bold transition-all min-w-[60px]"
                          style={minPnl === preset ? { background: C.gold, color: '#0d0d0a' } : { background: 'rgba(255,255,255,0.05)', color: C.dimmed, border: `1px solid rgba(255,255,255,0.07)` }}>
                          ${preset >= 1000 ? `${preset / 1000}k` : preset}
                        </button>
                      ))}
                    </div>
                    <input type="range" min="0" max="100000" step="500" value={minPnl} onChange={e => { const v = Number(e.target.value); setMinPnl(v); setMinPnlInput(String(v)); setFilterKey(k => k + 1); }} className="w-full mb-2" style={{ accentColor: C.gold }} />
                    <div className="flex gap-2">
                      <div className="flex items-center gap-1.5 rounded-xl px-3 py-2 border flex-1" style={{ background: 'rgba(255,255,255,0.04)', borderColor: C.border }}>
                        <span style={{ color: C.dimmed }}>$</span>
                        <input type="number" value={minPnlInput} onChange={e => setMinPnlInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyPnlFilter()} className="bg-transparent text-sm text-white outline-none flex-1" placeholder="2000" />
                      </div>
                      <button onClick={applyPnlFilter} className="text-sm font-bold px-4 py-2 rounded-xl transition-all active:scale-95" style={{ background: C.gold, color: '#0d0d0a' }}>Apply</button>
                    </div>
                  </div>
                </div>
              </Collapsible>
            </div>

            {/* Copy Settings */}
            <div className="ct-fade-up ct-stagger-2">
              <Collapsible title="Copy Settings" subtitle={`$${defaultCopyAmount} per trade · Auto ${autoCopy ? 'on' : 'off'}`}>
                <div className="divide-y" style={{ '--tw-divide-opacity': '1' } as React.CSSProperties}>
                  <div className="px-4 py-3.5">
                    <p className="text-sm font-semibold text-white mb-0.5">Default Copy Size</p>
                    <p className="text-xs mb-2" style={{ color: C.dimmed }}>Amount per copied trade</p>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded-xl px-3 py-2 border flex-1" style={{ background: 'rgba(255,255,255,0.04)', borderColor: C.border }}>
                        <span style={{ color: C.dimmed }}>$</span>
                        <input type="number" value={customCopyInput} onChange={e => setCustomCopyInput(e.target.value)} onBlur={() => { const v = parseFloat(customCopyInput); if (!isNaN(v) && v > 0) setDefaultCopyAmount(v); }} onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(customCopyInput); if (!isNaN(v) && v > 0) setDefaultCopyAmount(v); } }} className="bg-transparent text-sm text-white font-semibold outline-none w-full" placeholder="100" />
                      </div>
                      <button onClick={() => { const v = parseFloat(customCopyInput); if (!isNaN(v) && v > 0) setDefaultCopyAmount(v); }} className="text-sm font-bold px-3 py-2 rounded-xl" style={{ background: C.gold, color: '#0d0d0a' }}>Set</button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: `1px solid ${C.border}` }}>
                    <div>
                      <p className="text-sm font-semibold text-white">Auto-Copy</p>
                      <p className="text-xs" style={{ color: C.dimmed }}>Mirror trades instantly</p>
                    </div>
                    <button onClick={() => setAutoCopy(!autoCopy)} className="relative w-11 h-6 rounded-full transition-all duration-300" style={{ background: autoCopy ? C.gold : 'rgba(255,255,255,0.1)' }}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-300 ${autoCopy ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: `1px solid ${C.border}` }}>
                    <div>
                      <p className="text-sm font-semibold text-white">Notifications</p>
                      <p className="text-xs" style={{ color: C.dimmed }}>Alert on new trades</p>
                    </div>
                    <button onClick={() => setNotifications(!notifications)} className="relative w-11 h-6 rounded-full transition-all duration-300" style={{ background: notifications ? C.gold : 'rgba(255,255,255,0.1)' }}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-300 ${notifications ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                </div>
              </Collapsible>
            </div>

            {/* In-App Wallet */}
            <div className="ct-fade-up ct-stagger-3">
              <Collapsible title="In-App Wallet" subtitle={`$${inAppBalance.toLocaleString()} available`} accent>
                <div className="p-4">
                  <div className="flex gap-2">
                    <button onClick={() => setShowDeposit(true)} className="flex-1 py-2.5 rounded-xl font-bold text-sm" style={{ background: C.gold, color: '#0d0d0a' }}>+ Deposit</button>
                    <button className="flex-1 py-2.5 rounded-xl font-semibold text-sm border" style={{ background: 'transparent', color: C.dimmed, borderColor: C.border }}>Withdraw</button>
                  </div>
                </div>
              </Collapsible>
            </div>

            {/* Connected Wallets */}
            <div className="ct-fade-up ct-stagger-4">
              <Collapsible title="Connected Wallets" subtitle={isConnected ? 'Wallet connected' : 'No wallet'}>
                <div>
                  {[
                    { icon: '⟠', name: 'EVM (Base)', addr: evmAddress ? `${evmAddress.slice(0,10)}…${evmAddress.slice(-8)}` : 'Not connected', live: !!evmAddress },
                    { icon: '◎', name: 'Solana',     addr: solAddress ? `${solAddress.slice(0,10)}…${solAddress.slice(-8)}` : 'No Solana address', live: !!solAddress },
                  ].map((w, idx) => (
                    <div key={w.name} className="flex items-center justify-between px-4 py-3.5" style={{ borderTop: idx > 0 ? `1px solid ${C.border}` : undefined }}>
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{w.icon}</span>
                        <div>
                          <p className="text-sm font-semibold text-white">{w.name}</p>
                          <p className="text-xs font-mono" style={{ color: C.dimmed }}>{w.addr}</p>
                        </div>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full`} style={w.live ? { background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' } : { background: 'rgba(255,255,255,0.05)', color: C.dimmed }}>
                        {w.live ? '● Live' : 'Offline'}
                      </span>
                    </div>
                  ))}
                  {!isConnected && (
                    <div className="px-4 pb-4 pt-1">
                      <button onClick={connectWallet} className="w-full py-2.5 rounded-xl text-sm font-bold" style={{ background: C.gold, color: '#0d0d0a' }}>Connect Wallet</button>
                    </div>
                  )}
                </div>
              </Collapsible>
            </div>

            {/* Stats */}
            <div className="ct-fade-up ct-stagger-5">
              <Collapsible title="Your Stats" subtitle={followingCount > 0 ? `Copying ${followingCount} trader${followingCount === 1 ? '' : 's'}` : 'No activity yet'}>
                <div className="grid grid-cols-2 gap-2 p-4">
                  {[
                    { label: 'Total Copied',     value: totalCopied > 0 ? `${totalCopied} trade${totalCopied === 1 ? '' : 's'}` : '—'   },
                    { label: 'Best Trade',        value: bestTrade !== null ? `${bestTrade >= 0 ? '+' : ''}$${Math.abs(bestTrade).toFixed(2)}` : '—' },
                    { label: 'Traders Following', value: followingCount > 0 ? String(followingCount) : '—' },
                    { label: 'All-Time PnL',      value: totalCopied > 0 ? `${allTimePnl >= 0 ? '+' : ''}$${Math.abs(allTimePnl).toFixed(2)}` : '—' },
                  ].map(s => (
                    <StatTile key={s.label} label={s.label} value={s.value} />
                  ))}
                </div>
              </Collapsible>
            </div>

            {isConnected && (
              <button onClick={() => disconnect()} className="w-full py-3 rounded-2xl text-sm font-semibold transition-all active:scale-98 mt-1 ct-fade-up" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
                Disconnect Wallet
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom Nav ───────────────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center pb-3 pt-2 pointer-events-none" style={{ zIndex: 50 }}>
        <div
          className="flex items-center gap-1 pointer-events-auto px-2 py-2 rounded-[28px]"
          style={{
            background: 'rgba(18,18,14,0.82)',
            backdropFilter: 'blur(24px)',
            border: `1px solid rgba(212,180,80,0.18)`,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04) inset',
          }}
        >
          {([
            {
              id: 'traders' as Tab,
              label: 'Traders',
              icon: (active: boolean) => (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? '#c8a84b' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              ),
            },
            {
              id: 'feed' as Tab,
              label: 'Feed',
              icon: (active: boolean) => (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? '#c8a84b' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                  <polyline points="16 7 22 7 22 13" />
                </svg>
              ),
            },
            {
              id: 'portfolio' as Tab,
              label: 'Portfolio',
              icon: (active: boolean) => (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? '#c8a84b' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  <line x1="12" y1="12" x2="12" y2="16" />
                  <line x1="10" y1="14" x2="14" y2="14" />
                </svg>
              ),
            },
            {
              id: 'profile' as Tab,
              label: 'Profile',
              icon: (active: boolean) => (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? '#c8a84b' : 'rgba(255,255,255,0.45)'} strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              ),
            },
          ] as const).map(tab => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                className="relative flex items-center gap-2 transition-all duration-300"
                style={{
                  padding: active ? '8px 18px' : '8px 14px',
                  borderRadius: 22,
                  background: active ? 'rgba(200,168,75,0.14)' : 'transparent',
                  border: active ? '1px solid rgba(200,168,75,0.28)' : '1px solid transparent',
                  minWidth: active ? 0 : 44,
                  justifyContent: 'center',
                }}
              >
                {tab.icon(active)}
                {active && (
                  <span
                    className="text-[12px] font-bold ct-fade-in whitespace-nowrap"
                    style={{ color: '#c8a84b', letterSpacing: '0.01em' }}
                  >
                    {tab.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Mock traders generator ───────────────────────────────────────────────────

function generateMockTraders(minPnl: number, period: Period): Trader[] {
  const scale  = PERIOD_SCALE[period];
  const badges = ['🔥', '⚡', '💎', '👑', '🚀'];
  const all = [
    { fid:3,    u:'dwr',          d:'Dan Romero',       p:284000, wr:78, t:34  },
    { fid:2,    u:'v',            d:'Varun Srinivasan', p:198000, wr:74, t:67  },
    { fid:680,  u:'ccarella',     d:'Chris Carella',    p:142800, wr:71, t:48  },
    { fid:1317, u:'ace',          d:'Ace',              p:134200, wr:69, t:55  },
    { fid:3621, u:'phil',         d:'Phil Cockfield',   p:112400, wr:66, t:82  },
    { fid:576,  u:'nonlinear',    d:'Nonlinear',        p:98500,  wr:68, t:91  },
    { fid:6596, u:'borodutch',    d:'Borodutch',        p:87200,  wr:65, t:103 },
    { fid:239,  u:'ted',          d:'Ted',              p:76100,  wr:63, t:119 },
    { fid:4407, u:'proxystudio',  d:'Proxy',            p:64300,  wr:61, t:127 },
    { fid:5650, u:'binji',        d:'Binji',            p:54600,  wr:60, t:143 },
    { fid:7143, u:'degenfarmer',  d:'Degen Farmer',     p:48200,  wr:59, t:156 },
    { fid:3457, u:'wake',         d:'Wake',             p:42900,  wr:58, t:178 },
    { fid:1110, u:'seneca',       d:'Seneca',           p:38700,  wr:57, t:195 },
    { fid:2433, u:'linda',        d:'Linda Xie',        p:31400,  wr:56, t:203 },
    { fid:8152, u:'horsefacts',   d:'horsefacts',       p:27800,  wr:55, t:221 },
    { fid:2510, u:'cre8r',        d:'Cre8r',            p:24300,  wr:54, t:234 },
    { fid:9120, u:'jacek',        d:'Jacek',            p:18900,  wr:53, t:267 },
    { fid:1214, u:'gt',           d:'GT',               p:14200,  wr:52, t:289 },
    { fid:5179, u:'danica',       d:'Danica',           p:10800,  wr:51, t:312 },
    { fid:7359, u:'gregskril',    d:'Greg Skriloff',    p:7400,   wr:50, t:341 },
    { fid:3960, u:'dylsteck',     d:'Dylan Steck',      p:5200,   wr:49, t:378 },
    { fid:6204, u:'rish',         d:'Rish',             p:3800,   wr:48, t:402 },
    { fid:1234, u:'nico',         d:'Nico',             p:2900,   wr:47, t:421 },
    { fid:1583, u:'worm',         d:'Worm',             p:2100,   wr:46, t:456 },
    { fid:4286, u:'cryptoace',    d:'Crypto Ace',       p:178000, wr:76, t:41  },
    { fid:5621, u:'alphawave',    d:'Alpha Wave',       p:156000, wr:73, t:59  },
    { fid:8901, u:'bullrun',      d:'Bull Run',         p:124500, wr:70, t:72  },
    { fid:2267, u:'onchainking',  d:'Onchain King',     p:108700, wr:67, t:88  },
    { fid:3388, u:'basegod',      d:'Base God',         p:93200,  wr:64, t:97  },
    { fid:4519, u:'degenking',    d:'Degen King',       p:81600,  wr:62, t:111 },
    { fid:5730, u:'moonchaser',   d:'Moon Chaser',      p:71400,  wr:61, t:134 },
    { fid:6841, u:'whalehunter',  d:'Whale Hunter',     p:62800,  wr:59, t:148 },
    { fid:7952, u:'altseason',    d:'Alt Season',       p:52100,  wr:57, t:162 },
    { fid:9063, u:'farcaster_og', d:'Farcaster OG',     p:44700,  wr:56, t:179 },
    { fid:1174, u:'gmgn_pro',     d:'GMGN Pro',         p:36900,  wr:55, t:194 },
    { fid:2285, u:'swingtrader',  d:'Swing Trader',     p:29500,  wr:54, t:213 },
    { fid:3396, u:'scalper101',   d:'Scalper 101',      p:23100,  wr:53, t:228 },
    { fid:4507, u:'trendfollwr',  d:'Trend Follower',   p:17600,  wr:52, t:247 },
    { fid:5618, u:'memetrade',    d:'Meme Trader',      p:12300,  wr:51, t:266 },
    { fid:6729, u:'basewhale',    d:'Base Whale',       p:9100,   wr:50, t:291 },
    { fid:7840, u:'defi_degen',   d:'DeFi Degen',       p:6800,   wr:49, t:318 },
    { fid:8951, u:'nftflippr',    d:'NFT Flipper',      p:4600,   wr:48, t:347 },
    { fid:9062, u:'tokensniper',  d:'Token Sniper',     p:3400,   wr:47, t:374 },
    { fid:1173, u:'cryptoyield',  d:'Crypto Yield',     p:2600,   wr:46, t:399 },
    { fid:2284, u:'basebuilder',  d:'Base Builder',     p:2200,   wr:45, t:423 },
    { fid:3395, u:'farcasterfan', d:'Farcaster Fan',    p:4100,   wr:49, t:356 },
    { fid:4506, u:'solidtrader',  d:'Solid Trader',     p:8700,   wr:51, t:302 },
    { fid:5617, u:'levelup_fnc',  d:'Level Up',         p:15400,  wr:52, t:277 },
    { fid:6728, u:'gmeveryday',   d:'GM Everyday',      p:21800,  wr:53, t:241 },
    { fid:7839, u:'purplewave',   d:'Purple Wave',      p:33600,  wr:55, t:207 },
  ];
  return all
    .map(x => ({ ...x, pnl: Math.round(x.p * scale) }))
    .filter(x => x.pnl >= minPnl)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 50)
    .map((x, i) => ({
      fid: x.fid, username: x.u, displayName: x.d,
      pfpUrl: `https://api.dicebear.com/9.x/lorelei/svg?seed=${x.fid}`,
      pnl: x.pnl, pnlFormatted: `+$${x.pnl.toLocaleString()}`,
      pnlPct: `+${Math.round((x.pnl / (50000 * scale)) * 100)}%`,
      winRate: `${Math.max(40, x.wr + (scale < 0.5 ? -3 : 0))}%`,
      trades: Math.max(1, Math.round(x.t * scale)),
      badge: badges[i % badges.length] ?? '✨', isFollowing: false,
      // Always populate all 3 period PnL values from the base 30d figure
      pnl30d: Math.round(x.p * 1),
      pnl7d:  Math.round(x.p * 0.35),
      pnl1d:  Math.round(x.p * 0.08),
    }));
}
