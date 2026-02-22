const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const FormData = require('form-data');
const WebSocket = require('ws');
const crypto = require('crypto');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function derivePublicKeyRaw(publicKeyPem) {
    const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

function fingerprintPublicKey(publicKeyPem) {
    const raw = derivePublicKeyRaw(publicKeyPem);
    return crypto.createHash('sha256').update(raw).digest('hex');
}

const app = express();
const userHome = process.env.HOME || '/tmp';
const uploadDir = path.join(userHome, '.openclaw-jarvis-uploads');
const saveDir = path.join(userHome, '.openclaw-saved-audio');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
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
                    const wsUrl = `ws://127.0.0.1:18789/ws?token=${encodeURIComponent(gatewayToken)}`;
                    const ws = new WebSocket(wsUrl);

                    let resolved = false;

                    const cleanup = () => {
                        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                            ws.close();
                        }
                    };

                    // Load or Generate Persistent Bridge Device Identity for Crypto Signatures
                    const ID_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'bridge-identity.json');
                    let identity = null;
                    if (fs.existsSync(ID_PATH)) {
                        identity = JSON.parse(fs.readFileSync(ID_PATH, 'utf8'));
                    } else {
                        console.log("[Bridge] Generating new persistent ED25519 identity...");
                        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
                        identity = {
                            publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                            privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                        };
                        identity.deviceId = fingerprintPublicKey(identity.publicKeyPem);
                        if (!fs.existsSync(path.dirname(ID_PATH))) fs.mkdirSync(path.dirname(ID_PATH), { recursive: true });
                        fs.writeFileSync(ID_PATH, JSON.stringify(identity, null, 2));
                    }

                    const { deviceId, publicKeyPem, privateKeyPem } = identity;
                    const privateKey = crypto.createPrivateKey(privateKeyPem);

                    let deviceToken = null;
                    const TOKEN_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'bridge-token.txt');
                    if (fs.existsSync(TOKEN_PATH)) {
                        deviceToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
                    }

                    const clientId = 'gateway-client';
                    const role = 'operator';
                    const mode = 'backend';
                    const scopes = ['operator.admin', 'operator.write'];
                    const signedAtMs = Date.now();

                    const sendAgentTurn = () => {
                        console.log("[Bridge] Authenticated. Dispatching transcript to OpenClaw Agent...");
                        // Use correct 'agent' method and ensure `idempotencyKey` prevents replay conflicts
                        const rpcPayload = {
                            type: "req",
                            id: `turn_${Date.now()}`,
                            method: "agent",
                            params: {
                                message: transcript,
                                agentId: "main",
                                sessionKey: "esp32:bridge",
                                idempotencyKey: `turn-${Date.now()}`
                            }
                        };
                        ws.send(JSON.stringify(rpcPayload));
                    };

                    ws.on('open', () => {
                        console.log("[Bridge] Connected to OpenClaw WebSocket RPC Gateway. Waiting for challenge...");
                    });

                    ws.on('message', async (data) => {
                        try {
                            const response = JSON.parse(data.toString());

                            // 1. Handle Cryptographic Challenge by generating an ECDSA/ED25519 signature
                            if (response.type === 'event' && response.event === 'connect.challenge') {
                                const nonce = response.payload.nonce;
                                const activeToken = deviceToken || gatewayToken;
                                const authPayload = [
                                    'v2', deviceId, clientId, mode, role, scopes.join(','), String(signedAtMs), activeToken, nonce
                                ].join('|');

                                const signature = crypto.sign(null, Buffer.from(authPayload), privateKey).toString('base64');

                                ws.send(JSON.stringify({
                                    type: 'req', id: 'auth_1', method: 'connect',
                                    params: {
                                        minProtocol: 3, maxProtocol: 3,
                                        auth: { token: deviceToken || gatewayToken },
                                        role, scopes,
                                        client: { id: clientId, version: '1.0', platform: 'linux', mode },
                                        device: {
                                            id: deviceId,
                                            // The SDK expects pure SPKI base64url serialization
                                            publicKey: Buffer.from(derivePublicKeyRaw(publicKeyPem)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
                                            signature, signedAt: signedAtMs, nonce
                                        }
                                    }
                                }));
                                return;
                            }

                            // 2. Handle Authentication Success Response
                            if (response.type === 'res' && response.id === 'auth_1') {
                                if (response.ok) {
                                    if (response.payload && response.payload.auth && response.payload.auth.deviceToken) {
                                        deviceToken = response.payload.auth.deviceToken;
                                        fs.writeFileSync(TOKEN_PATH, deviceToken);
                                        console.log('[Bridge] Saved brand new device token !!!');
                                    }
                                    sendAgentTurn();
                                } else {
                                    console.error("[Bridge] OpenClaw Authentication Refused:", response.error);
                                    if (!resolved) {
                                        resolved = true;
                                        cleanup();
                                        resolve("Yetkilendirme reddedildi.");
                                    }
                                }
                                return;
                            }

                            // 2.5. Handle Pairing Requests Automatically
                            if (response.type === 'event' && response.event === 'device.pair.requested') {
                                const reqId = response.requestId || (response.payload && response.payload.requestId);
                                console.log('[Bridge] Auto-approving pairing request natively for bridge setup:', reqId);
                                ws.send(JSON.stringify({
                                    type: 'req', id: 'approve-1', method: 'device.pair.approve',
                                    params: { requestId: reqId, role, scopes }
                                }));
                                return;
                            }
                            if (response.type === 'res' && response.id === 'approve-1') {
                                console.log('[Bridge] Identity Approval OK. Re-running the request dynamically!');
                                ws.close(); // Force a clean exit to apply new token
                                if (!resolved) {
                                    resolved = true;
                                    resolve("Sunucu kimliği onaylandı. Lütfen komutu tekrar söyleyin.");
                                }
                                return;
                            }

                            // 3. Handle RPC Response
                            if (response.type === 'event' && response.event === 'chat') {
                                // Harvest the actual text payload mid-stream
                                if (response.payload && response.payload.state === 'final') {
                                    const msg = response.payload.message;
                                    if (msg && msg.role === 'assistant' && msg.content && msg.content.length > 0) {
                                        ws.finalAssistantReply = msg.content[0].text;
                                    }
                                }
                            } else if (response.type === 'res' && response.id !== 'auth_1' && response.id !== 'approve-1') {
                                if (response.ok === false && response.error) {
                                    console.error("[Bridge] OpenClaw Agent RPC Error:", response.error);
                                    if (!resolved) {
                                        resolved = true;
                                        cleanup();
                                        resolve("OpenClaw Hatası: " + (response.error.message || response.error.code || "Bilinmiyor").trim());
                                    }
                                } else {
                                    // The 'agent' method returns a runId immediately
                                    const resData = response.payload || response.result || {};
                                    if (resData.runId && (resData.status === 'accepted' || resData.status === 'running' || resData.status === 'queued')) {
                                        console.log(`[Bridge] Agent execution polling (Run ID: ${resData.runId}, Status: ${resData.status})...`);
                                        ws.send(JSON.stringify({
                                            type: "req",
                                            id: `wait_${Date.now()}`,
                                            method: "agent.wait",
                                            params: { runId: resData.runId }
                                        }));
                                        return; // Wait for wait_ callback.
                                    } else if (resData.status === 'ok' && resData.endedAt) {
                                        // The 'agent.wait' completed. Retrieve the text we harvested from the chat stream
                                        if (!resolved) {
                                            resolved = true;
                                            cleanup();
                                            resolve(ws.finalAssistantReply || "Cevap boş döndü.");
                                        }
                                    }
                                }
                            } else if (response.error && response.id !== 'auth_1') {
                                console.error("[Bridge] OpenClaw Socket Error:", response.error);
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
                            console.error("[Bridge] RPC WebSocket Timeout hit (120s) waiting for assistant.");
                            cleanup();
                            resolve("Bağlantı zaman aşımına uğradı, 120 saniyeyi aştınız.");
                        }
                    }, 120000); // 120 second timeout
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
