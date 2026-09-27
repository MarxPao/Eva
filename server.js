const http = require('http');
const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Carrega variáveis do .env
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        env[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim();
      }
    }
  }
}

const PORT = parseInt(process.env.PORT || env.PORT || '8080', 10);
const GROQ_API_KEY = process.env.GROQ_API_KEY || env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg'
};

const SYSTEM_PROMPT = `Você é EVA, uma assistente virtual de inteligência artificial elegante, empática, concisa e altamente inteligente.
Você conversa com o usuário em português do Brasil.
Suas respostas serão faladas em voz alta por um sintetizador de voz, portanto:
1. Seja direta, acolhedora e natural (evite respostas prolixas, listas longas com muitos tópicos ou tabelas).
2. Fale como uma pessoa em uma conversa real.
3. Se perguntada quem você é, diga que é a EVA, assistente de voz e presença inteligente.`;

// Inicializa TTS
const tts = new MsEdgeTTS();
let ttsReady = false;
async function initTTS() {
  try {
    await tts.setMetadata('pt-BR-FranciscaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    ttsReady = true;
    console.log('[TTS] Edge-TTS pronto com voz pt-BR-FranciscaNeural.');
  } catch (err) {
    console.error('[TTS] Erro ao iniciar Edge-TTS:', err.message);
  }
}
initTTS();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS headers para flexibilidade
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Favicon silencioso
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // =========================================================================
  // API: Transcrição com Groq Whisper (STT)
  // =========================================================================
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    try {
      const audioBuffer = await parseBody(req);
      if (!audioBuffer || audioBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Nenhum áudio recebido' }));
        return;
      }

      const fd = new FormData();
      fd.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'speech.wav');
      fd.append('model', GROQ_STT_MODEL);
      fd.append('language', 'pt');
      fd.append('response_format', 'json');

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: fd
      });

      const data = await groqRes.json();
      if (!groqRes.ok) {
        throw new Error(data.error?.message || 'Erro na transcrição Groq');
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text: data.text || '' }));
    } catch (err) {
      console.error('[API /api/transcribe]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // =========================================================================
  // API: Cérebro Conversacional com Groq LLM
  // =========================================================================
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const rawBody = await parseBody(req);
      const { message, history } = JSON.parse(rawBody.toString('utf8') || '{}');

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Mensagem vazia' }));
        return;
      }

      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(Array.isArray(history) ? history.slice(-6) : []),
        { role: 'user', content: message }
      ];

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 300
        })
      });

      const data = await groqRes.json();
      if (!groqRes.ok) {
        throw new Error(data.error?.message || 'Erro na resposta do modelo');
      }

      const reply = data.choices?.[0]?.message?.content?.trim() || 'Desculpe, não consegui formular uma resposta.';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      console.error('[API /api/chat]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // =========================================================================
  // API: Síntese de Voz com Microsoft Edge-TTS
  // =========================================================================
  if (pathname === '/api/tts' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let text = '';
      if (req.method === 'POST') {
        const rawBody = await parseBody(req);
        const parsed = JSON.parse(rawBody.toString('utf8') || '{}');
        text = parsed.text || '';
      } else {
        text = urlObj.searchParams.get('text') || '';
      }

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Texto não informado' }));
        return;
      }

      if (!ttsReady) {
        await initTTS();
      }

      const streamResult = tts.toStream(text);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
      });

      streamResult.audioStream.pipe(res);
      streamResult.audioStream.on('error', (err) => {
        console.error('[TTS Stream Error]', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    } catch (err) {
      console.error('[API /api/tts]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // =========================================================================
  // Arquivos Estáticos (index.html, etc.)
  // =========================================================================
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, reqPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Não encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n===========================================`);
  console.log(` EVA Server Online: http://localhost:${PORT}`);
  console.log(` Cérebro LLM: ${GROQ_MODEL}`);
  console.log(` Transcrição STT: ${GROQ_STT_MODEL}`);
  console.log(` Voz TTS: pt-BR-FranciscaNeural (Microsoft)`);
  console.log(`===========================================\n`);
});
