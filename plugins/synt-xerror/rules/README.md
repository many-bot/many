# rules

Group rules management for ManyBot — add, remove, reorder rules and send private warnings to members.

## Commands

```
!rules                        → show rules
!rules add <text>             → add a rule
!rules add <text> | penalty: <consequence>   → add with penalty
!rules rm <number>            → remove a rule
!rules mv <number> up/down    → reorder rules
!warn @member <rule number>   → warn member in private (shows the rule + penalty)
```

> Brazilian Portuguese: use `cima`/`baixo` instead of `up`/`down`.

Admin-only commands: `add`, `rm`, `mv`, `!warn`.  
Works in groups and communities only (except `!rules` which shows the list anywhere).

## Plugin API

Other plugins can import and read the rules:

```js
import { getRules, getRule } from "@manybot/rules";

// all rules for the current chat
const rules = getRules(ctx);

// specific rule by 1-based index
const rule = getRule(ctx, 2); // { text, penalty } or null
```

## Storage

Rules are saved per-chat in `~/.manybot/data/rules/rules.json`.
