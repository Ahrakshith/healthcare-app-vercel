// src/services/speech.js
async function transcribeAudio(audioBlob, languageCode = 'en-US', userId) {
  if (!audioBlob || !(audioBlob instanceof Blob)) {
    throw new Error('Invalid audio blob provided: Must be a valid Blob object.');
  }
  if (!languageCode || typeof languageCode !== 'string') {
    throw new Error('Invalid language code provided: Must be a non-empty string.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId provided: Must be a non-empty string.');
  }

  console.log(`transcribeAudio: Starting transcription with languageCode=${languageCode}, uid=${userId}`);

  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('language', languageCode);
  formData.append('uid', userId);

  try {
    console.log('transcribeAudio: Sending request to /upload-audio with uid:', userId);
    const response = await fetch('http://localhost:5005/upload-audio', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Server error: ${response.status} - ${response.statusText}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage += ` - ${errorJson.error || errorText}`;
      } catch (e) {
        errorMessage += ` - ${errorText}`;
      }
      console.error(`transcribeAudio: Server responded with status ${response.status}: ${errorMessage}`);
      if (response.status === 503 && errorMessage.includes('Failed to upload audio to GCS')) {
        throw new Error('Failed to upload audio to GCS. Saved locally as fallback.');
      }
      if (response.status === 500 && errorMessage.includes('Google Cloud API key is missing')) {
        console.warn('API key missing, attempting fallback transcription');
        return await fallbackTranscription(audioBlob, languageCode);
      }
      if (response.status === 400 && errorMessage.includes('User ID is required')) {
        throw new Error('User ID is required for transcription.');
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log('transcribeAudio: Server response:', data); // Log full response for debugging
    const { transcription, languageCode: returnedLanguageCode, detectedLanguage, audioUrl, translatedText } = data;

    if (!transcription || !audioUrl) {
      console.warn('transcribeAudio: Incomplete response data:', data);
      return {
        transcription: transcription || '[Transcription unavailable]',
        languageCode: returnedLanguageCode || languageCode,
        detectedLanguage: detectedLanguage || languageCode.split('-')[0],
        audioUrl: audioUrl || null,
        translatedText: translatedText || transcription || '[Transcription unavailable]',
      };
    }

    console.log(`transcribeAudio: Transcription successful - transcription="${transcription}", audioUrl="${audioUrl}", translatedText="${translatedText || 'N/A'}"`);
    return {
      transcription,
      languageCode: returnedLanguageCode || languageCode,
      detectedLanguage: detectedLanguage || languageCode.split('-')[0],
      audioUrl,
      translatedText: translatedText || transcription,
    };
  } catch (error) {
    console.error(`transcribeAudio: Error occurred - ${error.message}`);
    throw error;
  }
}

async function fallbackTranscription(audioBlob, languageCode) {
  if (!audioBlob || !(audioBlob instanceof Blob)) {
    throw new Error('Invalid audio blob provided for fallback: Must be a valid Blob object.');
  }

  console.log('transcribeAudio: Falling back to /upload-audio-fallback');
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('language', languageCode);

  try {
    const response = await fetch('http://localhost:5005/upload-audio-fallback', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`transcribeAudio: Fallback server responded with status ${response.status}: ${errorText}`);
      throw new Error(`Fallback server error: ${response.status} - ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    console.log('transcribeAudio: Fallback server response:', data); // Log full response
    const { audioUrl, transcription, translatedText, languageCode: returnedLanguageCode } = data;

    if (!transcription || !audioUrl) {
      console.warn('transcribeAudio: Incomplete fallback response data:', data);
      return {
        transcription: transcription || '[Fallback transcription unavailable]',
        languageCode: returnedLanguageCode || languageCode,
        detectedLanguage: languageCode.split('-')[0],
        audioUrl: audioUrl || null,
        translatedText: translatedText || transcription || '[Fallback transcription unavailable]',
      };
    }

    console.log(`transcribeAudio: Fallback transcription result - transcription="${transcription}", audioUrl="${audioUrl}", translatedText="${translatedText || 'N/A'}"`);
    return {
      transcription,
      languageCode: returnedLanguageCode || languageCode,
      detectedLanguage: languageCode.split('-')[0],
      audioUrl,
      translatedText: translatedText || transcription,
    };
  } catch (error) {
    console.error(`transcribeAudio: Fallback failed - ${error.message}`);
    throw error;
  }
}

async function detectLanguage(text) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text provided for language detection: Must be a non-empty string.');
  }

  console.log(`detectLanguage: Detecting language for text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

  try {
    const response = await fetch('http://localhost:5005/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLanguageCode: 'auto' }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`detectLanguage: Server responded with status ${response.status}: ${errorText}`);
      throw new Error(`Server error: ${response.status} - ${response.statusText} - ${errorText}`);
    }
    const { detectedSourceLanguage } = await response.json();
    const detectedLang = detectedSourceLanguage || 'en';
    console.log(`detectLanguage: Detected language="${detectedLang}"`);
    return detectedLang;
  } catch (error) {
    console.error(`detectLanguage: Error occurred - ${error.message}`);
    throw error;
  }
}

async function translateText(text, sourceLanguageCode, targetLanguageCode) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text provided for translation: Must be a non-empty string.');
  }
  if (!sourceLanguageCode || typeof sourceLanguageCode !== 'string') {
    throw new Error('Invalid source language code provided: Must be a non-empty string.');
  }
  if (!targetLanguageCode || typeof targetLanguageCode !== 'string') {
    throw new Error('Invalid target language code provided: Must be a non-empty string.');
  }

  console.log(`translateText: Translating text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" from ${sourceLanguageCode} to ${targetLanguageCode}`);

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
      console.log('translateText: Source and target languages are the same, returning original text.');
      return text;
    }

    const payload = {
      text,
      sourceLanguageCode: normalizedSource,
      targetLanguageCode: normalizedTarget,
    };
    console.log('translateText: Sending payload:', JSON.stringify(payload));

    const response = await fetch('http://localhost:5005/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
    });

    const responseText = await response.text();
    console.log(`translateText: Server responded with status ${response.status}: ${responseText}`);

    if (!response.ok) {
      let errorMessage = `Server error: ${response.status} - ${response.statusText}`;
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage += ` - ${errorJson.error || responseText}`;
        console.error(`translateText: Error details: ${JSON.stringify(errorJson)}`);
      } catch (e) {
        errorMessage += ` - ${responseText}`;
      }
      throw new Error(errorMessage);
    }

    const { translatedText } = JSON.parse(responseText);
    console.log(`translateText: Translated text="${translatedText.substring(0, 50)}${translatedText.length > 50 ? '...' : ''}"`);
    return translatedText;
  } catch (error) {
    console.error(`translateText: Error occurred - ${error.message}`);
    throw error;
  }
}

async function textToSpeechConvert(text, languageCode = 'en-US') {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Invalid text provided for text-to-speech conversion: Must be a non-empty string.');
  }
  if (!languageCode || typeof languageCode !== 'string') {
    throw new Error('Invalid language code provided for text-to-speech conversion: Must be a non-empty string.');
  }

  console.log(`textToSpeechConvert: Converting text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" to speech with languageCode=${languageCode}`);

  try {
    const normalizedLanguageCode = languageCode.toLowerCase().startsWith('kn') ? 'kn-IN' : 'en-US';
    const response = await fetch('http://localhost:5005/text-to-speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: normalizedLanguageCode }),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`textToSpeechConvert: Server responded with status ${response.status}: ${errorText}`);
      if (response.status === 503 && errorText.includes('Failed to upload audio to GCS')) {
        throw new Error('Failed to upload text-to-speech audio to GCS. Saved locally as fallback.');
      }
      throw new Error(`Server error: ${response.status} - ${response.statusText} - ${errorText}`);
    }
    const { audioUrl } = await response.json();
    if (!audioUrl) {
      throw new Error('Text-to-speech response missing audioUrl.');
    }
    console.log(`textToSpeechConvert: Audio URL received="${audioUrl}"`);
    return audioUrl;
  } catch (error) {
    console.error(`textToSpeechConvert: Error occurred - ${error.message}`);
    throw error;
  }
}

export { transcribeAudio, detectLanguage, translateText, textToSpeechConvert };