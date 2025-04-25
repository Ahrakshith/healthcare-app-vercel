const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
const isProduction = process.env.NODE_ENV === 'production';

// Utility to truncate long strings for logging
const truncate = (str, maxLength = 50) => {
  if (typeof str !== 'string') return '[Non-string value]';
  return str.length > maxLength ? `${str.substring(0, maxLength)}...` : str;
};

// Utility function for fetch with retry logic
const fetchWithRetry = async (url, options, maxRetries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      !isProduction && console.log(`fetchWithRetry: Attempt ${attempt} for ${url}`);
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Request failed: ${response.status} - ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorText;
        } catch {
          errorMessage = errorText || 'Unknown server error';
        }
        !isProduction && console.error(`fetchWithRetry: Error on attempt ${attempt} - ${errorMessage}`);

        if (response.status === 503 && attempt < maxRetries) {
          const delay = backoff * Math.pow(2, attempt - 1);
          !isProduction && console.log(`fetchWithRetry: Retrying in ${delay}ms due to 503...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(errorMessage);
      }
      return response;
    } catch (error) {
      if (attempt === maxRetries) throw error;
    }
  }
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
  formData.append('uid', userId);

  try {
    !isProduction && console.log('transcribeAudio: Sending to /api/audio');
    const response = await fetchWithRetry(`${API_BASE_URL}/audio`, {
      method: 'POST',
      headers: { 'x-user-uid': userId },
      body: formData,
      credentials: 'include',
    });

    const data = await response.json();
    !isProduction && console.log('transcribeAudio: Response:', data);

    const { transcription, languageCode: returnedLanguageCode, detectedLanguage, audioUrl, translatedText, warning } = data;

    if (!transcription || !audioUrl) {
      !isProduction && console.warn('transcribeAudio: Incomplete response:', data);
      return {
        transcription: transcription || '[Transcription unavailable]',
        languageCode: returnedLanguageCode || languageCode,
        detectedLanguage: detectedLanguage || languageCode.split('-')[0],
        audioUrl: audioUrl || null,
        translatedText: translatedText || transcription || '[Transcription unavailable]',
        warning: warning || 'Incomplete response from server',
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
      warning,
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
    const response = await fetchWithRetry(`${API_BASE_URL}/audio/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
      },
      body: JSON.stringify({ text, sourceLanguageCode: 'auto', targetLanguageCode: 'en' }),
      credentials: 'include',
    });

    const data = await response.json();
    const detectedLang = data.detectedSourceLanguage || 'en'; // Adjust based on API response structure
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

    const response = await fetchWithRetry(`${API_BASE_URL}/audio/translate`, {
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
    const response = await fetchWithRetry(`${API_BASE_URL}/audio/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-uid': userId,
      },
      body: JSON.stringify({ text, language: normalizedLanguageCode }),
      credentials: 'include',
    });

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