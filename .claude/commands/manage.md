---
description: Review all open positions and take management actions
---
Run a full management cycle:

1. Check all positions — run via Bash:
```
node cli.js positions
```

2. For each position, get PnL using the address from step 1 — run via Bash with the actual address substituted:
```
node cli.js pnl ADDRESS
```
Replace ADDRESS with the position address string from step 1.

3. Decide action for each position:
   - **Claim**: if unclaimed fees > $5
   - **Close**: if out of range and has been OOR for a while, or PnL is deeply negative with no recovery signs
   - **Hold**: if in range and performing well
   - **Take profit**: if fees earned >= 10% of deployed capital

Execute any actions with the appropriate CLI commands. Explain each decision.

**Important:** Run all commands sequentially via Bash, never in background. Wait for each command to complete before running the next. Do not use background tasks or parallel execution.
