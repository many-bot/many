# admin

Group moderation toolkit: bans/kicks, promote/demote, link blocking, auto-ban by number/DDD/country code, and automatic community support.

### Moderation

- `!ban` - mention, reply, or pass a number to remove someone
- `!promote` / `!demote`- mention, reply, or pass a number to change admin rights

### Link blocking

- `!linkblock on|off` - toggle link blocking for the group (not the whole community)
- `!linkblock allow|disallow <domain>` - manage the allowed domains list
- `!linkblock list` - show allowed domains
- `!linkblock reset` - restore the default allowed domains

### Auto-ban

- `!autoban on|off|status|list`
- `!autoban add numero|ddd|cc <value>`
- `!autoban remove numero|ddd|cc <value>`

New members matching a blacklisted number, DDD, or country code are kicked and blocked automatically.

### Ban clean

- `!banclean <number from 0 to 50>` - extra messages to delete from a user when they're banned, besides the replied one

### Communities

Native WhatsApp Communities are detected automatically, no setup needed. `!ban`, `!promote`, `!demote`, antispam kicks, link blocking on/off and auto-ban settings apply to every group in the community the current group belongs to (the bot needs to be a member of the community group).

All admin-only commands require the sender (and, where noted, the bot) to be a group admin. Messages are localized (pt/en) via `ctx.i18n`. Prefix (`!` above) is configurable via `CMD_PREFIX`.

## License

MIT

