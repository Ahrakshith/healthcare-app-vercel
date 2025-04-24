//api/audio/index.js
import { Storage } from '@google-cloud/storage';
import { SpeechClient } from '@google-cloud/speech';
import admin from 'firebase-admin';
import multer from 'multer';

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
const bucketName = 'fir-project-vercelgcloud storage buckets get-iam-policy gs://fir-project-vercel';
const bucket = storage.bucket(bucketName);

let speechClient;
try {
  speechClient = new SpeechClient({ credentials: serviceAccountKeyPath });
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
    return res.status(503).json({
      error: 'Service unavailable: Google Speech-to-Text service not properly initialized',
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
  const endpoint = pathSegments[1]; // "audio"
  const subEndpoint = pathSegments[2]; // Should be "upload-audio"

  try {
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    await admin.auth().getUser(userId);

    if (endpoint !== 'audio' || subEndpoint !== 'upload-audio') {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    // Apply multer middleware
    await runMulter(req, res, uploadAudio.single('audio'));

    const language = req.body.language || 'en-US';
    const uid = req.body.uid;

    if (!uid) return res.status(400).json({ error: 'User ID (uid) is required' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const audioFile = req.file;
    if (audioFile.size === 0) return res.status(400).json({ error: 'Audio file is empty' });

    // Apply Google services check
    checkGoogleServices(req, res, () => {});

    // Upload audio to GCS
    const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
    const file = bucket.file(fileName);
    await uploadWithRetry(file, audioFile.buffer, { contentType: audioFile.mimetype });
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
        audio: { content: audioFile.buffer.toString('base64') },
        config,
      };

      const [response] = await speechClient.recognize(request);
      transcriptionText = response.results?.length > 0
        ? response.results.map((result) => result.alternatives[0].transcript).join('\n')
        : 'No transcription available';
      translatedText = transcriptionText; // Translation handled elsewhere
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
    console.error(`Error in /api/audio/upload-audio:`, error.message);
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
    return res.status(500).json({ error: 'Failed to upload audio', details: error.message });
  }
}