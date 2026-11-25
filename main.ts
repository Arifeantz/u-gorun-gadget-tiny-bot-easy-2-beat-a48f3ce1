// Trend-filtered momentum rotation bot for agent-fun/bars-replay/v1.
//
// Idea: hold only the strongest names, and only when the market itself is
// rising. In a falling market the bot sits in cash; in a rising market it
// rotates into the top momentum symbols and cuts losers fast.
//
// Rules (all parameters round, few, and chosen for robustness, not fitted):
//   - Rank symbols by trailing 12-bar (12h) return, best first. A 12h
//     lookback reacts inside a 3-day final window; a 24h one would burn
//     a third of it just building history.
//   - Market filter: invest only if at least 3 symbols show a positive
//     12h return; otherwise sell everything and hold cash.
//   - Enter only symbols whose 12h return is above +1%; hold at most 4.
//   - Rebalance every 8 bars, starting once 12 bars of history exist.
//   - Stop-loss: sell a position the moment its value falls to 90% of its
//     cost. Momentum-break exit: sell if its 12h return drops below -5%.
//   - Size: cash split evenly over new entries, each capped at 25% of
//     equity (the harness max weight), so at most 100% is ever invested.
//   - A sell's proceeds never fund a buy in the same reply, so sells go
//     out on one bar and the buys on the next.
//   - Deterministic: no clock, no randomness, no network, no reads
//     outside this repository. Pure function of the bars seen so far.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 12;
const REBALANCE_EVERY = 8;
const MAX_HOLDINGS = 4;
const MIN_POSITIVE_FOR_MARKET = 3;
const ENTER_MIN_RETURN_BPS = 100;
const EXIT_RETURN_BPS = -500;
const STOP_LOSS_BPS = 9000;
const MAX_SLIPPAGE_BPS = 1000;

/** Each symbol's latest close as of every batch so far, by seq. */
const history = new Map<string, (bigint | null)[]>();
let nextRebalance = LOOKBACK_BARS;
/** Symbols to buy on this batch, chosen on the rebalance bar before it. */
let entering: string[] | null = null;

/** Trailing lookback return of a symbol as of batch `seq`, in bps, or null. */
function returnBps(symbol: string, seq: number): number | null {
  const closes = history.get(symbol);
  if (!closes) return null;
  const now = closes[seq];
  const then = closes[seq - LOOKBACK_BARS];
  if (now === null || now === undefined || then === null || then === undefined || then === 0n) return null;
  // (now - then) / then in bps, with bigint exactness on the ratio.
  const diff = now - then;
  return Number((diff * 10000n) / then);
}

/** Symbols ranked by 24h return as of batch `seq`, best first. */
function ranked(state: BarsState, seq: number): { symbol: string; ret: number }[] {
  const out: { symbol: string; ret: number }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const ret = returnBps(symbol, seq);
    if (ret !== null) out.push({ symbol, ret });
  }
  out.sort((a, b) => (b.ret - a.ret) || (a.symbol < b.symbol ? -1 : 1));
  return out;
}

/** Buy orders for symbols not yet held, sized evenly and capped by weight. */
function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const room = MAX_HOLDINGS - state.positions.size;
  const coming = symbols
    .filter((s) => !state.positions.has(s) && state.close(s) !== null)
    .slice(0, room > 0 ? room : 0);
  if (coming.length === 0) return [];
  const even = state.cash / BigInt(coming.length);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = even < byWeight ? even : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({
    side: 'buy',
    symbol,
    notional_quote_units: slice,
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  }));
}

/** Full-position sells for symbols that must exit now. */
function exits(state: BarsState): OrderInput[] {
  const sells: OrderInput[] = [];
  for (const [symbol, p] of state.positions) {
    const value = state.value(symbol, p.qty);
    const stopped = value * 10000n < p.cost * BigInt(STOP_LOSS_BPS);
    const ret = returnBps(symbol, state.seq);
    const broken = ret !== null && ret < EXIT_RETURN_BPS;
    if (stopped || broken) {
      sells.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
  }
  return sells;
}

await runBars({
  onHello(state) {
    nextRebalance = Math.max(LOOKBACK_BARS, state.warmupBars);
  },
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
    }
    if (state.warmingUp) return [];

    // Risk exits run every bar and take priority over entries.
    const stopSells = exits(state);
    if (stopSells.length > 0) {
      entering = null;
      return stopSells;
    }

    // Buys queued by the previous bar's rebalance (sells have now filled).
    if (entering !== null) {
      const orders = buys(state, entering);
      entering = null;
      return orders;
    }

    if (batch.seq < nextRebalance) return [];
    nextRebalance = batch.seq + REBALANCE_EVERY;

    const rank = ranked(state, batch.seq);
    const positive = rank.filter((r) => r.ret > 0).length;
    const marketUp = positive >= MIN_POSITIVE_FOR_MARKET;
    const want = marketUp
      ? rank.filter((r) => r.ret > ENTER_MIN_RETURN_BPS).slice(0, MAX_HOLDINGS).map((r) => r.symbol)
      : [];

    const sells: OrderInput[] = [...state.positions]
      .filter(([symbol]) => !want.includes(symbol))
      .map(([symbol, p]) => ({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }));
    if (sells.length === 0) return buys(state, want);
    entering = want;
    return sells;
  },
});
