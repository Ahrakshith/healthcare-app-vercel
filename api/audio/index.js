import { Storage } from '@google-cloud/storage';
import { SpeechClient } from '@google-cloud/speech';
import admin from 'firebase-admin';
import multer from 'multer';

// Initialize Firebase Admin
if (!admin.apps.length) {
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
    console.error('Failed to initialize Firebase Admin:', error.message);
    throw new Error('Firebase Admin initialization failed');
  }
}

// Initialize Google Cloud Clients
let serviceAccountKey;
try {
  if (process.env.GCS_SERVICE_ACCOUNT_KEY) {
    serviceAccountKey = JSON.parse(Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString());
  } else {
    const fs = await import('fs').then((module) => module.promises);
    serviceAccountKey = JSON.parse(await fs.readFile('./service-account.json', 'utf8'));
  }
  console.log('Google Cloud service account key loaded successfully');
} catch (error) {
  console.error('Failed to load Google Cloud service account key:', error.message);
  throw new Error('Google Cloud service account key loading failed');
}

const storage = new Storage({ credentials: serviceAccountKey });
const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

let speechClient;
try {
  speechClient = new SpeechClient({ credentials: serviceAccountKey });
  console.log('Google Speech-to-Text client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Speech-to-Text client:', error.message);
  speechClient = null;
}

// Multer configuration for audio uploads
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.includes('audio/webm')) {
      console.error('Invalid file type:', file.mimetype);
      return cb(new Error('Invalid file type. Only audio/webm is allowed.'));
    }
    cb(null, true);
  },
});

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
  if (!speechClient) {
    console.error('Speech-to-Text service unavailable');
    return res.status(503).json({
      error: { code: 503, message: 'Service unavailable: Google Speech-to-Text service not properly initialized' },
      details: 'Check your API keys and service account configuration',
    });
  }
  next();
};

// Multer middleware wrapper for Vercel
const runMulter = (req, res, multerMiddleware) => {
  return new Promise((resolve, reject) => {
    multerMiddleware(req, res, (err) => {
      if (err) {
        console.error('Multer error:', err.message);
        return reject(err);
      }
      resolve();
    });
  });
};

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS preflight request');
    res.status(200).end();
    return;
  }

  console.log(`Received request: ${req.method} ${req.url}`);

  if (req.method !== 'POST') {
    console.error('Method not allowed:', req.method);
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed. Use POST.' } });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  console.log('Path segments:', pathSegments);
  const endpoint = pathSegments[1]; // "audio"
  const subEndpoint = pathSegments[2]; // "upload-audio"

  try {
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      console.error('Missing x-user-uid header');
      return res.status(401).json({ error: { code: 401, message: 'Firebase UID is required in x-user-uid header' } });
    }

    // Verify user exists in Firebase Auth
    await admin.auth().getUser(userId);
    console.log(`User verified: ${userId}`);

    if (endpoint !== 'audio' || subEndpoint !== 'upload-audio') {
      console.error(`Endpoint not found: /${endpoint}/${subEndpoint}`);
      return res.status(404).json({ error: { code: 404, message: `Endpoint not found: /${endpoint}/${subEndpoint}` } });
    }

    // Apply multer middleware to parse the audio file
    await runMulter(req, res, uploadAudio.single('audio'));

    // Extract language and uid from the request body
    const language = req.body.language || 'en-US';
    const uid = req.body.uid;

    // Validate request data
    if (!uid) {
      console.error('Missing uid in request body');
      return res.status(400).json({ error: { code: 400, message: 'User ID (uid) is required in body' } });
    }
    if (uid !== userId) {
      console.error(`Mismatched UID: header=${userId}, body=${uid}`);
      return res.status(403).json({ error: { code: 403, message: 'Mismatched user ID in header and body' } });
    }
    if (!req.file) {
      console.error('No audio file uploaded');
      return res.status(400).json({ error: { code: 400, message: 'No audio file uploaded' } });
    }
    if (req.file.size === 0) {
      console.error('Uploaded audio file is empty');
      return res.status(400).json({ error: { code: 400, message: 'Audio file is empty' } });
    }

    // Apply Google services check
    checkGoogleServices(req, res, () => {});

    // Upload audio to GCS
    const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
    const file = bucket.file(fileName);
    await uploadWithRetry(file, req.file.buffer, { contentType: req.file.mimetype });
    const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log(`Audio uploaded to GCS: ${audioUrl}`);

    // Perform transcription
    let transcriptionText = 'Transcription unavailable';
    let translatedText = transcriptionText;

    try {
      const config = {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: language,
        enableAutomaticLanguageDetection: false,
      };

      const request = {
        audio: { content: req.file.buffer.toString('base64') },
        config,
      };

      const [response] = await speechClient.recognize(request);
      transcriptionText = response.results?.length > 0
        ? response.results.map((result) => result.alternatives[0].transcript).join('\n')
        : 'No transcription available';
      translatedText = transcriptionText; // Translation handled elsewhere
      console.log(`Transcription successful for ${fileName}: "${transcriptionText}"`);
    } catch (transcriptionError) {
      console.error('Transcription error:', transcriptionError.message);
    }

    return res.status(200).json({
      transcription: transcriptionText,
      translatedText,
      languageCode: language,
      audioUrl,
      warning: !speechClient ? 'Speech-to-text service unavailable' : undefined,
    });
  } catch (error) {
    console.error(`Error in /api/audio/upload-audio:`, error.message, error.stack);
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({ error: { code: 400, message: error.message } });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: { code: 400, message: 'File too large. Maximum size is 5MB.' } });
    }
    return res.status(500).json({ error: { code: 500, message: 'Failed to upload audio', details: error.message } });
  }
}