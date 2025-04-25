import { Storage } from '@google-cloud/storage';
import { SpeechClient } from '@google-cloud/speech';
import { v2 } from '@google-cloud/translate';
import admin from 'firebase-admin';
import multer from 'multer';

console.log('Loading /api/audio/index.js');

// Initialize Firebase Admin
let adminInitialized = false;
if (!admin.apps.length) {
  console.log('Attempting to initialize Firebase Admin...');
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    console.log('Firebase credentials check:');
    console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID ? 'Present' : 'Missing');
    console.log('FIREBASE_PRIVATE_KEY:', privateKey ? 'Present' : 'Missing');
    console.log('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL ? 'Present' : 'Missing');
    if (!process.env.FIREBASE_PROJECT_ID || !privateKey || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, or FIREBASE_CLIENT_EMAIL');
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    adminInitialized = true;
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error.message, error.stack);
    throw new Error('Firebase Admin initialization failed');
  }
} else {
  adminInitialized = true;
  console.log('Firebase Admin already initialized');
}

const db = admin.firestore();

// Initialize Google Cloud Storage
let storage, bucket;
const initStorage = async () => {
  console.log('Attempting to initialize Google Cloud Storage...');
  try {
    console.log('Checking GCS_SERVICE_ACCOUNT_KEY...');
    if (!process.env.GCS_SERVICE_ACCOUNT_KEY) {
      throw new Error('GCS_SERVICE_ACCOUNT_KEY environment variable is not set');
    }
    console.log('Using GCS_SERVICE_ACCOUNT_KEY from environment variable');
    let decodedKey;
    try {
      decodedKey = Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString();
      console.log('Successfully decoded GCS_SERVICE_ACCOUNT_KEY');
    } catch (error) {
      console.error('Failed to decode GCS_SERVICE_ACCOUNT_KEY as base64:', error.message, error.stack);
      throw new Error('Invalid GCS_SERVICE_ACCOUNT_KEY format: not a valid base64 string');
    }

    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(decodedKey);
      console.log('Google Cloud service account key parsed successfully');
    } catch (error) {
      console.error('Failed to parse decoded GCS_SERVICE_ACCOUNT_KEY as JSON:', error.message, error.stack);
      throw new Error('Invalid GCS_SERVICE_ACCOUNT_KEY format: not a valid JSON string');
    }

    storage = new Storage({ credentials: serviceAccountKey });
    const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
    console.log(`Using GCS bucket: ${bucketName}`);
    bucket = storage.bucket(bucketName);
    try {
      const [metadata] = await bucket.getMetadata();
      console.log('Bucket metadata retrieved successfully:', metadata);
    } catch (error) {
      console.warn('Failed to retrieve bucket metadata:', error.message, error.stack);
      console.warn('Proceeding with file operations if possible (missing storage.buckets.get permission)');
    }
    console.log('Google Cloud Storage initialized successfully');
    return true;
  } catch (error) {
    console.error('Failed to initialize Google Cloud Storage:', error.message, error.stack);
    return false;
  }
};

// Lazy initialization of Google Cloud clients
let speechClient = null, translateClient = null;
const initSpeechClient = async () => {
  console.log('Attempting to initialize Speech-to-Text client...');
  if (!speechClient) {
    try {
      speechClient = new SpeechClient({ credentials: await getServiceAccountKey() });
      console.log('Google Speech-to-Text client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Speech-to-Text client:', error.message, error.stack);
      speechClient = null;
    }
  } else {
    console.log('Speech-to-Text client already initialized');
  }
  return !!speechClient;
};

const initTranslateClient = async () => {
  console.log('Attempting to initialize Translate client...');
  if (!translateClient) {
    try {
      translateClient = new v2.Translate({ credentials: await getServiceAccountKey() });
      console.log('Google Translate v2 client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Translate client:', error.message, error.stack);
      translateClient = null;
    }
  } else {
    console.log('Translate client already initialized');
  }
  return !!translateClient;
};

const getServiceAccountKey = async () => {
  console.log('Retrieving service account key...');
  if (!process.env.GCS_SERVICE_ACCOUNT_KEY) {
    console.error('GCS_SERVICE_ACCOUNT_KEY environment variable is not set');
    throw new Error('GCS_SERVICE_ACCOUNT_KEY environment variable is not set');
  }
  let decodedKey;
  try {
    decodedKey = Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString();
    console.log('Service account key decoded successfully');
  } catch (error) {
    console.error('Failed to decode GCS_SERVICE_ACCOUNT_KEY:', error.message, error.stack);
    throw new Error('Invalid GCS_SERVICE_ACCOUNT_KEY format: not a valid base64 string');
  }
  try {
    const parsedKey = JSON.parse(decodedKey);
    console.log('Service account key parsed successfully');
    return parsedKey;
  } catch (error) {
    console.error('Failed to parse GCS_SERVICE_ACCOUNT_KEY:', error.message, error.stack);
    throw new Error('Invalid GCS_SERVICE_ACCOUNT_KEY format: not a valid JSON string');
  }
};

// Multer configuration for audio uploads
console.log('Configuring Multer for audio uploads...');
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    console.log('Multer fileFilter: Checking file type:', file ? file.mimetype : 'No file');
    if (!file || !file.mimetype.includes('audio/webm')) {
      console.error('Invalid file type:', file?.mimetype);
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
      if (attempt === retries) {
        console.error('All upload attempts failed for:', file.name);
        throw error;
      }
      const delay = backoff * Math.pow(2, attempt - 1);
      console.log(`Retrying upload for ${file.name} in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Middleware to check Google services availability
const checkGoogleServices = async (req, res) => {
  console.log('Checking Google services availability...');
  if (!await initStorage()) {
    console.error('Google Cloud Storage unavailable');
    return res.status(503).json({
      error: { code: 503, message: 'Service unavailable: Google Cloud Storage not accessible' },
    });
  }
  console.log('Google services available');
  return true;
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
  console.log('Raw request URL:', req.url);
  console.log('Request headers:', req.headers);
  console.log('Request body (if any):', req.body);

  // Set CORS headers
  console.log('Setting CORS headers...');
  const frontendUrl = process.env.FRONTEND_URL || 'https://healthcare-app-vercel.vercel.app';
  console.log('Using FRONTEND_URL:', frontendUrl);
  res.setHeader('Access-Control-Allow-Origin', frontendUrl);
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

  // Parse the URL path
  const pathSegments = req.url.split('/').filter(Boolean);
  console.log('Parsed path segments:', pathSegments);
  const endpoint = pathSegments[1] || '';
  const subEndpoint = pathSegments[2] ? pathSegments[2].toLowerCase() : '';
  console.log('Determined endpoint:', endpoint);
  console.log('Determined sub-endpoint:', subEndpoint);

  try {
    console.log('Checking x-user-uid header...');
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      console.error('Missing x-user-uid header');
      return res.status(401).json({ error: { code: 401, message: 'Firebase UID is required in x-user-uid header' } });
    }
    console.log('x-user-uid header present:', userId);

    if (!adminInitialized) {
      console.error('Firebase Admin not initialized');
      throw new Error('Firebase Admin not initialized');
    }

    console.log('Verifying user with Firebase Auth...');
    await admin.auth().getUser(userId);
    console.log(`User verified successfully: ${userId}`);

    if (endpoint !== 'audio') {
      console.error(`Endpoint not found: /${endpoint}/${subEndpoint}`);
      return res.status(404).json({ error: { code: 404, message: `Endpoint not found: /${endpoint}/${subEndpoint}` } });
    }

    // Apply Google services check
    console.log('Checking Google services...');
    const servicesAvailable = await checkGoogleServices(req, res);
    if (!servicesAvailable) return;
    console.log('Google services check passed');

    // Handle /api/audio (speech-to-text)
    if (!subEndpoint) {
      console.log('Endpoint matched: /api/audio');
      console.log('Running Multer for audio upload...');
      await runMulter(req, res, uploadAudio.single('audio'));

      console.log('Parsing request body...');
      const language = req.body.language || 'en-US';
      const uid = req.body.uid;
      console.log('Request body - language:', language);
      console.log('Request body - uid:', uid);

      if (!uid) {
        console.error('User ID (uid) missing in body');
        return res.status(400).json({ error: { code: 400, message: 'User ID (uid) is required in body' } });
      }
      if (uid !== userId) {
        console.error('Mismatched user ID in header and body');
        return res.status(403).json({ error: { code: 403, message: 'Mismatched user ID in header and body' } });
      }
      if (!req.file) {
        console.error('No audio file uploaded');
        return res.status(400).json({ error: { code: 400, message: 'No audio file uploaded' } });
      }
      if (req.file.size === 0) {
        console.error('Audio file is empty');
        return res.status(400).json({ error: { code: 400, message: 'Audio file is empty' } });
      }
      console.log('Audio file received:', req.file.originalname, 'Size:', req.file.size);

      console.log('Uploading audio to GCS...');
      const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
      const file = bucket.file(fileName);
      await uploadWithRetry(file, req.file.buffer, { contentType: req.file.mimetype });
      const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
      const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
      console.log(`Audio uploaded to GCS: ${audioUrl}`);

      console.log('Initializing Speech-to-Text client...');
      let transcriptionText = 'Transcription unavailable';
      let detectedLanguage = language.split('-')[0];
      if (await initSpeechClient()) {
        console.log('Speech-to-Text client available, performing transcription...');
        const config = { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: language, enableAutomaticLanguageDetection: true };
        const request = { audio: { content: req.file.buffer.toString('base64') }, config };
        console.log('Sending transcription request:', JSON.stringify(config));
        const [response] = await speechClient.recognize(request);
        console.log('Transcription response:', JSON.stringify(response));
        transcriptionText = response.results?.length > 0 ? response.results.map((result) => result.alternatives[0].transcript).join('\n') : 'No transcription available';
        detectedLanguage = response.results?.[0]?.languageCode || language.split('-')[0];
        console.log('Transcription result:', transcriptionText);
        console.log('Detected language:', detectedLanguage);
      } else {
        console.warn('Speech-to-Text client unavailable, skipping transcription');
      }

      console.log('Initializing Translate client...');
      let translatedText = transcriptionText;
      if (await initTranslateClient() && detectedLanguage !== 'en') {
        console.log('Translate client available, translating to English...');
        const [translation] = await translateClient.translate(transcriptionText, { from: detectedLanguage, to: 'en' });
        translatedText = translation;
        console.log('Translated text:', translatedText);
      } else {
        console.warn('Translate client unavailable or same language, skipping translation');
      }

      console.log('Sending response for /api/audio...');
      return res.status(200).json({
        transcription: transcriptionText,
        translatedText: translatedText,
        languageCode: language,
        detectedLanguage: detectedLanguage,
        audioUrl,
        warning: !speechClient ? 'Speech-to-Text service unavailable' : undefined,
      });
    }

    // Handle /api/audio/translate
    if (subEndpoint === 'translate') {
      console.log('Endpoint matched: /api/audio/translate');
      console.log('Request body:', req.body);
      const { text, sourceLanguageCode, targetLanguageCode } = req.body;
      if (!text) {
        console.error('Missing text parameter in body');
        return res.status(400).json({ error: { code: 400, message: 'Text is required' } });
      }
      if (!sourceLanguageCode) {
        console.error('Missing sourceLanguageCode parameter in body');
        return res.status(400).json({ error: { code: 400, message: 'Source language code is required' } });
      }
      if (!targetLanguageCode) {
        console.error('Missing targetLanguageCode parameter in body');
        return res.status(400).json({ error: { code: 400, message: 'Target language code is required' } });
      }
      console.log('Translate request - text:', text);
      console.log('Translate request - sourceLanguageCode:', sourceLanguageCode);
      console.log('Translate request - targetLanguageCode:', targetLanguageCode);

      if (sourceLanguageCode === targetLanguageCode) {
        console.log('Source and target languages are the same, returning original text');
        return res.status(200).json({ translatedText: text });
      }

      console.log('Initializing Translate client...');
      if (await initTranslateClient()) {
        console.log(`Translating text from ${sourceLanguageCode} to ${targetLanguageCode}`);
        const [translation] = await translateClient.translate(text, { from: sourceLanguageCode, to: targetLanguageCode });
        console.log('Translation result:', translation);

        console.log('Sending response for /api/audio/translate...');
        return res.status(200).json({ translatedText: translation });
      } else {
        console.error('Translate service unavailable');
        return res.status(503).json({ error: { code: 503, message: 'Translate service unavailable' } });
      }
    }

    console.error(`Sub-endpoint not found: /${endpoint}/${subEndpoint}`);
    return res.status(404).json({ error: { code: 404, message: `Sub-endpoint not found: /${endpoint}/${subEndpoint}` } });
  } catch (error) {
    console.error(`Error in /api/audio/${subEndpoint || 'unknown'}:`, error.message, error.stack);
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({ error: { code: 400, message: error.message } });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { code: 400, message: 'File too large. Maximum size is 5MB.' } });
    }
    return res.status(500).json({ error: { code: 500, message: 'Failed to process request', details: error.message } });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

console.log('Serverless function /api/audio/index.js fully loaded');