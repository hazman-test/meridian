import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, computeDeployAmount } from "./config.js";
import { agentLoop } from "./agent.js";
import { createLiveMessage, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import TraxrModule from "./tools/traxr.js";

const traxr = new TraxrModule();

// ═══════════════════════════════════════════
//  CYCLE TIMERS & TRACKING
// ═══════════════════════════════════════════
export let _screeningBusy = false; 
export let _screeningLastTriggered = 0; 

/** Strip <think>...</think> reasoning blocks that some models leak into output */
export function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Sanitize text for LLM prompts */
export function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

/**
 * The main screening execution loop.
 * Separated from index.js to allow granular logging and modularity.
 */
export async function runScreeningCycle({ silent = false, timers = null } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  log("screening", "Step 1: Starting pre-flight checks...");
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;

  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    
    // Check Position Limit
    log("screening", `Check: ${prePositions.total_positions}/${config.risk.maxPositions} positions open.`);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("screening", `🛑 ABORT: Max positions reached.`);
      _screeningBusy = false;
      return `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
    }

    // Check SOL Balance
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    log("screening", `Check: ${preBalance.sol.toFixed(3)} SOL available. Need ${minRequired} for deploy + gas.`);
    if (process.env.DRY_RUN !== "true" && preBalance.sol < minRequired) {
      log("screening", `🛑 ABORT: Insufficient SOL balance.`);
      _screeningBusy = false;
      return `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed).`;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    _screeningBusy = false;
    return `Screening pre-check failed: ${e.message}`;
  }

  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  
  // Update the global timers object passed from index.js
  if (timers) timers.screeningLastRun = Date.now();
  
  log("screening", "Step 2: Loading active strategy and fetching pool candidates...");
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    log("screening", `Strategy Initialized: ${activeStrategy?.name || "Default"}`);

    // Fetch top candidates
    const limit = config.screening.maxScreenedCandidates ?? 10;
    const topCandidates = await getTopCandidates({ limit: limit }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, limit);
    log("screening", `Found ${candidates.length} initial candidates from Meteora.`);

    log("screening", "Step 3: Enriching candidates with narratives, smart wallets, and security scores...");
    const allCandidates = [];
    for (const pool of candidates) {
      log("screening", `🔍 Fetching enrichment data for ${pool.name} (${pool.pool})...`);
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo, traxrData] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        traxr.getPoolScore(pool.base?.mint, pool.quote?.mint)
      ]);

      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        txr: traxrData.status === "fulfilled" ? traxrData.value : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    log("screening", "Step 4: Running Hard Security Gatekeeper filters...");
    const passing = allCandidates.filter(({ pool, ti, txr }) => {
      // 1. Traxr Safety Filter (FAIL-CLOSED)
      if (!txr || txr.score === undefined) {
        log("security", `❌ REJECT ${pool.name}: Traxr unavailable (Safety unverified)`);
        return false;
      }
      
      const minScore = config.screening.minTraxrScore ?? 65;
      if (txr.score < minScore || txr.impact === 'HIGH' || txr.impact === 'CRITICAL') {
        log("security", `❌ REJECT ${pool.name}: Risky Score ${txr.score}/100 (Impact: ${txr.impact})`);
        return false;
      }

      // 2. Hard TVL Filter (Prevents hallucinations on small pools)
      if (pool.active_tvl < config.screening.minTvl) {
        log("screening", `❌ REJECT ${pool.name}: TVL $${pool.active_tvl} < Min $${config.screening.minTvl}`);
        return false;
      }

      // 3. Launchpad & Bot filters
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `❌ REJECT ${pool.name}: Blocked launchpad (${launchpad})`);
        return false;
      }

      // 4. Force SOL Pairs Only
      if (pool.quote?.mint !== config.tokens.SOL) {
        log("screening", `❌ REJECT ${pool.name}: Not a SOL pair.`);
        return false;
      }

      // 5. Bot Holders
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `❌ REJECT ${pool.name}: Bot-holder filter (${botPct}% > ${maxBotHoldersPct}%)`);
        return false;
      }

      log("screening", `✅ PASS: ${pool.name} (Traxr: ${txr.score}, TVL: $${pool.active_tvl})`);
      return true;
    });

    log("screening", `Step 5: Passed filters: ${passing.length} pools. Preparing candidate blocks for LLM...`);
    if (passing.length === 0) {
      screenReport = `No candidates available (all blocked by security filters).`;
      _screeningBusy = false;
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, txr, mem }, i) => {
      // ─── DYNAMIC DEPLOY LIMIT (CALCULATED PER POOL) ─────────────────
      const deployLimit = computeDeployAmount(currentBalance.sol, currentBalance.sol_price, pool.active_tvl);

      // ─── DYNAMIC BIN SCALING (CALCULATED PER POOL) ──────────────────
      const BINS_PER_SOL = config.strategy.binsPerSol ?? 40; 
      const capitalAdjustedMaxBins = Math.floor(deployLimit * BINS_PER_SOL);
      const poolVolatility = pool.volatility || 0; 
      
      const dynamicBinsBelow = Math.min(
          Math.round(35 + (poolVolatility / 5) * 55), 
          capitalAdjustedMaxBins,                 
          config.strategy.binsBelow               
      );
      const finalBinsBelow = Math.max(20, dynamicBinsBelow);
      // ────────────────────────────────────────────────────────────────

      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      log("screening", `Metrics for ${pool.name}: Limit ${deployLimit} SOL, Target Bins ${finalBinsBelow}`);

      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");

      return [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: deploy_limit=${deployLimit} SOL, bins_below_target=${finalBinsBelow}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${poolVolatility}`,
        `  security: Traxr Score=${txr?.score ?? "N/A"}/100 | audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL`,
        okxParts ? `  okx: ${okxParts}` : `  okx: unavailable`,
        okxTags  ? `  tags: ${okxTags}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : null,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");
    });

    log("screening", "Step 6: Invoking LLM for deployment decision...");

    const prompt = `
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position. 
   IMPORTANT: Set amount_y EXACTLY to the 'deploy_limit' provided for your chosen pool. 
   RANGE CALCULATION: Set bins_below EXACTLY to the 'bins_below_target' value provided.

3. Report in this exact format:
   🚀 DEPLOYED
   <pool name>
   ◎ <deploy amount> SOL | <strategy>
   Range: <minPrice> → <maxPrice>
   WHY THIS WON: <2-4 concise sentences>
4. If no pool qualifies, report: ⛔ NO DEPLOY
      `;

    // Log the prompt for debugging
    log("llm_prompt", `\n--- START LLM PROMPT ---\n${prompt}\n--- END LLM PROMPT ---\n`);

    const { content } = await agentLoop(prompt, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

    log("screening", "Step 7: Cycle complete.");
    screenReport = content;
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled() && screenReport) {
      if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
      else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
    }
  }
  return screenReport;
}