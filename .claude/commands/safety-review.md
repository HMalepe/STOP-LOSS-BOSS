---
description: Independent trading-safety review of recent changes
---
Use the trading-safety-reviewer agent to review the changes since the last commit on main (or the whole of src/ if there's no history).
Give it docs/03-TRADING-RULES.md and docs/05-SECURITY.md as the standard. Present its findings ranked by severity, then fix every critical and high finding and re-run /verify.
