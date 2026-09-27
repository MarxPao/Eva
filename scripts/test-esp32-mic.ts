// Teste ao vivo da telemetria de áudio do ESP32-S3 via WebSocket
const ip = process.argv[2] || '192.168.100.87';
const wsUrl = `ws://${ip}/`;

console.log(`\n======================================================`);
console.log(`🔍 Conectando ao ESP32-S3 em ${wsUrl}...`);
console.log(`======================================================\n`);

let messageCount = 0;
const rmsValues: number[] = [];
const levelValues: number[] = [];

const ws = new WebSocket(wsUrl);

const timeout = setTimeout(() => {
  console.log('\n⏱️ Tempo limite de teste atingido (8 segundos).');
  finish();
}, 8000);

ws.onopen = () => {
  console.log('✅ WebSocket conectado com sucesso ao ESP32!');
  console.log('🎙️ Coletando pacotes do microfone I2S em tempo real...\n');
};

ws.onmessage = (event) => {
  messageCount++;
  const raw = event.data.toString();
  
  let level = 0;
  let rms = 0;

  try {
    if (raw.startsWith('{')) {
      const data = JSON.parse(raw);
      level = data.level;
      rms = data.rms;
    } else {
      level = parseFloat(raw);
      rms = level * 35;
    }

    rmsValues.push(rms);
    levelValues.push(level);

    if (messageCount % 5 === 0) {
      const barLength = Math.min(30, Math.floor(rms / 10));
      const bar = '█'.repeat(barLength) + '░'.repeat(30 - barLength);
      console.log(`[PACOTE #${messageCount}] RMS: ${rms.toFixed(1).padStart(6)} | Nível: ${String(level).padStart(3)}% | ${bar}`);
    }
  } catch (err) {
    console.log(`[RAW]: ${raw}`);
  }
};

ws.onerror = (err) => {
  console.error('❌ Erro no WebSocket:', err);
};

ws.onclose = () => {
  console.log('🔌 Conexão WebSocket encerrada.');
  finish();
};

function finish() {
  clearTimeout(timeout);
  ws.close();

  console.log(`\n======================================================`);
  console.log(`📊 RELATÓRIO DO MICROFONE ESP32-S3`);
  console.log(`======================================================`);
  console.log(`Total de pacotes recebidos: ${messageCount}`);

  if (rmsValues.length > 0) {
    const minRMS = Math.min(...rmsValues);
    const maxRMS = Math.max(...rmsValues);
    const avgRMS = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;

    console.log(`RMS Mínimo: ${minRMS.toFixed(1)}`);
    console.log(`RMS Máximo: ${maxRMS.toFixed(1)}`);
    console.log(`RMS Médio:  ${avgRMS.toFixed(1)}`);

    console.log('\n--- DIAGNÓSTICO DO HARDWARE ---');
    if (avgRMS < 1.0 && maxRMS < 2.0) {
      console.log('⚠️ SINAL ZERADO (SILÊNCIO TOTAL):');
      console.log('   O RMS está quase 0.0. Isso normalmente indica:');
      console.log('   - O microfone não está recebendo alimentação (verifique VDD 3.3V e GND);');
      console.log('   - Pino SD (GPIO 13) desconectado ou flutuando;');
      console.log('   - Pinos SCK (GPIO 2) ou WS (GPIO 1) sem clock;');
      console.log('   - Pino L/R precisa estar conectado em GND.');
    } else if (avgRMS > 5000) {
      console.log('⚠️ RUÍDO / SATURAÇÃO EXCESSIVA:');
      console.log('   O sinal está saturando no topo.');
    } else {
      console.log('🎉 SINAL ATIVO E CAPTANDO:');
      console.log(`   O microfone está lendo variações acústicas normais!`);
      console.log(`   Pico observado: ${maxRMS.toFixed(1)}`);
      if (maxRMS - minRMS > 15) {
        console.log('   ✅ Detectada variação dinâmica de áudio (sons / fala / ruído ambiente).');
      } else {
        console.log('   ℹ️ Sinal estável (nível de ruído de fundo ambiente). Faça barulho ou fale perto.');
      }
    }
  } else {
    console.log('❌ Nenhum dado foi recebido durante o teste.');
  }
  console.log(`======================================================\n`);
  process.exit(0);
}
