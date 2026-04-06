import TraxrModule from "./traxr.js";
import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { sendMessage, isEnabled as telegramEnabled } from "../telegram.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
  timeframe = null, // Allows overrides for testing or specific cycles
  category = null   // Allows overrides for testing or specific cycles
} = {}) {
  const s = config.screening;

  // Use passed values OR fall back to config defaults
  const activeTimeframe = timeframe || s.timeframe;
  const activeCategory = category || s.category;

  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=0",
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${activeTimeframe}` + 
    `&category=${activeCategory}`;

  log("screening", `Meteora API Request URL: ${url}`);
  log("screening", `Meteora Filters String: ${filters}`);

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const condensed = (data.data || []).map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; 
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { pools } = await discoverPools({ page_size: 50 });

  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool) || occupiedMints.has(p.base?.mint)) return false;

      // Pool-level cooldown check from pool-memory.json
      if (isPoolOnCooldown(p.pool)) {
        const msg = `❄️ Skipping cooldown pool: ${p.name} (${p.pool.slice(0, 8)})\nTo stop skipping, edit or delete pool-memory.json.`;
        log("screening", msg);
        if (telegramEnabled()) sendMessage(msg).catch(() => {});
        return false;
      }

      // Token-level cooldown check from pool-memory.json
      if (isBaseMintOnCooldown(p.base?.mint)) {
        const msg = `❄️ Skipping cooldown token: ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})\nTo stop skipping, edit or delete pool-memory.json.`;
        log("screening", msg);
        if (telegramEnabled()) sendMessage(msg).catch(() => {});
        return false;
      }

      return true;
    })
    .slice(0, limit);

  // Enrichment with OKX, Traxr, and other signals...
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);
        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );

    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level = adv.risk_level;
        eligible[i].bundle_pct = adv.bundle_pct;
        eligible[i].sniper_pct = adv.sniper_pct;
        eligible[i].suspicious_pct = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all = adv.dev_sold_all;
        eligible[i].dex_boost = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath = price.ath;
      }
      if (clusters?.length) {
        eligible[i].kol_in_clusters = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend = clusters[0]?.trend ?? null;
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }

    // Filter wash trading and ATH proximity
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) { log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`); return false; }
      return true;
    }));

    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct != null && p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH`);
          return false;
        }
        return true;
      }));
    }
  }

  // Traxr Security Gate
  if (config.traxrEnabled) {
    const traxr = new TraxrModule();
    const threshold = config.screening.minTraxrScore ?? 65;
    const now = Date.now();
    if (!global.recentlyRejected) global.recentlyRejected = new Map();

    const traxrResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { score: 0, passed: false };
        if (global.recentlyRejected.has(p.base.mint)) {
          if (now - global.recentlyRejected.get(p.base.mint) < 300000) return { score: 0, passed: true };
        }
        try {
          const scoreData = await traxr.getPoolScore(p.base.mint, config.tokens.SOL);
          const score = scoreData?.safetyScore ?? scoreData?.score ?? 0;
          return { score, passed: score >= threshold };
        } catch (e) {
          return { score: 0, passed: true, warning: e.message.includes("timeout") ? "timeout" : null };
        }
      })
    );

    eligible.splice(0, eligible.length, ...eligible.filter((p, i) => {
      const res = traxrResults[i];
      if (res.status !== "fulfilled" || !res.value.passed) {
        global.recentlyRejected.set(p.base.mint, now);
        log("security", `❌ [REJECT] ${p.name} - Risky Score (${res.value?.score ?? 0} < ${threshold})`);
        return false;
      }
      p.traxr_safety_score = res.value.score;
      return true;
    }));
  }

  return { candidates: eligible, total_screened: pools.length };
}

export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}&timeframe=${timeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool detail API error: ${res.status}`);
  const data = await res.json();
  return data.data?.[0] || null;
}

function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: { symbol: p.token_x?.symbol, mint: p.token_x?.address, organic: Math.round(p.token_x?.organic_score || 0) },
    quote: { symbol: p.token_y?.symbol, mint: p.token_y?.address },
    active_tvl: Math.round(p.active_tvl || 0),
    fee_active_tvl_ratio: Number((p.fee_active_tvl_ratio || 0).toFixed(4)),
    volatility: Number((p.volatility || 0).toFixed(2)),
    mcap: Math.round(p.token_x?.market_cap || 0),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at ? Math.floor((Date.now() - p.token_x.created_at) / 3600000) : null,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,
    holders: p.base_token_holders
  };
}