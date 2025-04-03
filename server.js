const express = require('express');
const { create } = require('@wppconnect-team/wppconnect');
const cors = require('cors');
const chromium = require('chromium'); // Adicionado

const app = express();
app.use(cors());
app.use(express.json());

// QR Code expiration settings
const QR_EXPIRATION_TIME = 120000; // 2 minutes in milliseconds
let qrCodeTimestamp = null;

let client = null;
let qrCode = null;
let isInitializing = false;

// Object to store last message timestamps
const lastMessageTimestamps = {};

// Auto-reply message template
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

// Check if can send message
const canSendMessage = (contact) => {
  const now = Date.now();
  const lastSent = lastMessageTimestamps[contact];
  
  if (!lastSent || (now - lastSent) > 1800000) {
    lastMessageTimestamps[contact] = now;
    return true;
  }
  
  return false;
};

// Initialize WhatsApp client
const initializeWhatsApp = async () => {
  if (isInitializing) return;
  isInitializing = true;

  try {
    console.log('Iniciando conexão com WhatsApp...');
    
    client = await create({
      session: 'whatsapp-session',
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--single-process'
        ],
        headless: 'new',
        executablePath: chromium.path, // Alterado para usar o chromium do Render
        ignoreHTTPSErrors: true
      },
      disableWelcome: true,
      autoClose: QR_EXPIRATION_TIME, // 2 minutes timeout
      catchQR: (base64Qr) => {
        // Only update if no QR or previous one expired
        if (!qrCode || (Date.now() - qrCodeTimestamp > QR_EXPIRATION_TIME)) {
          qrCode = base64Qr;
          qrCodeTimestamp = Date.now();
          console.log('Novo QR Code gerado (válido por 2 minutos)');
        }
      },
      statusFind: (statusSession, session) => {
        console.log('Status Session: ', statusSession);
        console.log('Session name: ', session);
      },
      browserWS: ''
    });

    console.log('Cliente WhatsApp criado com sucesso');

    // Client events
    client.onStateChange((state) => {
      console.log('State changed: ', state);
      if (state === 'CONNECTED') {
        qrCode = null;
        qrCodeTimestamp = null;
      }
    });

    client.onStreamChange((state) => {
      console.log('Stream state changed: ', state);
    });

    client.onMessage(async (message) => {
      try {
        if (!message.isGroupMsg && !message.fromMe) {
          console.log('\n--- Nova mensagem recebida ---');
          console.log('De:', message.from);
          console.log('Texto:', message.body);
          
          if (canSendMessage(message.from)) {
            await client.sendText(message.from, AUTO_REPLY_MESSAGE);
            console.log('Resposta automática enviada com sucesso');
          } else {
            console.log('Mensagem automática não enviada - intervalo mínimo não atingido');
          }
        }
      } catch (error) {
        console.error('Erro ao responder mensagem:', error);
      }
    });

    client.on('ready', () => {
      console.log('=== CLIENTE PRONTO ===');
      isInitializing = false;
      qrCode = null;
      qrCodeTimestamp = null;
    });

    client.on('authenticated', () => {
      console.log('=== AUTENTICADO ===');
      isInitializing = false;
    });

    client.on('auth_failure', (msg) => {
      console.error('!!! FALHA NA AUTENTICAÇÃO:', msg);
      isInitializing = false;
    });

    client.on('disconnected', (reason) => {
      console.log('!!! DESCONECTADO:', reason);
      isInitializing = false;
      qrCode = null;
      qrCodeTimestamp = null;
      setTimeout(initializeWhatsApp, 10000);
    });

    client.on('change_state', (state) => {
      console.log('Status da conexão alterado:', state);
    });

  } catch (error) {
    console.error('!!! ERRO NA INICIALIZAÇÃO:', error.message);
    isInitializing = false;
    qrCode = null;
    qrCodeTimestamp = null;
    setTimeout(initializeWhatsApp, 30000);
  }
};

// Start connection
initializeWhatsApp();

// QR Code endpoint
app.get('/qr', (req, res) => {
  if (!qrCode) {
    return res.status(404).json({ error: 'QR Code not generated yet' });
  }
  
  // Check if QR Code is still valid
  if (Date.now() - qrCodeTimestamp > QR_EXPIRATION_TIME) {
    return res.status(410).json({ error: 'QR Code expired' });
  }
  
  res.json({ 
    qr: qrCode,
    status: 'waiting_qr',
    expiresIn: Math.max(0, QR_EXPIRATION_TIME - (Date.now() - qrCodeTimestamp))
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  if (!client) {
    return res.json({ 
      status: 'disconnected',
      qr: null
    });
  }
  
  try {
    const status = client.isConnected() ? 'connected' : 'disconnected';
    res.json({ 
      status,
      isAuthenticated: client.isConnected()
    });
  } catch (error) {
    console.error('Error checking status:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Error checking status'
    });
  }
});

// Send message endpoint
app.post('/send-message', async (req, res) => {
  if (!client || !client.isConnected()) {
    return res.status(500).json({ error: 'WhatsApp client not initialized or disconnected' });
  }

  const { number, message } = req.body;
  try {
    await client.sendText(`${number}@c.us`, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect endpoint
app.post('/disconnect', async (req, res) => {
  try {
    if (client) {
      await client.close();
      client = null;
      qrCode = null;
      qrCodeTimestamp = null;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001; // Alterado para usar a porta do ambiente
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Proper shutdown
process.on('SIGINT', async () => {
  console.log('\nEncerrando servidor...');
  if (client) {
    await client.close();
  }
  process.exit();
});