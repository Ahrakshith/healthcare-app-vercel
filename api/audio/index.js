import { Storage } from '@google-cloud/storage';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import pkg from '@google-cloud/translate';
import admin from 'firebase-admin';
import multer from 'multer';

// Destructure Translate from the default export
const { Translate } = pkg;

// Log the start of the file execution
console.log('Loading /api/audio/index.js');

// Initialize Firebase Admin
if (!admin.apps.length) {
  console.log('Attempting to initialize Firebase Admin...');
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error.message, error.stack);
    throw new Error('Firebase Admin initialization failed');
  }
} else {
  console.log('Firebase Admin already initialized');
}

// Initialize Google Cloud Clients
let serviceAccountKey;
console.log('Attempting to initialize Google Cloud service account key...');
try {
  if (!process.env.GCS_SERVICE_ACCOUNT_KEY) {
    throw new Error('GCS_SERVICE_ACCOUNT_KEY environment variable is not set');
  }
  console.log('Using GCS_SERVICE_ACCOUNT_KEY from environment variable');
  serviceAccountKey = JSON.parse(Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString());
  console.log('Google Cloud service account key loaded successfully');
} catch (error) {
  console.error('Failed to load Google Cloud service account key:', error.message, error.stack);
  throw new Error('Google Cloud service account key loading failed');
}

const storage = new Storage({ credentials: serviceAccountKey });
const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
console.log(`Using GCS bucket: ${bucketName}`);
const bucket = storage.bucket(bucketName);

let speechClient, ttsClient, translateClient;
console.log('Attempting to initialize Google Cloud clients...');
try {
  speechClient = new SpeechClient({ credentials: serviceAccountKey });
  console.log('Google Speech-to-Text client initialized successfully');
  ttsClient = new TextToSpeechClient({ credentials: serviceAccountKey });
  console.log('Google Text-to-Speech client initialized successfully');
  translateClient = new Translate({ credentials: serviceAccountKey });
  console.log('Google Translate client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Cloud clients:', error.message, error.stack);
  speechClient = ttsClient = translateClient = null;
}

// Multer configuration for audio uploads
console.log('Configuring Multer for audio uploads...');
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    console.log('Multer fileFilter: Checking file type:', file ? file.mimetype : 'No file');
    if (!file.mimetype.includes('audio/webm')) {
      console.error('Invalid file type:', file.mimetype);
      return cb(new Error('Invalid file type. Only audio/webm is allowed.'));
    }
    console.log('Multer fileFilter: File type valid');
    cb(null, true);
  },
});

// Utility function for GCS upload with retry logic
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  console.log(`Starting uploadWithRetry for file: ${file.name}`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Upload attempt ${attempt} for ${file.name}`);
      await file.save(buffer, { metadata });
      console.log(`Upload successful on attempt ${attempt} for ${file.name}`);
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message, error.stack);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      console.log(`Retrying upload for ${file.name} in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Middleware to check Google services availability
const checkGoogleServices = (req, res, next) => {
  console.log('Checking Google services availability...');
  if (!speechClient || !ttsClient || !translateClient) {
    console.error('One or more Google services unavailable');
    return res.status(503).json({
      error: { code: 503, message: 'Service unavailable: Google Cloud services not properly initialized' },
      details: 'Check your API keys and service account configuration',
    });
  }
  console.log('Google services available');
  next();
};

// Multer middleware wrapper for Vercel
const runMulter = (req, res, multerMiddleware) => {
  console.log('Running Multer middleware...');
  return new Promise((resolve, reject) => {
    multerMiddleware(req, res, (err) => {
      if (err) {
        console.error('Multer error:', err.message, err.stack);
        return reject(err);
      }
      console.log('Multer middleware executed successfully');
      resolve();
    });
  });
};

export default async function handler(req, res) {
  console.log('Handler invoked for request:', req.method, req.url);

  // Set CORS headers
  console.log('Setting CORS headers...');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');
  console.log('CORS headers set');

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS preflight request');
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    console.error('Method not allowed:', req.method);
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed. Use POST.' } });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  console.log('Path segments:', pathSegments);
  const endpoint = pathSegments[1]; // "audio"
  const subEndpoint = pathSegments[2]; // "text-to-speech", "translate", or undefined

  try {
    console.log('Checking x-user-uid header...');
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      console.error('Missing x-user-uid header');
      return res.status(401).json({ error: { code: 401, message: 'Firebase UID is required in x-user-uid header' } });
    }

    await admin.auth().getUser(userId);
    console.log(`User verified: ${userId}`);

    if (endpoint !== 'audio') {
      console.error(`Endpoint not found: /${endpoint}/${subEndpoint || ''}`);
      return res.status(404).json({ error: { code: 404, message: `Endpoint not found: /${endpoint}/${subEndpoint || ''}` } });
    }

    // Apply Google services check
    checkGoogleServices(req, res, () => {});

    if (!subEndpoint) { // Handle /api/audio for speech-to-text
      console.log('Endpoint matched: /api/audio');
      await runMulter(req, res, uploadAudio.single('audio'));

      const language = req.body.language || 'en-US';
      const uid = req.body.uid;

      if (!uid) return res.status(400).json({ error: { code: 400, message: 'User ID (uid) is required in body' } });
      if (uid !== userId) return res.status(403).json({ error: { code: 403, message: 'Mismatched user ID in header and body' } });
      if (!req.file) return res.status(400).json({ error: { code: 400, message: 'No audio file uploaded' } });
      if (req.file.size === 0) return res.status(400).json({ error: { code: 400, message: 'Audio file is empty' } });

      const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
      const file = bucket.file(fileName);
      await uploadWithRetry(file, req.file.buffer, { contentType: req.file.mimetype });
      const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
      console.log(`Audio uploaded to GCS: ${audioUrl}`);

      let transcriptionText = 'Transcription unavailable';
      let detectedLanguage = language.split('-')[0];
      if (speechClient) {
        const config = { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: language, enableAutomaticLanguageDetection: true };
        const request = { audio: { content: req.file.buffer.toString('base64') }, config };
        const [response] = await speechClient.recognize(request);
        transcriptionText = response.results?.length > 0 ? response.results.map((result) => result.alternatives[0].transcript).join('\n') : 'No transcription available';
        detectedLanguage = response.results?.[0]?.languageCode || language.split('-')[0];
      }

      let translatedText = transcriptionText;
      if (translateClient && detectedLanguage !== 'en') {
        const [translation] = await translateClient.translate(transcriptionText, { from: detectedLanguage, to: 'en' });
        translatedText = translation;
      }

      return res.status(200).json({
        transcription: transcriptionText,
        translatedText: translatedText,
        languageCode: language,
        detectedLanguage: detectedLanguage,
        audioUrl,
        warning: !speechClient ? 'Speech-to-text service unavailable' : undefined,
      });
    } else if (subEndpoint === 'text-to-speech') {
      const { text, language = 'en-US' } = req.body;
      if (!text) return res.status(400).json({ error: { code: 400, message: 'Text is required' } });

      const normalizedLanguageCode = language.toLowerCase().startsWith('kn') ? 'kn-IN' : 'en-US';
      const [response] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: normalizedLanguageCode, ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      });
      const fileName = `tts/${Date.now()}.mp3`;
      const file = bucket.file(fileName);
      await uploadWithRetry(file, response.audioContent, { contentType: 'audio/mp3' });
      const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

      return res.status(200).json({ audioUrl });
    } else if (subEndpoint === 'translate') {
      const { text, sourceLanguageCode, targetLanguageCode } = req.body;
      if (!text) return res.status(400).json({ error: { code: 400, message: 'Text is required' } });
      if (!sourceLanguageCode) return res.status(400).json({ error: { code: 400, message: 'Source language code is required' } });
      if (!targetLanguageCode) return res.status(400).json({ error: { code: 400, message: 'Target language code is required' } });

      if (sourceLanguageCode === targetLanguageCode) return res.status(200).json({ translatedText: text });

      const [translatedText] = await translateClient.translate(text, { from: sourceLanguageCode, to: targetLanguageCode });
      return res.status(200).json({ translatedText });
    }

    return res.status(404).json({ error: { code: 404, message: 'Sub-endpoint not found' } });
  } catch (error) {
    console.error(`Error in /api/audio/${subEndpoint || 'unknown'}:`, error.message, error.stack);
    if (error.message.includes('Invalid file type')) return res.status(400).json({ error: { code: 400, message: error.message } });
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { code: 400, message: 'File too large. Maximum size is 5MB.' } });
    return res.status(500).json({ error: { code: 500, message: 'Failed to process request', details: error.message } });
  }
}

export const config = {
  api: {
    bodyParser: false, // Required for multer
  },
};
console.log('Serverless function /api/audio/index.js fully loaded');