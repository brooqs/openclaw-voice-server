# OpenClaw Voice Bridge Server

This repository contains the standalone Node.js Voice Relay Bridge required for parsing, streaming, and transcoding raw ESP32 I2S microphone payloads natively into the OpenClaw AI Core.

## Features
- **Zero-Dependency Core:** Utilizes native Node.js HTTP `axios` and `child_process` hooks to dynamically interface with OpenClaw and ElevenLabs, entirely circumventing legacy Bash scripts.
- **On-the-Fly Audio Containerization:** Uses FFMPEG internally to wrap headerless raw ESP32 bitstreams into 16kHz 16-bit Mono `.wav` files required by modern AI TTS engines.
- **Cross-Platform Daemon Persistence:** Ships with `systemd` (.service) and macOS `launchd` (.plist) daemon configurations to persistently run in the background.

## 🚀 Setup & Installation
1. Ensure your host machine has Node.js (v18+) and FFMPEG installed:
   ```bash
   sudo apt install ffmpeg -y
   ```
2. Clone the bridge server and install NPM dependencies:
   ```bash
   git clone git@github.com:brooqs/openclaw-voice-server.git
   cd openclaw-voice-server
   npm install
   ```
3. Edit your chosen background daemon template (`openclaw-bridge.service` for Linux or `com.openclaw.voicebridge.plist` for macOS) and uncomment the `Environment` / `EnvironmentVariables` block to inject your keys:
   - `OPENCLAW_GATEWAY_TOKEN`: Extracted from your `~/.openclaw/openclaw.json` or `openclaw status`.
   - `ELEVENLABS_API_KEY`: Your ElevenLabs Developer API Key.

## 💻 Running as a Background Service

### 🐧 Linux (Systemd)
Enable the bridge on Linux (Debian, Ubuntu, Raspberry Pi) to start on boot:
```bash
sudo cp openclaw-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-bridge
```

### 🍏 macOS (launchd)
Enable the bridge natively on your Mac background processes:
```bash
cp com.openclaw.voicebridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.voicebridge.plist
```

*The server will actively listen on port `18790` mapping STT transits.*
