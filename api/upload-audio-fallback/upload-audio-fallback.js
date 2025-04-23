const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
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

// Local storage directory
const localStorageDir = path.join(process.cwd(), 'temp_audio');
if (!fs.existsSync(localStorageDir)) {
  fs.mkdirSync(localStorageDir, { recursive: true });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const multerMiddleware = uploadAudio.single('audio');
  multerMiddleware(req, res, async (err) => {
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

      // Verify user
      await admin.auth().getUser(uid);

      const fileName = `${uid}-${Date.now()}-recording.webm`;
      const localPath = path.join(localStorageDir, fileName);
      fs.writeFileSync(localPath, audioFile.buffer);
      const audioUrl = `/temp_audio/${fileName}`;

      res.status(200).json({
        transcription: '[Fallback transcription unavailable]',
        languageCode: language,
        detectedLanguage: language.split('-')[0],
        audioUrl,
        translatedText: '[Fallback transcription unavailable]',
      });
    } catch (error) {
      console.error('Error in /api/upload-audio-fallback:', error.message);
      res.status(500).json({
        error: 'Fallback server error',
        details: error.message,
      });
    }
  });
}