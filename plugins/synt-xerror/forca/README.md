# Forca

Hangman game for Manybot. Classic word guessing game with themed categories.

## Features

- **Multiple categories**: Animals, countries, programming languages, games, and more
- **6 lives**: Classic hangman rules
- **Full-word guessing**: Know the word? Type it whole to win instantly
- **Group-friendly**: Multiple players can participate in the same game
- **Visual progress**: Shows guessed letters and remaining blanks
- **No immediate repeats**: The same word won't be picked twice in a row
- **180+ words**: Large word bank across 20+ themes

## Word Categories

- Programming Languages (python, javascript, java)
- Animals (dog, cat, elephant, giraffe, lion, tiger, dolphin...)
- Musical Instruments (guitar, piano, drums, violin)
- Sports (soccer, basketball, swimming, tennis, baseball, boxing...)
- Countries (brazil, japan, canada, france, mexico, germany...)
- Planets (mars, venus, jupiter, saturn)
- Games (minecraft, fortnite, roblox)
- Board Games (chess, checkers, dominoes, cards)
- Flowers (rose, sunflower, tulip, orchid)
- Objects (scissors, notebook, computer, phone, key, umbrella...)
- Celestial Bodies (moon, sun, star, comet)
- Nature (ocean, mountain, forest, waterfall)
- Weather (rain, snow, thunder, hurricane, rainbow...)
- Food (chocolate, pizza, hamburger, sushi, salad...)
- Professions (teacher, doctor, engineer, firefighter...)
- Colors (red, blue, green, purple, gray...)
- Body Parts (head, hand, heart, brain, knee...)
- Vehicles (car, bicycle, airplane, train, helicopter...)
- Insects (butterfly, ant, bee, spider, dragonfly...)
- Clothing (shirt, pants, shoes, jacket, dress...)
- Kitchen (spoon, fork, knife, oven, blender...)

## Usage

### Start a game

```
!forca start
```

The bot picks a random word and shows the theme and blanks.

### Guess a letter

```
a
```

Send a single letter to guess. The bot will respond with:
- Which letters were revealed (if any)
- Remaining lives
- Current word progress

### Guess the whole word

```
elephant
```

If you already know the word, type it in full. A correct guess wins
immediately; a wrong guess costs one life, just like a wrong letter.

### Stop a game

```
!forca stop
```

Cancels the active game.

### Show help

```
!forca
```

Displays available commands.

## Commands

| Command | Description |
|---------|-------------|
| `!forca` | Show help menu |
| `!forca start` | Start a new hangman game |
| `!forca stop` | Stop the current game |
| `[a-z]` | Send any letter to guess |

## Game Rules

- 6 lives total
- Wrong guesses lose 1 life
- Game ends when:
  - Word is completely revealed (win)
  - All lives are lost (lose)

## Configuration

No configuration required. The game works out of the box.

## Localization

Available in:
- English (`locale/en.json`)
- Portuguese (`locale/pt.json`)
- Spanish (`locale/es.json`)
