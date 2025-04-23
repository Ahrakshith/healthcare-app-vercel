const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY, 'base64').toString())
  : require('../../../service-account.json');
const storage = new Storage({ credentials: serviceAccountKeyPath });
const speechClient = new speech.SpeechClient({ credentials: serviceAccountKeyPath });

const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.includes('audio/webm')) {
      return cb(new Error('Invalid file type. Only audio/webm is allowed.'));
    }
    cb(null, true);
  },
});

const localStorageDir = path.join(process.cwd(), 'temp_audio');
if (!fs.existsSync(localStorageDir)) {
  fs.mkdirSync(localStorageDir, { recursive: true });
}

const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "audio"
  const subEndpoint = pathSegments[2]; // "upload-audio" or "upload-audio-fallback"

  const multerMiddleware = uploadAudio.single('audio');
  return multerMiddleware(req, res, async (err) => {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }

    try {
      const language = req.body.language || 'en-US';
      const uid = req.body.uid;

      if (!uid) return res.status(400).json({ error: 'User ID (uid) is required' });
      if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

      const audioFile = req.file;
      if (audioFile.size === 0) return res.status(400).json({ error: 'Audio file is empty' });

      await admin.auth().getUser(uid);

      if (subEndpoint === 'upload-audio') {
        const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
        const file = bucket.file(fileName);
        await uploadWithRetry(file, audioFile.buffer, { contentType: audioFile.mimetype });
        const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

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
          translatedText = transcriptionText;
        } catch (transcriptionError) {
          console.error('Transcription error:', transcriptionError.message);
        }

        return res.status(200).json({
          transcription: transcriptionText,
          translatedText,
          languageCode: language,
          audioUrl,
        });
      } else if (subEndpoint === 'upload-audio-fallback') {
        const fileName = `${uid}-${Date.now()}-recording.webm`;
        const localPath = path.join(localStorageDir, fileName);
        fs.writeFileSync(localPath, audioFile.buffer);
        const audioUrl = `/temp_files/audio/${fileName}`;

        return res.status(200).json({
          transcription: '[Fallback transcription unavailable]',
          languageCode: language,
          detectedLanguage: language,
          audioUrl,
        });
      }

      return res.status(404).json({ error: 'Endpoint not found' });
    } catch (error) {
      console.error(`Error in /api/audio/${subEndpoint}:`, error.message);
      if (error.message.includes('Invalid file type')) {
        return res.status(400).json({ error: error.message });
      }
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
      }
      res.status(500).json({ error: 'Failed to upload audio', details: error.message });
    }
  });
}