// functions/index.js
const functions = require('firebase-functions');
const { v2: { Translate } } = require('@google-cloud/translate');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { Storage } = require('@google-cloud/storage');

// Initialize Google Cloud clients
const translateClient = new Translate();
const textToSpeechClient = new TextToSpeechClient();
const storage = new Storage();
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

exports.translateToEnglish = functions.https.onCall(async (data, context) => {
  console.log('translateToEnglish: Received raw data:', data);
  const { text, language } = data;

  if (!text || !language) {
    throw new functions.https.HttpsError('invalid-argument', 'Text and language are required.');
  }

  if (language === 'en') {
    console.log('translateToEnglish: Language is English, no translation needed');
    return { translatedText: text };
  }

  if (language !== 'kn') {
    console.log('translateToEnglish: Only Kannada (kn) to English translation is supported');
    return { translatedText: text };
  }

  try {
    const [translation] = await translateClient.translate(text, {
      from: 'kn',
      to: 'en',
    });
    console.log('translateToEnglish: Translated from Kannada to English:', translation);
    return { translatedText: translation };
  } catch (error) {
    console.error('translateToEnglish: Error:', error);
    throw new functions.https.HttpsError('internal', 'Translation failed: ' + error.message);
  }
});

exports.textToSpeech = functions.https.onCall(async (data, context) => {
  console.log('textToSpeech: Received raw data:', data);

  // Extract the inner data object from the callable wrapper
  const { text, languageCode } = data.data || {};

  if (!text || !languageCode) {
    console.error('textToSpeech: Missing text or languageCode:', { text, languageCode });
    throw new functions.https.HttpsError('invalid-argument', 'Text and languageCode are required.');
  }

  try {
    const request = {
      input: { text },
      voice: {
        languageCode: languageCode === 'kn' ? 'kn-IN' : 'en-US',
        name: languageCode === 'kn' ? 'kn-IN-Standard-A' : 'en-US-Standard-C',
      },
      audioConfig: {
        audioEncoding: 'MP3',
      },
    };

    console.log('textToSpeech: Sending request to TTS:', request);

    const [response] = await textToSpeechClient.synthesizeSpeech(request);
    const audioContent = response.audioContent;

    const fileName = `tts/${Date.now()}-tts.mp3`;
    const file = bucket.file(fileName);

    await file.save(audioContent, {
      metadata: { contentType: 'audio/mp3' },
    });

    const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log('textToSpeech: Audio URL generated:', audioUrl);
    return { audioUrl };
  } catch (error) {
    console.error('textToSpeech: Error:', error);
    throw new functions.https.HttpsError('internal', 'Text-to-Speech failed: ' + error.message);
  }
});