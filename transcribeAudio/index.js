const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1;
const { v4: uuidv4 } = require('uuid');

// Initialize Google Cloud Storage and Speech-to-Text clients
const storage = new Storage();
const speechClient = new speech.SpeechClient();
const bucketName = 'healthcare-app-audio-files';

functions.http('transcribeAudio', async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!req.body.audio || !req.body.language) {
      return res.status(400).json({ error: 'Missing audio file or language' });
    }

    const audioBuffer = Buffer.from(req.body.audio, 'base64');
    const language = req.body.language;

    const fileName = `audio/${uuidv4()}_patient_audio.webm`;
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);

    await file.save(audioBuffer, {
      metadata: {
        contentType: 'audio/webm',
      },
    });
    console.log(`Audio uploaded to GCS: ${fileName}`);

    const gcsUri = `gs://${bucketName}/${fileName}`;
    console.log(`GCS URI: ${gcsUri}`);

    const languageCode = language === 'kn' ? 'kn-IN' : 'en-US';
    const audio = { uri: gcsUri };
    const config = {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: languageCode,
    };
    const request = { audio, config };

    const [response] = await speechClient.recognize(request);
    let transcription = 'No transcription available';
    if (response.results && response.results.length > 0) {
      transcription = response.results[0].alternatives[0].transcript;
    }
    console.log(`Transcription: ${transcription}`);

    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000,
    });
    console.log(`Signed URL for playback: ${signedUrl}`);

    res.status(200).json({ transcription, languageCode, audioUrl: signedUrl });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});