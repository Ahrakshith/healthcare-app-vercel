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

        // Retry on 503 (Service Unavailable) or 429 (Too Many Requests)
        if ((response.status === 503 || response.status === 429) && attempt < maxRetries) {
          const delay = backoff * Math.pow(2, attempt - 1);
          !isProduction && console.log(`fetchWithRetry: Retrying in ${delay}ms due to ${response.status}...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        // Include 404 in the error message for better debugging
        throw new Error(`${errorMessage} (Status: ${response.status})`);
      }
      return response;
    } catch (error) {
      if (attempt === maxRetries) {
        !isProduction && console.error(`fetchWithRetry: All ${maxRetries} attempts failed for ${url}: ${error.message}`);
        throw error;
      }
      const delay = backoff * Math.pow(2, attempt - 1);
      !isProduction && console.log(`fetchWithRetry: Network error, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Normalize language codes to a consistent format (en-US or kn-IN)
const normalizeLanguageCode = (code) => {
  const lowerCode = code.toLowerCase();
  switch (lowerCode) {
    case 'kn':
    case 'kn-in':
      return 'kn-IN';
    case 'en':
    case 'en-us':
    case 'en-gb':
      return 'en-US';
    default:
      return 'en-US'; // Default to English if invalid
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

  const normalizedLanguageCode = normalizeLanguageCode(languageCode);
  !isProduction && console.log(`transcribeAudio: Starting with languageCode=${normalizedLanguageCode}, uid=${userId}`);

  const formData = new FormData();
  formData.append('audio', audioBlob, `recording-${Date.now()}.webm`);
  formData.append('language', normalizedLanguageCode);
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

    const { transcription, detectedLanguage, audioUrl, translatedText, warning } = data;

    if (!transcription || !audioUrl) {
      !isProduction && console.warn('transcribeAudio: Incomplete response:', data);
      return {
        transcription: transcription || '[Transcription unavailable]',
        languageCode: normalizedLanguageCode,
        detectedLanguage: detectedLanguage || normalizedLanguageCode.split('-')[0],
        audioUrl: audioUrl || null,
        translatedText: translatedText || transcription || '[Translation unavailable]',
        warning: warning || 'Incomplete response from server',
      };
    }

    // Translate to English if source is Kannada, or keep original if English
    const finalTranslatedText =
      normalizedLanguageCode === 'kn-IN' && translatedText
        ? translatedText
        : transcription;

    !isProduction &&
      console.log(
        `transcribeAudio: Success - transcription="${truncate(
          transcription
        )}", audioUrl="${audioUrl}", translatedText="${truncate(finalTranslatedText || 'N/A')}"`
      );
    return {
      transcription,
      languageCode: normalizedLanguageCode,
      detectedLanguage: detectedLanguage || normalizedLanguageCode.split('-')[0],
      audioUrl,
      translatedText: finalTranslatedText,
      warning,
    };
  } catch (error) {
    !isProduction && console.error(`transcribeAudio: Error - ${error.message}`);
    throw new Error(`Transcription failed: ${error.message}`);
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
    const detectedLang = normalizeLanguageCode(data.detectedSourceLanguage || 'en');
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

  const normalizedSource = normalizeLanguageCode(sourceLanguageCode);
  const normalizedTarget = normalizeLanguageCode(targetLanguageCode);

  !isProduction &&
    console.log(
      `translateText: Translating text="${truncate(text)}" from ${normalizedSource} to ${normalizedTarget}`
    );

  try {
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
    return translatedText || text; // Fallback to original text if translation fails
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

  const normalizedLanguageCode = normalizeLanguageCode(languageCode);
  !isProduction &&
    console.log(
      `textToSpeechConvert: Converting text="${truncate(text)}" with languageCode=${normalizedLanguageCode}, uid=${userId}`
    );

  try {
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
    !isProduction && console.log(`textToSpeechConvert: Success - Audio URL="${audioUrl}"`);
    return audioUrl;
  } catch (error) {
    !isProduction && console.error(`textToSpeechConvert: Error - ${error.message}`);
    // Provide more specific error messages for common issues
    if (error.message.includes('404')) {
      throw new Error('Text-to-speech endpoint not found (404). Please check if the server is deployed correctly.');
    } else if (error.message.includes('503')) {
      throw new Error('Text-to-speech service unavailable (503). Please try again later.');
    }
    throw new Error(`Text-to-speech conversion failed: ${error.message}`);
  }
}

export { transcribeAudio, detectLanguage, translateText, textToSpeechConvert };