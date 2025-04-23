const textToSpeech = require('@google-cloud/text-to-speech');
const translate = require('@google-cloud/translate').v2;
const admin = require('firebase-admin');

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
const ttsClient = new textToSpeech.TextToSpeechClient({ credentials: serviceAccountKeyPath });
const translateClient = new translate.Translate({ credentials: serviceAccountKeyPath });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "speech"

  try {
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    await admin.auth().getUser(userId);

    if (endpoint === 'speech') {
      const subEndpoint = pathSegments[2]; // "text-to-speech" or "translate"

      if (subEndpoint === 'text-to-speech') {
        // Handle /api/speech/text-to-speech (POST)
        const { text, languageCode } = req.body;
        if (!text || !languageCode) {
          return res.status(400).json({ error: 'Text and languageCode are required' });
        }

        const request = {
          input: { text },
          voice: { languageCode, ssmlGender: 'NEUTRAL' },
          audioConfig: { audioEncoding: 'MP3' },
        };

        const [response] = await ttsClient.synthesizeSpeech(request);
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.status(200).send(response.audioContent);
      } else if (subEndpoint === 'translate') {
        // Handle /api/speech/translate (POST)
        const { text, targetLanguage } = req.body;
        if (!text || !targetLanguage) {
          return res.status(400).json({ error: 'Text and targetLanguage are required' });
        }

        const [translation] = await translateClient.translate(text, targetLanguage);
        return res.status(200).json({ translatedText: translation });
      }
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/speech:`, error.message);
    res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}