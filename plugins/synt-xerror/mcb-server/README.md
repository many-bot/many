# mcb-server

Minecraft Bedrock server monitor for ManyBot. Notifies when players join or leave.

## Installation

```bash
manyplug install mcb-server
```

## Configuration

Add to your `manybot.conf`:

```
MC_GROUP_ID=5566999999999@g.us    # WhatsApp group to send notifications
MC_LOG_FILE=/var/log/minecraft/server.log   # Path to your Minecraft server log
```

### Setting up the log file (systemd)

To enable logging for your Minecraft Bedrock server via systemd, add the following to your service file:

```ini
[Service]
StandardOutput=append:/var/log/minecraft/server.log
StandardError=append:/var/log/minecraft/server.log
```

Then restart your service:

```bash
sudo systemctl restart minecraft-bedrock
```

## Features

- **Auto notifications**: Sends messages when players connect/disconnect
- **Player list**: See who's currently online

## Commands

| Command | Description |
|---------|-------------|
| `!players` | List players currently online |

## Example

```
!players
🎮 Players online (2):
- Steve
- Alex
```

