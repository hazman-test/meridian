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

export let _screeningBusy = false; 
export let _screeningLastTriggered = 0; 

/** Strip <think>...</think> reasoning blocks */
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

export async function runScreeningCycle({ silent = false, timers = null } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; 
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
      return `Screening skipped — max positions reached.`;
    }

    // Check SOL Balance
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    log("screening", `Check: ${preBalance.sol.toFixed(3)} SOL available. Need ${minRequired} for deploy + gas.`);
    if (process.env.DRY_RUN !== "true" && preBalance.sol < minRequired) {
      log("screening", `🛑 ABORT: Insufficient SOL balance.`);
      _screeningBusy = false;
      return `Screening skipped — insufficient SOL.`;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    _screeningBusy = false;
    return `Screening pre-check failed: ${e.message}`;
  }

  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  
  if (timers) timers.screeningLastRun = Date.now();
  
  log("screening", "Step 2: Loading active strategy and fetching pool candidates...");
  try {
    const activeStrategy = getActiveStrategy();
    log("screening", `Strategy: ${activeStrategy?.name || "None (Default bid_ask)"}`);

    const limit = config.screening.maxScreenedCandidates ?? 10;
    const topCandidates = await getTopCandidates({ limit: limit }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, limit);
    log("screening", `Found ${candidates.length} initial candidates from Meteora.`);

    log("screening", "Step 3: Enriching candidates with narratives, smart wallets, and security scores...");
    const allCandidates = [];
    for (const pool of candidates) {
      log("screening", `🔍 Fetching data for ${pool.name} (${pool.pool})...`);
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
      await new Promise(r => setTimeout(r, 150)); 
    }

    log("screening", "Step 4: Running Hard Security Gatekeeper filters...");
    const passing = allCandidates.filter(({ pool, ti, txr }) => {
      // 1. Traxr Safety
      if (!txr || txr.score === undefined) {
        log("security", `❌ REJECT ${pool.name}: Traxr unavailable.`);
        return false;
      }
      const minScore = config.screening.minTraxrScore ?? 65;
      if (txr.score < minScore || txr.impact === 'HIGH' || txr.impact === 'CRITICAL') {
        log("security", `❌ REJECT ${pool.name}: Risky Score ${txr.score}/100 (Impact: ${txr.impact})`);
        return false;
      }

      // 2. TVL Filter
      if (pool.active_tvl < config.screening.minTvl) {
        log("screening", `❌ REJECT ${pool.name}: TVL $${pool.active_tvl} below min $${config.screening.minTvl}`);
        return false;
      }

      // 3. Launchpad & Quote
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `❌ REJECT ${pool.name}: Blocked launchpad (${launchpad})`);
        return false;
      }
      if (pool.quote?.mint !== config.tokens.SOL) {
        log("screening", `❌ REJECT ${pool.name}: Not a SOL pair.`);
        return false;
      }

      // 4. Bot Holders
      const botPct = ti?.audit?.bot_holders_pct;
      if (botPct != null && config.screening.maxBotHoldersPct != null && botPct > config.screening.maxBotHoldersPct) {
        log("screening", `❌ REJECT ${pool.name}: High bot percentage (${botPct}%).`);
        return false;
      }

      log("screening", `✅ PASS: ${pool.name} (Score: ${txr.score}, TVL: $${pool.active_tvl})`);
      return true;
    });

    log("screening", `Step 5: Passed filters: ${passing.length} pools. Preparing final blocks for LLM...`);
    if (passing.length === 0) {
      _screeningBusy = false;
      return `No candidates passed security filters.`;
    }

    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    const candidateBlocks = passing.map(({ pool, sw, n, ti, txr, mem }, i) => {
      const deployLimit = computeDeployAmount(currentBalance.sol, currentBalance.sol_price, pool.active_tvl);
      const BINS_PER_SOL = config.strategy.binsPerSol ?? 40; 
      const capitalAdjustedMaxBins = Math.floor(deployLimit * BINS_PER_SOL);
      const dynamicBinsBelow = Math.min(Math.round(35 + ((pool.volatility || 0) / 5) * 55), capitalAdjustedMaxBins, config.strategy.binsBelow);
      const finalBinsBelow = Math.max(20, dynamicBinsBelow);
      
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      log("screening", `Metrics for ${pool.name}: Limit ${deployLimit} SOL, Target Bins ${finalBinsBelow}`);

      return [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: deploy_limit=${deployLimit} SOL, bins_below_target=${finalBinsBelow}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}`,
        `  security: Traxr Score=${txr?.score ?? "N/A"}/100`,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : null,
      ].filter(Boolean).join("\n");
    });

    log("screening", "Step 6: Invoking LLM for deployment decision...");
    const { content } = await agentLoop(`
SCREENING CYCLE
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

Pick best pool, call deploy_position with EXACT deploy_limit and bins_below_target.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
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