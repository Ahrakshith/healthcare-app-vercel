// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const { Translate } = require('@google-cloud/translate').v2;
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { setTimeout } = require('timers/promises');

// Enable Socket.IO debug logs
process.env.DEBUG = 'socket.io:* engine:*';

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with updated CORS
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000'],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Cache-Control', 'x-user-uid'],
    credentials: true,
  },
  transports: ['websocket'],
  pingTimeout: 20000,
  pingInterval: 25000,
});

// Log Socket.IO version
try {
  const socketIoVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'node_modules/socket.io/package.json'))).version;
  console.log(`Socket.IO version: ${socketIoVersion}`);
} catch (error) {
  console.error('Failed to log Socket.IO version:', error.message);
}

// Initialize Firebase
const firebaseServiceAccount = require('/Users/ah1/PycharmProjects/healthcare-app/server/healthcare-app-d8997-firebase-adminsdk-fbsvc-303655553e.json');
admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const db = admin.firestore();
const messaging = admin.messaging(); // For FCM push notifications

// Enhanced Google Cloud Clients Initialization with better error handling
let storage, speechClient, ttsClient, translateClient;
let gcsAvailable = false;

try {
  const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY || './service-account.json';
  storage = new Storage({ keyFilename: serviceAccountKeyPath });
  console.log('Google Cloud Storage initialized successfully');

  if (!process.env.REACT_APP_GOOGLE_TRANSLATE_API_KEY) {
    console.warn('Google Translate API key is missing. Translation features will be disabled.');
  } else {
    translateClient = new Translate({
      projectId: process.env.REACT_APP_GOOGLE_CLOUD_PROJECT_ID,
      key: process.env.REACT_APP_GOOGLE_TRANSLATE_API_KEY,
    });
    console.log('Google Translate client initialized successfully');
  }

  speechClient = new speech.SpeechClient({ keyFilename: serviceAccountKeyPath });
  console.log('Google Speech-to-Text client initialized successfully');

  ttsClient = new textToSpeech.TextToSpeechClient({ keyFilename: serviceAccountKeyPath });
  console.log('Google Text-to-Speech client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Google Cloud services:', error.message);
  process.exit(1); // Exit if initialization fails
}

// Multer configuration
const upload = multer({ storage: multer.memoryStorage() });

// Configure CORS for Express with updated headers
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Cache-Control', 'x-user-uid'],
  credentials: true,
}));
app.use(express.json());

const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

// Local fallback storage directory
const localStorageDir = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(localStorageDir)) {
  fs.mkdirSync(localStorageDir, { recursive: true });
  console.log(`Created local storage directory: ${localStorageDir}`);
}

// Test bucket access on startup
const testBucketAccess = async () => {
  try {
    const [exists] = await bucket.exists();
    if (!exists) {
      console.error(`Bucket ${bucketName} does not exist. Please create it in Google Cloud Console.`);
      return false;
    }
    await bucket.file('test.txt').save('Startup test', { metadata: { contentType: 'text/plain' } });
    console.log(`Bucket ${bucketName} is accessible and writable`);
    await bucket.file('test.txt').delete();
    return true;
  } catch (error) {
    console.error(`Failed to access or write to bucket ${bucketName}:`, error.message);
    return false;
  }
};

// Enhanced upload with retry and fallback
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      console.log(`Upload successful on attempt ${attempt} for ${file.name}`);
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      console.log(`Retrying upload for ${file.name} in ${delay}ms...`);
      await setTimeout(delay);
    }
  }
};

// Middleware to check Google services availability
const checkGoogleServices = (req, res, next) => {
  if (!translateClient || !speechClient || !ttsClient) {
    return res.status(503).json({
      error: 'Service unavailable: Google Cloud services not properly initialized',
      details: 'Check your API keys and service account configuration',
    });
  }
  next();
};

// Middleware to check user role and fetch doctorId/patientId if applicable
const checkRole = (requiredRole) => {
  return async (req, res, next) => {
    const userId = req.headers['x-user-uid'];
    console.log(`Checking UID=${userId} for required role=${requiredRole}`);

    if (!userId) {
      console.log('No UID provided in x-user-uid header');
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    try {
      const userDoc = await db.collection('users').doc(userId).get({ source: 'server' });
      if (!userDoc.exists) {
        console.log(`User ${userId} not found in Firestore`);
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = userDoc.data();
      if (userData.role !== requiredRole) {
        console.log(`Access denied for UID=${userId}. Required role=${requiredRole}, Found role=${userData.role}`);
        return res.status(403).json({ error: `Access denied. Required role: ${requiredRole}, User role: ${userData.role}` });
      }

      if (requiredRole === 'doctor') {
        const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
        if (doctorQuery.empty) {
          console.log(`No doctor profile found for UID=${userId}`);
          return res.status(404).json({ error: 'Doctor profile not found for this user' });
        }
        const doctorData = doctorQuery.docs[0].data();
        req.doctorId = doctorData.doctorId;
        console.log(`Doctor ID for UID=${userId} is ${req.doctorId}`);
        if (!req.doctorId) {
          console.log(`Doctor ID is missing in Firestore document for UID=${userId}:`, doctorData);
          return res.status(500).json({ error: 'Doctor profile is missing doctorId field' });
        }
      } else if (requiredRole === 'patient') {
        const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
        if (patientQuery.empty) {
          console.log(`No patient profile found for UID=${userId}`);
          return res.status(404).json({ error: 'Patient profile not found for this user' });
        }
        const patientData = patientQuery.docs[0].data();
        req.patientId = patientData.patientId;
        console.log(`Patient ID for UID=${userId} is ${req.patientId}`);
      }

      req.user = userData;
      next();
    } catch (error) {
      console.error(`Error checking role for user ${userId}:`, error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  };
};

// Health Check Endpoint with service status
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    services: {
      firebase: true,
      gcs: gcsAvailable,
      speech: !!speechClient,
      translation: !!translateClient,
      tts: !!ttsClient,
    },
    timestamp: new Date().toISOString(),
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('joinRoom', (room) => {
    socket.join(room);
    console.log(`User ${socket.id} joined room ${room}`);
  });

  socket.on('newMessage', (message) => {
    console.log(`New message from ${socket.id}:`, message);
    const room = `${message.patientId}-${message.doctorId}`;
    io.to(room).emit('newMessage', message);
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
  });

  socket.on('error', (error) => {
    console.error(`Socket.IO error for ${socket.id}:`, error.message);
  });

  socket.on('connect_error', (error) => {
    console.error(`Connection error for ${socket.id}:`, error.message);
  });
});

// Updated Endpoint: Assign Doctor to Patient (Overwrites existing assignments)
app.post('/assign-doctor', checkRole('patient'), async (req, res) => {
  console.log('POST /assign-doctor:', req.body);
  try {
    const { patientId, doctorId } = req.body;
    const userId = req.headers['x-user-uid'];

    if (!patientId || !doctorId) {
      return res.status(400).json({ error: 'patientId and doctorId are required' });
    }

    // Verify patient matches the authenticated user
    const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
    if (patientQuery.empty || patientQuery.docs[0].data().patientId !== patientId) {
      console.log(`Access denied: UID=${userId} does not match patientId=${patientId}`);
      return res.status(403).json({ error: 'You are not authorized to assign this patient' });
    }

    // Verify doctor exists
    const doctorQuery = await db.collection('doctors').where('doctorId', '==', doctorId).get();
    if (doctorQuery.empty) {
      console.log(`Doctor ${doctorId} not found`);
      return res.status(404).json({ error: 'Doctor not found' });
    }

    // Check for existing assignments and overwrite them
    const assignmentQuery = await db.collection('doctor_assignments')
      .where('patientId', '==', patientId)
      .get();

    const patientData = patientQuery.docs[0].data();
    const assignmentData = {
      patientId,
      doctorId,
      timestamp: new Date().toISOString(),
      patientName: patientData.name || `Patient ${patientId}`,
      age: patientData.age || null,
      sex: patientData.sex || null,
    };

    if (!assignmentQuery.empty) {
      // Delete all existing assignments for this patient
      await Promise.all(assignmentQuery.docs.map((doc) => doc.ref.delete()));
      console.log(`Cleared ${assignmentQuery.size} existing assignments for patient ${patientId}`);
    }

    // Create new assignment
    const assignmentRef = await db.collection('doctor_assignments').add(assignmentData);
    console.log(`Assigned patient ${patientId} to doctor ${doctorId} with assignment ID ${assignmentRef.id}`);

    // Save to GCS (overwriting any existing file)
    const assignmentFile = bucket.file(`doctor_assignments/${patientId}-${doctorId}.json`);
    await uploadWithRetry(assignmentFile, JSON.stringify(assignmentData), { contentType: 'application/json' });
    console.log(`Assignment saved to GCS: ${assignmentFile.name}`);

    // Emit WebSocket event for real-time update
    const room = `${patientId}-${doctorId}`;
    io.to(room).emit('assignmentUpdated', { ...assignmentData, assignmentId: assignmentRef.id });
    console.log(`Emitted assignmentUpdated to room ${room}`);

    res.status(200).json({ message: 'Doctor assigned successfully', assignment: assignmentData });
  } catch (error) {
    console.error('Error in /assign-doctor:', error);
    res.status(500).json({ error: 'Failed to assign doctor', details: error.message });
  }
});

// Updated Endpoint: Notify Missed Dose with WebSocket Emission
app.post('/notify-missed-dose', async (req, res) => {
  console.log('POST /notify-missed-dose:', req.body);
  try {
    const { patientId, doctorId, message } = req.body;

    if (!patientId || !doctorId || !message) {
      return res.status(400).json({ error: 'patientId, doctorId, and message are required' });
    }

    const notificationId = `${Date.now()}`;
    const notificationData = {
      id: notificationId,
      patientId,
      doctorId,
      message,
      createdAt: new Date().toISOString(),
    };

    const notificationFile = bucket.file(`admin_notifications/${notificationId}.json`);
    await uploadWithRetry(notificationFile, JSON.stringify(notificationData), { contentType: 'application/json' });
    console.log(`Missed dose notification ${notificationId} saved`);

    // Emit WebSocket event for real-time alert
    const room = `${patientId}-${doctorId}`;
    io.to(room).emit('missedDoseAlert', notificationData);
    console.log(`Emitted missedDoseAlert to room ${room}`);

    // Send FCM notification (optional, requires device tokens)
    const doctorRef = await db.collection('doctors').where('doctorId', '==', doctorId).get();
    if (!doctorRef.empty) {
      const doctorData = doctorRef.docs[0].data();
      const fcmToken = doctorData.fcmToken;
      if (fcmToken) {
        const payload = {
          notification: {
            title: 'Missed Dose Alert',
            body: `Patient ${patientId} has missed doses: ${message}`,
          },
          token: fcmToken,
        };
        await messaging.send(payload);
        console.log(`FCM notification sent to doctor ${doctorId}`);
      } else {
        console.warn(`No FCM token found for doctor ${doctorId}`);
      }
    }

    res.status(200).json({ message: 'Missed dose notification sent', notificationId });
  } catch (error) {
    console.error('Error in /notify-missed-dose:', error);
    res.status(500).json({ error: 'Failed to send missed dose notification', details: error.message });
  }
});

// Enhanced Audio Upload and Transcription
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  console.log('POST /upload-audio:', { language: req.body.language, uid: req.body.uid });
  try {
    const language = req.body.language || 'en-US';
    const uid = req.body.uid;

    if (!uid) return res.status(400).json({ error: 'User ID (uid) is required' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const audioFile = req.file;
    if (audioFile.size === 0) return res.status(400).json({ error: 'Audio file is empty' });
    if (!audioFile.mimetype.includes('audio/webm')) {
      return res.status(400).json({ error: 'Unsupported format. Expected audio/webm' });
    }

    const fileName = `audio/${uid}/${Date.now()}-recording.webm`;
    const file = bucket.file(fileName);
    await uploadWithRetry(file, audioFile.buffer, { contentType: audioFile.mimetype });
    const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log(`Audio uploaded to GCS: ${audioUrl}`);

    let transcriptionText = 'Transcription unavailable';
    let translatedText = transcriptionText;

    if (speechClient) {
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
    }

    res.json({
      transcription: transcriptionText,
      translatedText,
      languageCode: language,
      audioUrl,
      warning: !speechClient ? 'Speech-to-text service unavailable' : undefined,
    });
  } catch (error) {
    console.error('Error in /upload-audio:', error);
    res.status(500).json({
      error: 'Failed to process audio upload',
      details: error.message,
    });
  }
});

// Enhanced Text-to-Speech with fallback
app.post('/text-to-speech', checkGoogleServices, async (req, res) => {
  console.log('POST /text-to-speech:', req.body);
  try {
    const { text, language = 'en-US' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: language, ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });

    const fileName = `tts/${Date.now()}.mp3`;
    const file = bucket.file(fileName);
    await uploadWithRetry(file, response.audioContent, { contentType: 'audio/mp3' });
    const audioUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

    res.json({ audioUrl });
  } catch (error) {
    console.error('Error in /text-to-speech:', error);
    res.status(500).json({
      error: 'Failed to convert text to speech',
      details: error.message,
    });
  }
});

// Fixed Translation Endpoint
app.post('/translate', checkGoogleServices, async (req, res) => {
  console.log('POST /translate:', req.body);
  try {
    const { text, sourceLanguageCode, targetLanguageCode } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    if (!sourceLanguageCode) {
      return res.status(400).json({ error: 'Source language code is required' });
    }
    if (!targetLanguageCode) {
      return res.status(400).json({ error: 'Target language code is required' });
    }

    console.log(`Translating "${text}" from ${sourceLanguageCode} to ${targetLanguageCode}`);

    if (sourceLanguageCode === targetLanguageCode) {
      return res.json({ translatedText: text });
    }

    const [translatedText] = await translateClient.translate(text, {
      from: sourceLanguageCode,
      to: targetLanguageCode,
    });

    console.log(`Translated "${text}" to "${translatedText}"`);
    res.json({ translatedText });
  } catch (error) {
    console.error('Error in /translate:', error);
    res.status(500).json({
      error: 'Failed to translate text',
      details: error.message,
      code: error.code || 400,
    });
  }
});

// Serve local files
app.use('/temp_audio', express.static(localStorageDir));

// Store Patient Profile in GCS and Firestore
app.post('/store-patient-profile', async (req, res) => {
  console.log('POST /store-patient-profile:', req.body);
  try {
    const { patientId, name, sex, age, uid, address, createdAt } = req.body;
    if (!patientId || !name || !sex || !age || !uid) {
      return res.status(400).json({ error: 'Missing required fields: patientId, name, sex, age, uid' });
    }

    const patientData = {
      patientId,
      name,
      sex,
      age: parseInt(age, 10),
      address,
      uid,
      createdAt: createdAt || new Date().toISOString(),
    };

    const patientFile = bucket.file(`patients/${patientId}.json`);
    await uploadWithRetry(patientFile, JSON.stringify(patientData), { contentType: 'application/json' });
    console.log(`Patient profile ${patientId} saved in GCS`);

    await db.collection('patients').doc(patientId).set(patientData, { merge: true });
    console.log(`Patient profile ${patientId} saved in Firestore`);

    res.status(200).json({ message: 'Patient profile saved', patientId });
  } catch (error) {
    console.error('Error in /store-patient-profile:', error);
    res.status(500).json({ error: 'Failed to save patient profile', details: error.message });
  }
});

// Add Doctor (Admin only) and sync with Firestore
app.post('/add-doctor', checkRole('admin'), async (req, res) => {
  console.log('POST /add-doctor:', req.body);
  try {
    const { id, name, age, sex, experience, specialty, qualification, address, contactNumber, createdAt, uid } = req.body;
    if (!id || !name || !age || !sex || !experience || !specialty || !qualification || !address || !contactNumber) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const doctorData = {
      doctorId: id,
      name,
      age: parseInt(age, 10),
      sex,
      experience: parseInt(experience, 10),
      specialty,
      qualification,
      address,
      contactNumber,
      createdAt: createdAt || new Date().toISOString(),
      uid: uid || null,
    };

    const doctorFile = bucket.file(`doctors/${id}.json`);
    await uploadWithRetry(doctorFile, JSON.stringify(doctorData), { contentType: 'application/json' });
    console.log(`Doctor ${id} added to GCS`);

    await db.collection('doctors').doc(id).set(doctorData, { merge: true });
    console.log(`Doctor ${id} added to Firestore`);

    res.status(200).json({ message: 'Doctor added successfully', doctorId: id });
  } catch (error) {
    console.error('Error in /add-doctor:', error);
    res.status(500).json({ error: 'Failed to add doctor', details: error.message });
  }
});

// Get Doctor's Assigned Patients
app.get('/doctors/:doctorId/patients', async (req, res) => {
  console.log(`GET /doctors/${req.params.doctorId}/patients`);
  try {
    const { doctorId } = req.params;

    const assignmentsSnapshot = await db.collection('doctor_assignments')
      .where('doctorId', '==', doctorId)
      .get();

    const patients = await Promise.all(
      assignmentsSnapshot.docs.map(async (doc) => {
        const assignment = doc.data();
        const patientId = assignment.patientId;

        try {
          const patientFile = bucket.file(`patients/${patientId}.json`);
          const [exists] = await patientFile.exists();
          if (!exists) return null;

          const [contents] = await patientFile.download();
          const patientData = JSON.parse(contents.toString('utf8'));

          const chatFile = bucket.file(`chats/${patientId}-${doctorId}.json`);
          const [chatExists] = await chatFile.exists();
          let lastMessage = null;
          if (chatExists) {
            const [chatContents] = await chatFile.download();
            const chatData = JSON.parse(chatContents.toString('utf8'));
            lastMessage = chatData.messages?.length > 0
              ? chatData.messages[chatData.messages.length - 1]
              : null;
          }

          return {
            ...patientData,
            lastMessage: lastMessage?.text || lastMessage?.translatedText || null,
            timestamp: assignment.timestamp,
          };
        } catch (error) {
          console.error(`Error fetching patient ${patientId}:`, error.message);
          return null;
        }
      })
    );

    const validPatients = patients.filter((p) => p);
    res.json(validPatients);
  } catch (error) {
    console.error('Error in /doctors/:doctorId/patients:', error);
    res.status(500).json({ error: 'Failed to fetch doctor patients', details: error.message });
  }
});

// Delete Doctor (Admin only)
app.delete('/delete-doctor/:doctorId', checkRole('admin'), async (req, res) => {
  console.log(`DELETE /delete-doctor/${req.params.doctorId}`);
  try {
    const { doctorId } = req.params;

    const doctorFile = bucket.file(`doctors/${doctorId}.json`);
    const [doctorExists] = await doctorFile.exists();
    if (doctorExists) {
      await doctorFile.delete();
      console.log(`Doctor ${doctorId} deleted from GCS`);
    } else {
      console.warn(`Doctor ${doctorId} not found in GCS`);
    }

    await db.collection('doctors').doc(doctorId).delete();
    console.log(`Doctor ${doctorId} deleted from Firestore`);

    const [chatFiles] = await bucket.getFiles({ prefix: 'chats/' });
    const doctorChats = chatFiles.filter((file) =>
      file.name.includes(`-${doctorId}.json`) || file.name.includes(`${doctorId}-`)
    );
    await Promise.all(doctorChats.map((file) => file.delete()));
    console.log(`Deleted ${doctorChats.length} chat files for doctor ${doctorId}`);

    const assignmentsSnapshot = await db.collection('doctor_assignments')
      .where('doctorId', '==', doctorId)
      .get();
    await Promise.all(assignmentsSnapshot.docs.map((doc) => doc.ref.delete()));
    console.log(`Deleted ${assignmentsSnapshot.size} assignments for doctor ${doctorId}`);

    res.status(200).json({ message: 'Doctor deleted successfully' });
  } catch (error) {
    console.error('Error in /delete-doctor:', error);
    res.status(500).json({ error: 'Failed to delete doctor', details: error.message });
  }
});

// Delete Patient
app.delete('/delete-patient/:patientId', async (req, res) => {
  console.log(`DELETE /delete-patient/${req.params.patientId}`);
  try {
    const { patientId } = req.params;

    try {
      await admin.auth().deleteUser(patientId);
      console.log(`Patient ${patientId} deleted from Firebase Auth`);
    } catch (authError) {
      if (authError.code !== 'auth/user-not-found') throw authError;
      console.warn(`Patient ${patientId} not found in Firebase Auth`);
    }

    const patientFile = bucket.file(`patients/${patientId}.json`);
    const [patientExists] = await patientFile.exists();
    if (patientExists) {
      await patientFile.delete();
      console.log(`Patient ${patientId} deleted from GCS`);
    } else {
      console.warn(`Patient ${patientId} not found in GCS`);
    }

    await db.collection('patients').doc(patientId).delete();
    console.log(`Patient ${patientId} deleted from Firestore`);

    const [chatFiles] = await bucket.getFiles({ prefix: 'chats/' });
    const patientChats = chatFiles.filter((file) =>
      file.name.includes(`${patientId}-`) || file.name.includes(`-${patientId}.json`)
    );
    await Promise.all(patientChats.map((file) => file.delete()));
    console.log(`Deleted ${patientChats.length} chat files for patient ${patientId}`);

    const [notificationFiles] = await bucket.getFiles({ prefix: 'admin_notifications/' });
    const patientNotifications = await Promise.all(
      notificationFiles.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return data.patientId === patientId ? file : null;
        } catch (fileError) {
          console.error(`Error processing notification file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    const notificationsToDelete = patientNotifications.filter((file) => file);
    await Promise.all(notificationsToDelete.map((file) => file.delete()));
    console.log(`Deleted ${notificationsToDelete.length} notifications for patient ${patientId}`);

    const assignmentsSnapshot = await db.collection('doctor_assignments')
      .where('patientId', '==', patientId)
      .get();
    await Promise.all(assignmentsSnapshot.docs.map((doc) => doc.ref.delete()));
    console.log(`Deleted ${assignmentsSnapshot.size} assignments for patient ${patientId}`);

    res.status(200).json({ message: 'Patient deleted successfully' });
  } catch (error) {
    console.error('Error in /delete-patient:', error);
    res.status(500).json({ error: 'Failed to delete patient', details: error.message });
  }
});

// Fetch Doctors by Specialty
app.get('/doctors-by-specialty/:specialty', async (req, res) => {
  console.log(`GET /doctors-by-specialty/${req.params.specialty}`);
  try {
    const { specialty } = req.params;
    const [files] = await bucket.getFiles({ prefix: 'doctors/' });
    const doctorList = await Promise.all(
      files.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return data.specialty === specialty ? { id: file.name.split('/')[1].replace('.json', ''), ...data } : null;
        } catch (fileError) {
          console.error(`Error processing doctor file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    res.json(doctorList.filter((doctor) => doctor));
  } catch (error) {
    console.error('Error in /doctors-by-specialty:', error);
    res.status(500).json({ error: 'Failed to fetch doctors by specialty', details: error.message });
  }
});

// Upload Image (Patient only)
app.post('/uploadImage/:patientId', checkRole('patient'), upload.single('image'), async (req, res) => {
  console.log(`POST /uploadImage/${req.params.patientId}`);
  try {
    const { patientId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

    const fileName = `images/${patientId}/${Date.now()}_${req.file.originalname}`;
    const blob = bucket.file(fileName);

    await uploadWithRetry(blob, req.file.buffer, { contentType: req.file.mimetype });
    await blob.makePublic();
    const imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log(`Image uploaded: ${imageUrl}`);
    res.status(200).json({ imageUrl });
  } catch (error) {
    console.error('Error in /uploadImage:', error);
    res.status(500).json({ error: 'Failed to upload image', details: error.message });
  }
});

// Fetch Chat Messages with Patient and Doctor Validation
app.get('/chats/:patientId/:doctorId', async (req, res) => {
  console.log(`GET /chats/${req.params.patientId}/${req.params.doctorId}`);
  try {
    const { patientId, doctorId } = req.params;
    const userId = req.headers['x-user-uid'];

    if (!userId) {
      console.log('No UID provided in x-user-uid header');
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
    const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();

    let isAuthorized = false;
    let userRole = null;

    if (!patientQuery.empty && patientQuery.docs[0].data().patientId === patientId) {
      isAuthorized = true;
      userRole = 'patient';
      console.log(`User ${userId} authorized as patient ${patientId}`);
    } else if (!doctorQuery.empty && doctorQuery.docs[0].data().doctorId === doctorId) {
      isAuthorized = true;
      userRole = 'doctor';
      console.log(`User ${userId} authorized as doctor ${doctorId}`);
    }

    if (!isAuthorized) {
      console.log(`Access denied: UID=${userId} is neither patient ${patientId} nor doctor ${doctorId}`);
      return res.status(403).json({ error: 'You are not authorized to access this chat' });
    }

    const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
    const [exists] = await file.exists();
    if (!exists) {
      console.log(`No chats found for ${patientId}-${doctorId}`);
      return res.json({ messages: [] });
    }

    const [contents] = await file.download();
    const data = JSON.parse(contents.toString('utf8'));
    res.json({ messages: data.messages || [] });
  } catch (error) {
    console.error('Error in /chats/:patientId/:doctorId:', error);
    res.status(500).json({ error: 'Failed to fetch chat messages', details: error.message });
  }
});

// Save Chat Message with Validation
app.post('/chats/:patientId/:doctorId', async (req, res) => {
  console.log(`POST /chats/${req.params.patientId}/${req.params.doctorId}`, req.body);
  try {
    const { patientId, doctorId } = req.params;
    const userId = req.headers['x-user-uid'];
    const message = req.body;

    const sender = message.sender;
    if (!['patient', 'doctor'].includes(sender)) {
      return res.status(400).json({ error: 'Invalid sender type' });
    }

    let expectedId;
    if (sender === 'doctor') {
      const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
      if (doctorQuery.empty) {
        return res.status(404).json({ error: 'Doctor profile not found for this user' });
      }
      expectedId = doctorQuery.docs[0].data().doctorId;
    } else if (sender === 'patient') {
      const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
      if (patientQuery.empty) {
        return res.status(404).json({ error: 'Patient profile not found for this user' });
      }
      expectedId = patientQuery.docs[0].data().patientId;
    }

    if ((sender === 'doctor' && doctorId !== expectedId) || (sender === 'patient' && patientId !== expectedId)) {
      console.log(`Access denied: ${sender} ID mismatch. Expected ${expectedId}, got ${sender === 'doctor' ? doctorId : patientId}`);
      return res.status(403).json({ error: `You are not authorized to send messages as this ${sender}` });
    }

    const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
    let chatData = { messages: [] };
    const [exists] = await file.exists();
    if (exists) {
      const [contents] = await file.download();
      chatData = JSON.parse(contents.toString('utf8'));
    }

    const newMessage = { ...message, timestamp: message.timestamp || new Date().toISOString() };
    chatData.messages.push(newMessage);
    await uploadWithRetry(file, JSON.stringify(chatData), { contentType: 'application/json' });

    const room = `${patientId}-${doctorId}`;
    io.to(room).emit('newMessage', newMessage);
    console.log(`Emitted newMessage to room ${room}`);

    res.status(200).json({ message: 'Message saved' });
  } catch (error) {
    console.error('Error in /chats/:patientId/:doctorId:', error);
    res.status(500).json({ error: 'Failed to save chat message', details: error.message });
  }
});

// Fetch Patients
app.get('/patients', async (req, res) => {
  console.log('GET /patients');
  try {
    const [files] = await bucket.getFiles({ prefix: 'patients/' });
    const patientList = await Promise.all(
      files.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return { id: file.name.split('/')[1].replace('.json', ''), ...data };
        } catch (fileError) {
          console.error(`Error processing patient file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    res.json(patientList.filter((patient) => patient));
  } catch (error) {
    console.error('Error in /patients:', error);
    res.status(500).json({ error: 'Failed to fetch patients', details: error.message });
  }
});

// Fetch Patient by ID
app.get('/patients/:patientId', async (req, res) => {
  console.log(`GET /patients/${req.params.patientId}`);
  try {
    const { patientId } = req.params;
    const patientFile = bucket.file(`patients/${patientId}.json`);
    const [exists] = await patientFile.exists();
    if (!exists) return res.status(404).json({ error: 'Patient not found' });

    const [contents] = await patientFile.download();
    const patientData = JSON.parse(contents.toString('utf8'));
    res.json({ id: patientId, ...patientData });
  } catch (error) {
    console.error('Error in /patients/:patientId:', error);
    res.status(500).json({ error: 'Failed to fetch patient', details: error.message });
  }
});

// Update Patient (Diagnosis/Prescription) (Doctor only)
app.post('/patients/:patientId', checkRole('doctor'), async (req, res) => {
  console.log(`POST /patients/${req.params.patientId}`, req.body);
  try {
    const { patientId } = req.params;
    const { diagnosis, prescription, doctorId } = req.body;
    const expectedDoctorId = req.doctorId;

    if (doctorId !== expectedDoctorId) {
      return res.status(403).json({ error: 'You are not authorized to update this patient' });
    }

    const patientFile = bucket.file(`patients/${patientId}.json`);
    const [exists] = await patientFile.exists();
    let patientData = exists ? JSON.parse((await patientFile.download())[0].toString('utf8')) : {};

    if (diagnosis) {
      patientData.diagnosis = diagnosis;
      patientData.diagnosedAt = new Date().toISOString();
    }
    if (prescription) {
      patientData.prescription = prescription;
      patientData.prescribedAt = new Date().toISOString();
    }
    await uploadWithRetry(patientFile, JSON.stringify(patientData), { contentType: 'application/json' });

    await db.collection('patients').doc(patientId).set(patientData, { merge: true });
    console.log(`Patient ${patientId} updated in Firestore`);

    const message = {
      sender: 'doctor',
      diagnosis: diagnosis || patientData.diagnosis,
      prescription: prescription || patientData.prescription,
      timestamp: new Date().toISOString(),
      doctorId,
      patientId,
    };
    const room = `${patientId}-${doctorId}`;
    io.to(room).emit('newMessage', message);
    console.log(`Emitted newMessage to room ${room}`);

    const chatFile = bucket.file(`chats/${patientId}-${doctorId}.json`);
    let chatData = { messages: [] };
    const [chatExists] = await chatFile.exists();
    if (chatExists) {
      const [contents] = await chatFile.download();
      chatData = JSON.parse(contents.toString('utf8'));
    }
    chatData.messages.push(message);
    await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

    res.status(200).json({ message: 'Patient updated' });
  } catch (error) {
    console.error('Error in /patients/:patientId:', error);
    res.status(500).json({ error: 'Failed to update patient', details: error.message });
  }
});

// Fetch Doctors
app.get('/doctors', async (req, res) => {
  console.log('GET /doctors');
  try {
    const [files] = await bucket.getFiles({ prefix: 'doctors/' });
    const doctorList = await Promise.all(
      files.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return { id: file.name.split('/')[1].replace('.json', ''), ...data };
        } catch (fileError) {
          console.error(`Error processing doctor file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    res.json(doctorList.filter((doctor) => doctor));
  } catch (error) {
    console.error('Error in /doctors:', error);
    res.status(500).json({ error: 'Failed to fetch doctors', details: error.message });
  }
});

// Fetch Admin Notifications
app.get('/admin_notifications', async (req, res) => {
  console.log('GET /admin_notifications');
  try {
    const [files] = await bucket.getFiles({ prefix: 'admin_notifications/' });
    const caseList = await Promise.all(
      files.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return { id: file.name.split('/')[1].replace('.json', ''), ...data };
        } catch (fileError) {
          console.error(`Error processing notification file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    const filteredCaseList = caseList.filter((caseItem) => caseItem !== null);
    console.log(`Fetched ${filteredCaseList.length} admin notifications`);
    res.json(filteredCaseList);
  } catch (error) {
    console.error('Error in /admin_notifications:', error);
    res.status(500).json({ error: 'Failed to fetch admin notifications', details: error.message });
  }
});

// Save Admin Notification
app.post('/admin_notifications', async (req, res) => {
  console.log('POST /admin_notifications:', req.body);
  try {
    const { patientName, age, sex, description, disease, medicine, patientId, doctorId } = req.body;
    const notificationId = `${Date.now()}`;
    const notificationData = {
      patientName,
      age: age ? parseInt(age, 10) : null,
      sex,
      description,
      disease,
      medicine,
      patientId,
      doctorId,
      createdAt: new Date().toISOString(),
    };
    const notificationFile = bucket.file(`admin_notifications/${notificationId}.json`);
    await uploadWithRetry(notificationFile, JSON.stringify(notificationData), { contentType: 'application/json' });
    console.log(`Notification ${notificationId} saved`);
    res.status(200).json({ message: 'Notification saved', notificationId });
  } catch (error) {
    console.error('Error in /admin_notifications:', error);
    res.status(500).json({ error: 'Failed to save notification', details: error.message });
  }
});

// Fetch Chat Metadata (for DoctorChat sidebar)
app.get('/chats', async (req, res) => {
  console.log('GET /chats');
  try {
    const [chatFiles] = await bucket.getFiles({ prefix: 'chats/' });
    const patientDoctorPairs = await Promise.all(
      chatFiles
        .filter((file) => file.name.endsWith('.json'))
        .map(async (file) => {
          try {
            const [patientId, doctorId] = file.name.split('/')[1].replace('.json', '').split('-');
            const [contents] = await file.download();
            const chatData = JSON.parse(contents.toString('utf8'));
            const patientFile = bucket.file(`patients/${patientId}.json`);
            const doctorFile = bucket.file(`doctors/${doctorId}.json`);

            const [patientExists] = await patientFile.exists();
            const [doctorExists] = await doctorFile.exists();

            const patientData = patientExists ? JSON.parse((await patientFile.download())[0].toString('utf8')) : {};
            const doctorData = doctorExists ? JSON.parse((await doctorFile.download())[0].toString('utf8')) : {};

            return {
              patientId,
              doctorId,
              patientName: patientData.name || 'Unknown',
              doctorName: doctorData.name || 'Unknown',
              lastMessage: chatData.messages?.length > 0
                ? (chatData.messages[chatData.messages.length - 1].text || chatData.messages[chatData.messages.length - 1].transcription)
                : 'No messages yet',
              timestamp: chatData.messages?.length > 0 ? chatData.messages[chatData.messages.length - 1].timestamp : new Date().toISOString(),
            };
          } catch (fileError) {
            console.error(`Error processing chat file ${file.name}:`, fileError.message);
            return null;
          }
        })
    );
    res.json(patientDoctorPairs.filter((pair) => pair));
  } catch (error) {
    console.error('Error in /chats:', error);
    res.status(500).json({ error: 'Failed to fetch chat metadata', details: error.message });
  }
});

// Save or Fetch User
app.get('/users/:uid', async (req, res) => {
  console.log(`GET /users/${req.params.uid}`);
  try {
    const { uid } = req.params;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    res.json(userDoc.data());
  } catch (error) {
    console.error('Error in /users/:uid:', error);
    res.status(500).json({ error: 'Failed to fetch user', details: error.message });
  }
});

app.post('/users/:uid', async (req, res) => {
  console.log(`POST /users/${req.params.uid}`, req.body);
  try {
    const { uid } = req.params;
    const { username, role, name, sex, age, patientId, doctorId } = req.body;
    if (!username || !role) return res.status(400).json({ error: 'Username and role are required' });

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    const userData = {
      uid,
      username,
      role,
      name: name || null,
      sex: sex || null,
      age: age ? parseInt(age, 10) : null,
      patientId: patientId || null,
      doctorId: doctorId || null,
      createdAt: userDoc.exists ? userDoc.data().createdAt : new Date().toISOString(),
    };

    await userRef.set(userData, { merge: true });
    console.log(`User ${uid} ${userDoc.exists ? 'updated' : 'created'}`);
    res.status(userDoc.exists ? 200 : 201).json({ message: userDoc.exists ? 'User updated' : 'User created', user: userData });
  } catch (error) {
    console.error('Error in /users/:uid:', error);
    res.status(500).json({ error: 'Failed to save or update user', details: error.message });
  }
});

// Save or Fetch Patient by Name
app.get('/patients/by-name/:name', async (req, res) => {
  console.log(`GET /patients/by-name/${req.params.name}`);
  try {
    const { name } = req.params;
    const [files] = await bucket.getFiles({ prefix: 'patients/' });
    const patient = await Promise.all(
      files.map(async (file) => {
        try {
          const [contents] = await file.download();
          const data = JSON.parse(contents.toString('utf8'));
          return data.name === name ? { id: file.name.split('/')[1].replace('.json', ''), ...data } : null;
        } catch (fileError) {
          console.error(`Error processing patient file ${file.name}:`, fileError.message);
          return null;
        }
      })
    );
    const foundPatient = patient.find((p) => p);
    if (!foundPatient) return res.status(404).json({ error: 'Patient not found' });
    res.json(foundPatient);
  } catch (error) {
    console.error('Error in /patients/by-name/:name:', error);
    res.status(500).json({ error: 'Failed to fetch patient by name', details: error.message });
  }
});

app.post('/patients/:patientId', async (req, res) => {
  console.log(`POST /patients/${req.params.patientId}`, req.body);
  try {
    const { patientId } = req.params;
    const patientData = req.body;
    const patientFile = bucket.file(`patients/${patientId}.json`);
    await uploadWithRetry(patientFile, JSON.stringify(patientData), { contentType: 'application/json' });
    console.log(`Patient ${patientId} saved`);
    res.status(200).json({ message: 'Patient saved' });
  } catch (error) {
    console.error('Error in /patients/:patientId:', error);
    res.status(500).json({ error: 'Failed to save patient', details: error.message });
  }
});

// Save or Fetch Doctor by ID
app.get('/doctors/:id', async (req, res) => {
  console.log(`GET /doctors/${req.params.id}`);
  try {
    const { id } = req.params;
    const doctorFile = bucket.file(`doctors/${id}.json`);
    const [exists] = await doctorFile.exists();
    if (!exists) return res.status(404).json({ error: 'Doctor not found' });

    const [contents] = await doctorFile.download();
    res.json(JSON.parse(contents.toString('utf8')));
  } catch (error) {
    console.error('Error in /doctors/:id:', error);
    res.status(500).json({ error: 'Failed to fetch doctor', details: error.message });
  }
});

app.post('/doctors/:id', async (req, res) => {
  console.log(`POST /doctors/${req.params.id}`, req.body);
  try {
    const { id } = req.params;
    const doctorData = req.body;
    const doctorFile = bucket.file(`doctors/${id}.json`);
    await uploadWithRetry(doctorFile, JSON.stringify(doctorData), { contentType: 'application/json' });
    console.log(`Doctor ${id} saved`);
    res.status(200).json({ message: 'Doctor saved' });
  } catch (error) {
    console.error('Error in /doctors/:id:', error);
    res.status(500).json({ error: 'Failed to save doctor', details: error.message });
  }
});

// Logout Endpoint with Assignment Cleanup (Optional)
app.post('/logout', checkRole('patient'), async (req, res) => {
  console.log('POST /logout');
  try {
    const userId = req.headers['x-user-uid'];
    const patientId = req.patientId;

    // Optionally clear assignments on logout
    const assignmentsSnapshot = await db.collection('doctor_assignments')
      .where('patientId', '==', patientId)
      .get();
    if (!assignmentsSnapshot.empty) {
      await Promise.all(assignmentsSnapshot.docs.map((doc) => doc.ref.delete()));
      console.log(`Cleared ${assignmentsSnapshot.size} assignments for patient ${patientId} on logout`);
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in /logout:', error);
    res.status(500).json({ error: 'Failed to logout', details: error.message });
  }
});

// Start the server after verifying GCS
const startServer = async () => {
  gcsAvailable = await testBucketAccess();
  if (!gcsAvailable) {
    console.error('Google Cloud Storage is not available. Server will start but GCS operations may fail.');
  }

  const PORT = process.env.PORT || 5005;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Service Status:', {
      GCS: gcsAvailable ? 'Available' : 'Unavailable',
      Speech: speechClient ? 'Available' : 'Unavailable',
      Translation: translateClient ? 'Available' : 'Unavailable',
      TTS: ttsClient ? 'Available' : 'Unavailable',
    });
  });
};

startServer();