const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const FormData = require('form-data');
const WebSocket = require('ws');

const app = express();
const uploadDir = '/tmp/jarvis-uploads/';
const saveDir = '/root/.openclaw/workspace/saved_audio/';
fs.mkdirSync(saveDir, { recursive: true });

const upload = multer({ dest: uploadDir });

// Replace these placeholders with your actual ElevenLabs credentials
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "YOUR_ELEVENLABS_API_KEY_HERE";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "YOUR_ELEVENLABS_VOICE_ID_HERE";

app.post('/voice', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No audio file provided');
        }

        const audioPath = req.file.path;
        const rawSize = fs.statSync(audioPath).size;
        console.log(`[Bridge] Received raw audio: ${audioPath} (${rawSize} bytes)`);

        // Save a copy of the raw PCM audio for the user to listen to
        const savedAudioPath = path.join(saveDir, `esp32_audio_${Date.now()}.raw`);
        fs.copyFileSync(audioPath, savedAudioPath);

        console.log('[Bridge] Running native STT via ElevenLabs Axios...');

        // 1. Convert Raw PCM to WAV
        const wavPath = `${audioPath}.wav`;
        execSync(`ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${audioPath}" "${wavPath}" > /dev/null 2>&1`);

        const wavSize = fs.statSync(wavPath).size;
        console.log(`[Bridge] Converted to WAV (${wavSize} bytes)`);

        // 2. STT API Request
        const formData = new FormData();
        formData.append('file', fs.createReadStream(wavPath), { filename: 'audio.wav', contentType: 'audio/wav' });
        formData.append('model_id', 'scribe_v1');
        formData.append('language_code', 'tr');

        const sttResponse = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formData, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                ...formData.getHeaders()
            }
        });

        const transcript = sttResponse.data.text ? sttResponse.data.text.trim() : "";
        console.log(`[Bridge] Transcript: ${transcript}`);

        console.log('[Bridge] Sending to OpenClaw API...');
        let assistantReply = "Anlayamadım.";

        // Only query OpenClaw if we actually have text
        // Only query OpenClaw if we actually have text
        if (transcript.length > 0) {
            try {
                // Determine Moltbot OpenClaw Backend Token Access implicitly via the root storage
                const openclawConfigPath = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
                let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

                if (!gatewayToken && fs.existsSync(openclawConfigPath)) {
                    try {
                        const configData = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
                        gatewayToken = configData.gateway?.token || "";
                    } catch (err) {
                        console.error("[Bridge] Failed to parse openclaw.json:", err.message);
                    }
                }

                if (!gatewayToken) {
                    console.warn("[Bridge] CRITICAL WARNING: No OpenClaw gateway token found in ~/.openclaw/openclaw.json! Connection might be refused.");
                }

                // Bypass slow CLI cold boots by calling the persistently running local OpenClaw daemon API natively via WebSocket RPC
                assistantReply = await new Promise((resolve) => {
                    const wsUrl = `ws://127.0.0.1:18789?token=${encodeURIComponent(gatewayToken)}`;
                    const ws = new WebSocket(wsUrl);

                    let resolved = false;

                    const cleanup = () => {
                        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                            ws.close();
                        }
                    };

                    ws.on('open', () => {
                        console.log("[Bridge] Connected to OpenClaw WebSocket RPC Gateway.");
                        // Standard OpenClaw JSON-RPC syntax for Gateway execution
                        const rpcPayload = {
                            jsonrpc: "2.0",
                            method: "agent/turn",
                            id: Date.now(),
                            params: {
                                agentId: "main",
                                message: transcript,
                                sessionKey: "agent:main:main"
                            }
                        };
                        ws.send(JSON.stringify(rpcPayload));
                    });

                    ws.on('message', (data) => {
                        try {
                            const response = JSON.parse(data.toString());
                            if (response.id && response.result) {
                                let finalReply = "Cevap boş döndü.";
                                const resData = response.result;

                                if (resData.messages && resData.messages.length > 0) {
                                    const lastMsg = resData.messages[resData.messages.length - 1];
                                    finalReply = (lastMsg.text || lastMsg.content || "Bir hata oluştu.").trim();
                                } else if (resData.text) {
                                    finalReply = resData.text.trim();
                                }

                                if (!resolved) {
                                    resolved = true;
                                    cleanup();
                                    resolve(finalReply);
                                }
                            } else if (response.error) {
                                console.error("[Bridge] OpenClaw RPC Payload Error:", response.error);
                                if (!resolved) {
                                    resolved = true;
                                    cleanup();
                                    resolve("Moltbot API hatası.");
                                }
                            }
                        } catch (err) {
                            console.error("[Bridge] Failed to parse WebSocket response:", err.message);
                        }
                    });

                    ws.on('error', (err) => {
                        console.error("[Bridge] WebSocket Error:", err.message);
                        if (!resolved) {
                            resolved = true;
                            cleanup();
                            resolve("Bağlantı kurulamadı.");
                        }
                    });

                    // Hard timeout for safety
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            console.error("[Bridge] RPC WebSocket Timeout hit (30s) waiting for assistant.");
                            cleanup();
                            resolve("Zaman aşımı.");
                        }
                    }, 30000); // 30 second timeout
                });

            } catch (e) {
                console.error("[Bridge] API Request Error:", e.message);
            }
        }
        console.log(`[Bridge] Assistant Reply: ${assistantReply}`);

        console.log('[Bridge] Running native TTS via ElevenLabs Axios...');
        // Strip out newlines, carriage returns, and ANSI color escape sequences/control characters which break JSON rendering
        const sanitizedReply = assistantReply
            .replace(/\n /g, ' ')
            .replace(/\n/g, ' ')
            .replace(/\r/g, ' ')
            .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        // 3. TTS API Request
        const ttsPayload = {
            text: sanitizedReply,
            model_id: "eleven_multilingual_v2",
            output_format: "mp3_22050_32",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        };

        const ttsResponse = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, ttsPayload, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
        });

        const tmpOutputPath = `/tmp/reply-${Date.now()}-temp.mp3`;
        const finalOutputPath = `/tmp/reply-${Date.now()}.mp3`;

        fs.writeFileSync(tmpOutputPath, ttsResponse.data);

        // 4. Normalize Audio for ESP32 (16kHz Mono Output)
        execSync(`ffmpeg -y -i "${tmpOutputPath}" -ar 16000 -ac 1 -filter:a "volume=1.5" "${finalOutputPath}" > /dev/null 2>&1`);

        console.log('[Bridge] Streaming MP3 back to ESP32...');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Connection', 'close');

        const stream = fs.createReadStream(finalOutputPath);
        stream.pipe(res);

        // Cleanup
        stream.on('end', () => {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            if (fs.existsSync(tmpOutputPath)) fs.unlinkSync(tmpOutputPath);
            if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
            console.log('[Bridge] Stream transaction complete, memory cleaned.');
        });

    } catch (error) {
        console.error('[Bridge] Error:', error.response ? error.response.data : error.message);
        res.status(500).send('Bridge Error');
    }
});

const PORT = 18790;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Bridge] Jarvis Native Node.js Bridge listening on port ${PORT}`);
});

// Configure Node.js HTTP Keep-Alive bounds for long inferences
server.keepAliveTimeout = 300000;
server.headersTimeout = 300000;
