//api/speech/index.js
import { Storage } from '@google-cloud/storage';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { Translate } from '@google-cloud/translate';
import admin from 'firebase-admin';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

// Initialize Google Cloud Clients
const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY, 'base64').toString())
  : JSON.parse(await import('fs').then(fs => fs.promises.readFile('./service-account.json', 'utf8')));

const storage = new Storage({ credentials: serviceAccountKeyPath });
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

let ttsClient, translateClient;
try {
  ttsClient = new TextToSpeechClient({ credentials: serviceAccountKeyPath });
  console.log('Google Text-to-Speech client initialized successfully');
  translateClient = new Translate({ credentials: serviceAccountKeyPath });
  console.log('Google Translate client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Cloud services:', error.message);
  ttsClient = null;
  translateClient = null;
}

// Utility function for GCS upload with retry logic
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      console.log(`Upload successful on attempt ${attempt} for ${file.name}`);
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      console.log(`Retrying upload for ${file.name} in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Middleware to check Google services availability
const checkGoogleServices = (req, res, next) => {
  if (!ttsClient || !translateClient) {
    return res.status(503).json({
      error: 'Service unavailable: Google Cloud services not properly initialized',
      details: 'Check your API keys and service account configuration',
    });
  }
  next();
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "speech"
  const subEndpoint = pathSegments[2]; // "text-to-speech" or "translate"

  try {
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    await admin.auth().getUser(userId);

    if (endpoint !== 'speech') {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    // Apply Google services check for both sub-endpoints
    checkGoogleServices(req, res, () => {});

    if (subEndpoint === 'text-to-speech') {
      // Handle /api/speech/text-to-speech (POST)
      const { text, language = 'en-US' } = req.body;
      if (!text) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const [response] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: language, ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      });

      const fileName = `tts/${Date.now()}.mp3`;
      const file = bucket.file(fileName);
      await uploadWithRetry(file, response.audioContent, { contentType: 'audio/mp3' });
      const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

      return res.status(200).json({ audioUrl });
    } else if (subEndpoint === 'translate') {
      // Handle /api/speech/translate (POST)
      const { text, sourceLanguageCode, targetLanguageCode } = req.body;
      if (!text) return res.status(400).json({ error: 'Text is required' });
      if (!sourceLanguageCode) return res.status(400).json({ error: 'Source language code is required' });
      if (!targetLanguageCode) return res.status(400).json({ error: 'Target language code is required' });

      if (sourceLanguageCode === targetLanguageCode) {
        return res.status(200).json({ translatedText: text });
      }

      const [translatedText] = await translateClient.translate(text, {
        from: sourceLanguageCode,
        to: targetLanguageCode,
      });

      return res.status(200).json({ translatedText });
    }

    return res.status(404).json({ error: 'Sub-endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/speech/${subEndpoint || 'unknown'}:`, error.message);
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}