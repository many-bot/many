# Adivinhacao

Number guessing game for Manybot. The bot picks a random number and players try to guess it.

## Features

- **Random number generation**: Bot picks a number between 1 and 100
- **Hint system**: Tells players if their guess is higher or lower
- **Multiple games**: Each chat has its own independent game state
- **Simple commands**: Easy to start and stop games

## Usage

### Start a game

```
!adivinhação começar
```

The bot will pick a random number between 1 and 100.

### Make a guess

```
42
```

Just send any number. The bot will respond with:
- "Higher" if the secret number is greater
- "Lower" if the secret number is smaller
- "Correct!" when you guess the right number

### Stop a game

```
!adivinhação parar
```

Cancels the active game.

### Show help

```
!adivinhação
```

Displays available commands.

## Commands

| Command | Description |
|---------|-------------|
| `!adivinhação` | Show help menu |
| `!adivinhação começar` | Start a new guessing game |
| `!adivinhação parar` | Stop the current game |

## Configuration

No configuration required. The game works out of the box.

## Localization

Available in:
- Portuguese (`locale/pt.json`)
