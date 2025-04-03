const express = require('express');
const { create } = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const chromium = require('chromium');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Configurações
const QR_EXPIRATION_TIME = 120000; // 2 minutos
let qrCodeTimestamp = null;
let client = null;
let qrCode = null;
let isInitializing = false;
const lastMessageTimestamps = {};

// Mensagem automática
const AUTO_REPLY_MESSAGE = `
🍔 *Lukao Lanches* agradece seu contato!  

É um prazer te atender! 😊  

Faça seu pedido de forma rápida e prática pelo nosso cardápio digital:  
🔗 [https://lukaolanches.netlify.app]

✔️ Escolha seus lanches favoritos  
✔️ Finalize seu pedido em poucos cliques  
✔️ Entregamos rápido e com muito sabor!  

Peça já o seu e aproveite! 🚀  

Se tiver qualquer dúvida, é só chamar! Estamos aqui para ajudar.  

*Equipe Lukao Lanches* ❤️  
`;

// Verificar se pode enviar mensagem
const canSendMessage = (contact) => {
  const now = Date.now();
  const lastSent = lastMessageTimestamps[contact];
  return !lastSent || (now - lastSent) > 1800000; // 30 minutos
};

// Limpar sessão anterior
const cleanSession = () => {
  try {
    const tempDir = '/tmp/whatsapp-session';
    const tokenDir = path.join(__dirname, 'tokens');
    
    [tempDir, tokenDir].forEach(dir => {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`Diretório limpo: ${dir}`);
      }
    });
  } catch (error) {
    console.error('Erro ao limpar sessão:', error);
  }
};

// Inicializar WhatsApp
const initializeWhatsApp = async () => {
  if (isInitializing) return;
  isInitializing = true;
  cleanSession(); // Limpar sessões anteriores

  try {
    console.log('Iniciando conexão com WhatsApp...');
    
    const puppeteerOptions = {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions',
        '--disable-features=site-per-process',
        '--disable-notifications'
      ],
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || chromium.path,
      ignoreHTTPSErrors: true,
      userDataDir: '/tmp/whatsapp-session',
      timeout: 60000
    };

    client = await create({
      session: 'whatsapp-session',
      puppeteerOptions,
      disableWelcome: true,
      updatesLog: true,
      autoClose: 0,
      tokenStore: 'file',
      folderNameToken: './tokens',
      catchQR: (base64Qr) => {
        qrCode = base64Qr;
        qrCodeTimestamp = Date.now();
        console.log('Novo QR Code gerado');
      },
      statusFind: (status) => {
        console.log('Status:', status);
      },
      browserWS: ''
    });

    console.log('Cliente WhatsApp inicializado');

    // Eventos
    client.onStateChange((state) => {
      console.log('Estado alterado:', state);
      if (state === 'CONNECTED') {
        qrCode = null;
        qrCodeTimestamp = null;
      }
    });

    client.onMessage(async (msg) => {
      try {
        if (!msg.isGroupMsg && !msg.fromMe) {
          console.log('Mensagem de:', msg.from, 'Texto:', msg.body);
          
          const contact = msg.from.split('@')[0];
          if (canSendMessage(contact)) {
            await client.sendText(msg.from, AUTO_REPLY_MESSAGE);
            lastMessageTimestamps[contact] = Date.now();
            console.log('Resposta enviada para', contact);
          }
        }
      } catch (error) {
        console.error('Erro ao responder:', error);
      }
    });

    client.on('ready', () => {
      console.log('=== CLIENTE PRONTO ===');
      isInitializing = false;
    });

    client.on('disconnected', (reason) => {
      console.log('!!! DESCONECTADO:', reason);
      isInitializing = false;
      setTimeout(initializeWhatsApp, 10000);
    });

  } catch (error) {
    console.error('!!! ERRO NA INICIALIZAÇÃO:', error);
    isInitializing = false;
    setTimeout(initializeWhatsApp, 30000);
  }
};

// Endpoints
app.get('/qr', (req, res) => {
  if (!qrCode) return res.status(404).json({ error: 'QR Code não gerado' });
  if (Date.now() - qrCodeTimestamp > QR_EXPIRATION_TIME) {
    return res.status(410).json({ error: 'QR Code expirado' });
  }
  res.json({ qr: qrCode, status: 'waiting_qr', expiresIn: Math.max(0, QR_EXPIRATION_TIME - (Date.now() - qrCodeTimestamp)) });
});

app.get('/status', (req, res) => {
  res.json({ 
    status: client?.isConnected() ? 'connected' : 'disconnected',
    isAuthenticated: client?.isConnected() || false
  });
});

app.post('/clean-session', (req, res) => {
  try {
    cleanSession();
    if (client) client.close();
    client = null;
    qrCode = null;
    initializeWhatsApp();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  initializeWhatsApp();
});

process.on('SIGINT', async () => {
  if (client) await client.close();
  process.exit();
});