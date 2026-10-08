# counting

A counting game plugin for Manybot. Players take turns sending the next integer in sequence.

Inspired by [Counting bot](https://countingbot.com/) from Discord.

## Rules

- Send the next number in sequence (`current + 1`)
- You cannot follow your own number
- Any mistake resets the count to `0`
- It ignores any media and message that is not a number (and consequently ignores the number 0)

## Configuration

Add to `~/.manybot/manyplug.conf` to restrict the game to specific chats:

```
COUNTING_CHATS=["120363xxxxxxx@g.us"]
```

If `COUNTING_CHATS` is empty, the plugin is silent in all chats.

## Commands

| Command | Description |
|---|---|
| `!counting` | Shows the rules and current count for the chat |
