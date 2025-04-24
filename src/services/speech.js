const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
const isProduction = process.env.NODE_ENV === 'production';

// Utility to truncate long strings for logging
const truncate = (str, maxLength = 50) => {
  if (typeof str !== 'string') return '[Non-string value]';
  return str.length > maxLength ? `${str.substring(0, maxLength)}...` : str;
};

async function transcribeAudio(audioBlob, languageCode = 'en-US', userId) {
  if (!audioBlob || !(audioBlob instanceof Blob)) {
    throw new Error('Invalid audio blob: Must be a valid Blob object.');
  }
  if (!languageCode || typeof languageCode !== 'string') {
    throw new Error('Invalid language code: Must be a non-empty string.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId: Must be a non-empty string.');
  }

  !isProduction && console.log(`transcribeAudio: Starting with languageCode=${languageCode}, uid=${userId}`);

  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('language', languageCode);

  try {
    !isProduction && console.log('transcribeAudio: Sending to /api/audio/upload-audio');
    const response = await fetch(`${API_BASE_URL}/api/audio/upload-audio`, {
      method: 'POST',
      headers: { 'x-user-uid': userId },
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Transcription failed: ${response.status} - ${response.statusText}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorText;
      } catch {
        errorMessage = errorText || 'Unknown server error';
      }
      !isProduction && console.error(`transcribeAudio: Error - ${errorMessage}`);

      if (response.status === 503 && errorMessage.includes('Failed to upload audio to GCS')) {
        throw new Error('Failed to upload audio to Google Cloud Storage. Please try again.');
      }
      if (response.status === 500 && errorMessage.includes('Google Cloud API key is missing')) {
        throw new Error('Google Cloud API key is missing. Contact support.');
      }
      if (response.status === 400 && errorMessage.includes('User ID is required')) {
        throw new Error('User ID is required for transcription.');
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    !isProduction && console.log('transcribeAudio: Response:', data);

    const { transcription, languageCode: returnedLanguageCode, detectedLanguage, audioUrl, translatedText } = data;

    if (!transcription || !audioUrl) {
      !isProduction && console.warn('transcribeAudio: Incomplete response:', data);
      return {
        transcription: transcription || '[Transcription unavailable]',
        languageCode: returnedLanguageCode || languageCode,
        detectedLanguage: detectedLanguage || languageCode.split('-')[0],
        audioUrl: audioUrl || null,
        translatedText: translatedText || transcription || '[Transcription unavailable]',
      };
    }

    !isProduction &&
      console.log(
        `transcribeAudio: Success - transcription="${truncate(
          transcription
        )}", audioUrl="${audioUrl}", translatedText="${truncate(translatedText || 'N/A')}"`
      );
    return {
      transcription,
      languageCode: returnedLanguageCode || languageCode,
      detectedLanguage: detectedLanguage || languageCode.split('-')[0],
      audioUrl,
      translatedText: translatedText || transcription,
    };
  } catch (error) {
    !isProduction && console.error(`transcribeAudio: Error - ${error.message}`);
    throw error;
  }
}

async function detectLanguage(text, userId) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text: Must be a non-empty string.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId: Must be a non-empty string.');
  }

  !isProduction && console.log(`detectLanguage: Detecting for text="${truncate(text)}"`);

  try {
    const response = await fetch(`${API_BASE_URL}/api/speech/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
      },
      body: JSON.stringify({ text, sourceLanguageCode: 'auto', targetLanguageCode: 'en' }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = errorText || 'Unknown server error';
      !isProduction && console.error(`detectLanguage: Error - ${response.status}: ${errorMessage}`);
      throw new Error(`Language detection failed: ${errorMessage}`);
    }

    const { detectedSourceLanguage } = await response.json();
    const detectedLang = detectedSourceLanguage || 'en';
    !isProduction && console.log(`detectLanguage: Detected language="${detectedLang}"`);
    return detectedLang;
  } catch (error) {
    !isProduction && console.error(`detectLanguage: Error - ${error.message}`);
    throw error;
  }
}

async function translateText(text, sourceLanguageCode, targetLanguageCode, userId) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text: Must be a non-empty string.');
  }
  if (!sourceLanguageCode || typeof sourceLanguageCode !== 'string') {
    throw new Error('Invalid source language code: Must be a non-empty string.');
  }
  if (!targetLanguageCode || typeof targetLanguageCode !== 'string') {
    throw new Error('Invalid target language code: Must be a non-empty string.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId: Must be a non-empty string.');
  }

  !isProduction &&
    console.log(`translateText: Translating text="${truncate(text)}" from ${sourceLanguageCode} to ${targetLanguageCode}`);

  try {
    const normalizeLanguageCode = (code) => {
      const lowerCode = code.toLowerCase();
      switch (lowerCode) {
        case 'kn':
        case 'kn-in':
          return 'kn';
        case 'en':
        case 'en-us':
        case 'en-gb':
          return 'en';
        default:
          return lowerCode;
      }
    };

    const normalizedSource = normalizeLanguageCode(sourceLanguageCode);
    const normalizedTarget = normalizeLanguageCode(targetLanguageCode);

    if (normalizedSource === normalizedTarget) {
      !isProduction && console.log('translateText: Same source and target language, returning original text.');
      return text;
    }

    const response = await fetch(`${API_BASE_URL}/api/speech/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
      },
      body: JSON.stringify({
        text,
        sourceLanguageCode: normalizedSource,
        targetLanguageCode: normalizedTarget,
      }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = errorText || 'Unknown server error';
      !isProduction && console.error(`translateText: Error - ${response.status}: ${errorMessage}`);
      throw new Error(`Translation failed: ${errorMessage}`);
    }

    const { translatedText } = await response.json();
    !isProduction && console.log(`translateText: Translated text="${truncate(translatedText)}"`);
    return translatedText;
  } catch (error) {
    !isProduction && console.error(`translateText: Error - ${error.message}`);
    throw error;
  }
}

async function textToSpeechConvert(text, languageCode = 'en-US', userId) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text: Must be a non-empty string.');
  }
  if (!languageCode || typeof languageCode !== 'string') {
    throw new Error('Invalid language code: Must be a non-empty string.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId: Must be a non-empty string.');
  }

  !isProduction &&
    console.log(`textToSpeechConvert: Converting text="${truncate(text)}" with languageCode=${languageCode}`);

  try {
    const normalizedLanguageCode = languageCode.toLowerCase().startsWith('kn') ? 'kn-IN' : 'en-US';
    const response = await fetch(`${API_BASE_URL}/api/speech/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
      },
      body: JSON.stringify({ text, language: normalizedLanguageCode }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = errorText || 'Unknown server error';
      !isProduction && console.error(`textToSpeechConvert: Error - ${response.status}: ${errorMessage}`);
      if (response.status === 503 && errorMessage.includes('Failed to upload audio to GCS')) {
        throw new Error('Failed to upload text-to-speech audio to Google Cloud Storage. Please try again.');
      }
      throw new Error(`Text-to-speech failed: ${errorMessage}`);
    }

    const { audioUrl } = await response.json();
    if (!audioUrl) {
      throw new Error('Text-to-speech response missing audioUrl.');
    }
    !isProduction && console.log(`textToSpeechConvert: Audio URL="${audioUrl}"`);
    return audioUrl;
  } catch (error) {
    !isProduction && console.error(`textToSpeechConvert: Error - ${error.message}`);
    throw error;
  }
}

export { transcribeAudio, detectLanguage, translateText, textToSpeechConvert };