const express = require('express');
const multer = require('multer');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

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
        console.log(`[Bridge] Received audio: ${audioPath}`);

        // Save a copy of the raw PCM audio for the user to listen to
        const savedAudioPath = path.join(saveDir, `esp32_audio_${Date.now()}.raw`);
        fs.copyFileSync(audioPath, savedAudioPath);

        console.log('[Bridge] Running native STT via ElevenLabs Axios...');

        // 1. Convert Raw PCM to WAV
        const wavPath = `${audioPath}.wav`;
        execSync(`ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${audioPath}" "${wavPath}" > /dev/null 2>&1`);

        // 2. STT API Request
        const formData = new FormData();
        formData.append('file', fs.createReadStream(wavPath), { filename: 'audio.wav', contentType: 'audio/wav' });

        const sttResponse = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formData, {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                ...formData.getHeaders()
            }
        });

        const transcript = sttResponse.data.text ? sttResponse.data.text.trim() : "";
        console.log(`[Bridge] Transcript: ${transcript}`);

        console.log('[Bridge] Sending to OpenClaw CLI...');
        let assistantReply = "Anlayamadım.";

        // Only query OpenClaw if we actually have text
        if (transcript.length > 0) {
            try {
                // Using the explicitly correct session routing flag --agent main
                const cliOutput = execFileSync("openclaw", ["agent", "--agent", "main", "--message", transcript]).toString().trim();
                assistantReply = cliOutput || "Anlayamadım.";
            } catch (e) {
                console.error("[Bridge] CLI Exec Error:", e.message);
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
