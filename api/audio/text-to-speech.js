import { Storage } from '@google-cloud/storage';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import admin from 'firebase-admin';

console.log('Loading /api/audio/text-to-speech.js');

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
      throw new Error('Missing Firebase credentials');
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

// Initialize Google Cloud Storage
let storage, bucket;
const initStorage = async () => {
  console.log('Attempting to initialize Google Cloud Storage...');
  try {
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

// Initialize Text-to-Speech Client
let ttsClient = null;
const initTtsClient = async () => {
  console.log('Attempting to initialize Text-to-Speech client...');
  if (!ttsClient) {
    try {
      const decodedKey = Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString();
      const serviceAccountKey = JSON.parse(decodedKey);
      ttsClient = new TextToSpeechClient({ credentials: serviceAccountKey });
      console.log('Google Text-to-Speech client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Text-to-Speech client:', error.message, error.stack);
      ttsClient = null;
    }
  } else {
    console.log('Text-to-Speech client already initialized');
  }
  return !!ttsClient;
};

// Utility function for GCS upload with retry
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

    console.log('Checking Google services...');
    if (!await initStorage()) {
      console.error('Google Cloud Storage unavailable');
      return res.status(503).json({ error: { code: 503, message: 'Service unavailable: Google Cloud Storage not accessible' } });
    }
    console.log('Google services check passed');

    console.log('Parsing request body...');
    const { text, language = 'en-US' } = req.body;
    if (!text) {
      console.error('Missing text parameter in body');
      return res.status(400).json({ error: { code: 400, message: 'Text is required' } });
    }
    console.log('Text-to-speech request - text:', text);
    console.log('Text-to-speech request - language:', language);

    console.log('Initializing Text-to-Speech client...');
    if (await initTtsClient()) {
      const normalizedLanguageCode = language.toLowerCase().startsWith('kn') ? 'kn-IN' : 'en-US';
      console.log(`Synthesizing speech with text: "${text}" in language: ${normalizedLanguageCode}`);
      const [response] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: normalizedLanguageCode, ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      });
      console.log('Text-to-Speech synthesis successful, response length:', response.audioContent.length);

      console.log('Uploading synthesized audio to GCS...');
      const fileName = `tts/${userId}/${Date.now()}-speech.mp3`;
      const file = bucket.file(fileName);
      await uploadWithRetry(file, response.audioContent, { contentType: 'audio/mp3' });
      const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
      const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
      console.log(`Text-to-speech audio uploaded to GCS: ${audioUrl}`);

      console.log('Sending response for /api/audio/text-to-speech...');
      return res.status(200).json({ audioUrl });
    } else {
      console.error('Text-to-Speech client unavailable');
      return res.status(503).json({ error: { code: 503, message: 'Text-to-Speech service unavailable' } });
    }
  } catch (error) {
    console.error('Error in /api/audio/text-to-speech:', error.message, error.stack);
    return res.status(500).json({ error: { code: 500, message: 'Failed to process request', details: error.message } });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};

console.log('Serverless function /api/audio/text-to-speech.js fully loaded');