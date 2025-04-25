import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';
import Pusher from 'pusher';
import busboy from 'busboy';

// Initialize Firebase Admin
let adminInitialized = false;
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !privateKey || !process.env.FIREBASE_CLIENT_EMAIL) {
      console.error('Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, or FIREBASE_CLIENT_EMAIL');
      throw new Error('Firebase credentials incomplete');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    adminInitialized = true;
    console.log('Firebase Admin initialized successfully in chats/[patientId]/[doctorId].js');
  } catch (error) {
    console.error('Firebase Admin initialization failed in chats/[patientId]/[doctorId].js:', error.message, error.stack);
    console.warn('Firebase Admin disabled due to initialization failure');
  }
}

const db = adminInitialized ? admin.firestore() : null;

// Initialize GCS
let storage;
let serviceAccountKey;
try {
  if (!process.env.GCS_SERVICE_ACCOUNT_KEY) {
    console.error('GCS_SERVICE_ACCOUNT_KEY environment variable is not set');
    throw new Error('GCS credentials missing');
  }
  serviceAccountKey = JSON.parse(Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, 'base64').toString());
  storage = new Storage({ credentials: serviceAccountKey });
  console.log('Google Cloud Storage initialized successfully in chats/[patientId]/[doctorId].js');
} catch (error) {
  console.error('Failed to initialize GCS in chats/[patientId]/[doctorId].js:', error.message, error.stack);
  console.warn('GCS disabled due to initialization failure');
}

const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
const bucket = storage ? storage.bucket(bucketName) : null;

// Initialize Pusher
let pusher;
try {
  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
    console.error('Missing Pusher credentials: PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, or PUSHER_CLUSTER');
    throw new Error('Pusher credentials incomplete');
  }
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true,
  });
  console.log('Pusher initialized successfully in chats/[patientId]/[doctorId].js');
} catch (error) {
  console.error('Pusher initialization failed in chats/[patientId]/[doctorId].js:', error.message, error.stack);
  console.warn('Pusher disabled due to initialization failure');
}

// Utility function for GCS upload with retry logic
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  if (!file) throw new Error('No file provided for upload');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      console.log(`Successfully uploaded ${file.name} to GCS on attempt ${attempt}`);
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message, error.stack);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Validate message sender
const validateSender = (sender) => {
  console.log('Validating sender:', sender);
  const validSenders = ['patient', 'doctor'];
  if (!sender || !validSenders.includes(sender)) {
    throw new Error(`Invalid sender type: ${sender || 'undefined'}`);
  }
};

// Generate a signed URL for accessing GCS files
const generateSignedUrl = async (filePath) => {
  if (!bucket) return null;
  try {
    const file = bucket.file(filePath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 1000 * 60 * 60, // 1 hour expiry
      responseDisposition: 'inline',
    });
    console.log(`Generated signed URL for ${filePath}: ${url}`);
    return url;
  } catch (error) {
    console.error(`Error generating signed URL for ${filePath}:`, error.message, error.stack);
    throw error;
  }
};

// Initialize doctor assignment in Firestore
const initializeDoctorAssignment = async (patientId, doctorId) => {
  if (!db) throw new Error('Firestore not initialized');
  const assignmentId = `${patientId}_${doctorId}`;
  const assignmentRef = db.collection('doctor_assignments').doc(assignmentId);
  const assignmentDoc = await assignmentRef.get();
  if (!assignmentDoc.exists) {
    await assignmentRef.set({
      patientId,
      doctorId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Created doctor assignment for patient ${patientId} and doctor ${doctorId}`);
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { patientId, doctorId } = req.query;
  const userId = req.headers['x-user-uid'];

  if (!userId) {
    console.error('Missing x-user-uid header');
    return res.status(400).json({ error: { code: 400, message: 'Firebase UID is required in x-user-uid header' } });
  }

  if (!patientId || !doctorId) {
    console.error('Missing patientId or doctorId in query parameters');
    return res.status(400).json({ error: { code: 400, message: 'patientId and doctorId are required' } });
  }

  try {
    if (req.method === 'GET') {
      if (!db || !bucket) {
        return res.status(503).json({ error: { code: 503, message: 'Service unavailable: Firebase or GCS not initialized' } });
      }

      console.log(`Authorizing user ${userId} for chat between patient ${patientId} and doctor ${doctorId}`);
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
        console.error(`User ${userId} not authorized for chat between patient ${patientId} and doctor ${doctorId}`);
        return res.status(403).json({ error: { code: 403, message: 'You are not authorized to access this chat' } });
      }

      const assignmentId = `${patientId}_${doctorId}`;
      const assignmentDoc = await db.collection('doctor_assignments').doc(assignmentId).get();
      if (!assignmentDoc.exists) {
        console.log(`No chat assignment found for patient ${patientId} and doctor ${doctorId}, returning empty chat`);
        return res.json({ messages: [], userRole });
      }

      const chatFile = bucket.file(`chats/${patientId}-${doctorId}/messages.json`);
      const [exists] = await chatFile.exists();
      if (!exists) {
        console.log(`No messages found for chat between patient ${patientId} and doctor ${doctorId}`);
        return res.json({ messages: [], userRole });
      }

      const [contents] = await chatFile.download();
      const data = JSON.parse(contents.toString('utf8'));

      const messagesWithUrls = await Promise.all(
        (data.messages || []).map(async (message) => {
          const updatedMessage = { ...message };
          if (message.audioPath) {
            updatedMessage.audioUrl = await generateSignedUrl(message.audioPath);
          }
          if (message.imagePath) {
            updatedMessage.imageUrl = await generateSignedUrl(message.imagePath);
          }
          return updatedMessage;
        })
      );

      console.log(`Fetched ${messagesWithUrls.length} messages for chat between patient ${patientId} and doctor ${doctorId}`);
      return res.json({ messages: messagesWithUrls, userRole });
    } else if (req.method === 'POST') {
      if (!db || !bucket) {
        return res.status(503).json({ error: { code: 503, message: 'Service unavailable: Firebase or GCS not initialized' } });
      }

      const contentType = req.headers['content-type'];
      if (contentType && contentType.includes('multipart/form-data')) {
        const bb = busboy({ headers: req.headers });

        let message = {};
        let audioFileBuffer;
        let imageFileBuffer;
        let audioFileName;
        let imageFileName;
        let sender;

        bb.on('file', (fieldname, file, info) => {
          const { filename, mimeType } = info;
          const chunks = [];
          file.on('data', (chunk) => chunks.push(chunk));
          file.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (fieldname === 'audio') {
              audioFileBuffer = buffer;
              audioFileName = `${Date.now()}-${filename}`;
            } else if (fieldname === 'image') {
              imageFileBuffer = buffer;
              imageFileName = `${Date.now()}-${filename}`;
            }
          });
        });

        bb.on('field', (name, value) => {
          try {
            if (name === 'message') {
              message = JSON.parse(value);
            } else if (name === 'sender') {
              sender = value;
            } else {
              message[name] = value;
            }
          } catch (e) {
            message[name] = value;
          }
        });

        bb.on('finish', async () => {
          try {
            const effectiveSender = sender || message.sender;
            console.log('FormData fields:', { sender, message, effectiveSender });
            validateSender(effectiveSender);

            let expectedId;
            if (effectiveSender === 'doctor') {
              const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
              if (doctorQuery.empty) {
                return res.status(404).json({ error: { code: 404, message: 'Doctor profile not found for this user' } });
              }
              expectedId = doctorQuery.docs[0].data().doctorId;
            } else if (effectiveSender === 'patient') {
              const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
              if (patientQuery.empty) {
                return res.status(404).json({ error: { code: 404, message: 'Patient profile not found for this user' } });
              }
              expectedId = patientQuery.docs[0].data().patientId;
            }

            if ((effectiveSender === 'doctor' && doctorId !== expectedId) || (effectiveSender === 'patient' && patientId !== expectedId)) {
              console.error(`User ${userId} not authorized to send messages as ${effectiveSender} in chat between patient ${patientId} and doctor ${doctorId}`);
              return res.status(403).json({ error: { code: 403, message: `You are not authorized to send messages as this ${effectiveSender}` } });
            }

            await initializeDoctorAssignment(patientId, doctorId);

            const chatDir = `chats/${patientId}-${doctorId}`;
            const chatFile = bucket.file(`${chatDir}/messages.json`);
            let chatData = { messages: [] };
            const [exists] = await chatFile.exists();
            if (exists) {
              const [contents] = await chatFile.download();
              chatData = JSON.parse(contents.toString('utf8')) || { messages: [] };
            }

            const newMessage = {
              text: message.text || '',
              timestamp: message.timestamp || new Date().toISOString(),
              sender: effectiveSender,
              senderId: userId,
              language: message.language || 'en',
              recordingLanguage: message.recordingLanguage || 'en',
              translatedText: message.translatedText || '',
              doctorId: message.doctorId || doctorId,
              userId: message.userId || patientId,
              messageType: message.messageType || 'text',
            };

            if (audioFileBuffer && audioFileName) {
              const audioFile = bucket.file(`${chatDir}/audio/${audioFileName}`);
              await uploadWithRetry(audioFile, audioFileBuffer, { contentType: 'audio/webm' });
              newMessage.audioPath = `${chatDir}/audio/${audioFileName}`;
              newMessage.audioUrl = await generateSignedUrl(newMessage.audioPath);
            }

            if (imageFileBuffer && imageFileName) {
              const imageFile = bucket.file(`${chatDir}/images/${imageFileName}`);
              await uploadWithRetry(imageFile, imageFileBuffer, { contentType: imageFileName.endsWith('.png') ? 'image/png' : 'image/jpeg' });
              newMessage.imagePath = `${chatDir}/images/${imageFileName}`;
              newMessage.imageUrl = await generateSignedUrl(newMessage.imagePath);
            }

            chatData.messages.push(newMessage);
            await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

            if (pusher) {
              await pusher.trigger(`chat-${patientId}-${doctorId}`, 'newMessage', newMessage);
              console.log(`Pusher event 'newMessage' triggered on channel chat-${patientId}-${doctorId}`);
            }

            return res.status(200).json({ message: 'Message saved successfully', newMessage });
          } catch (error) {
            console.error(`Error processing file upload for chat between patient ${patientId} and doctor ${doctorId}:`, error.message, error.stack);
            if (error.message.includes('Invalid sender type')) {
              return res.status(400).json({ error: { code: 400, message: error.message } });
            }
            return res.status(500).json({ error: { code: 500, message: 'Failed to process file upload', details: error.message } });
          }
        });

        req.pipe(bb);
      } else {
        const { message } = req.body;
        if (!message || typeof message !== 'object') {
          console.error('Missing or invalid message object in POST request:', req.body);
          return res.status(400).json({ error: { code: 400, message: 'Message object is required' } });
        }

        try {
          validateSender(message.sender);
          console.log(`Processing text message for chat between patient ${patientId} and doctor ${doctorId}, sender: ${message.sender}`);

          let expectedId;
          if (message.sender === 'doctor') {
            const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
            if (doctorQuery.empty) {
              return res.status(404).json({ error: { code: 404, message: 'Doctor profile not found for this user' } });
            }
            expectedId = doctorQuery.docs[0].data().doctorId;
          } else if (message.sender === 'patient') {
            const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
            if (patientQuery.empty) {
              return res.status(404).json({ error: { code: 404, message: 'Patient profile not found for this user' } });
            }
            expectedId = patientQuery.docs[0].data().patientId;
          }

          if ((message.sender === 'doctor' && doctorId !== expectedId) || (message.sender === 'patient' && patientId !== expectedId)) {
            console.error(`User ${userId} not authorized to send messages as ${message.sender} in chat between patient ${patientId} and doctor ${doctorId}`);
            return res.status(403).json({ error: { code: 403, message: `You are not authorized to send messages as this ${message.sender}` } });
          }

          await initializeDoctorAssignment(patientId, doctorId);

          const chatFile = bucket.file(`chats/${patientId}-${doctorId}/messages.json`);
          let chatData = { messages: [] };
          const [exists] = await chatFile.exists();
          if (exists) {
            const [contents] = await chatFile.download();
            chatData = JSON.parse(contents.toString('utf8')) || { messages: [] };
          }

          const newMessage = {
            ...message,
            timestamp: message.timestamp || new Date().toISOString(),
            senderId: userId,
          };
          chatData.messages.push(newMessage);

          await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

          if (pusher) {
            await pusher.trigger(`chat-${patientId}-${doctorId}`, 'newMessage', newMessage);
            console.log(`Pusher event 'newMessage' triggered on channel chat-${patientId}-${doctorId}`);
          }

          return res.status(200).json({ message: 'Message saved successfully', newMessage });
        } catch (error) {
          console.error(`Error processing text message for chat between patient ${patientId} and doctor ${doctorId}:`, error.message, error.stack);
          if (error.message.includes('Invalid sender type')) {
            return res.status(400).json({ error: { code: 400, message: error.message } });
          }
          return res.status(500).json({ error: { code: 500, message: 'Failed to process text message', details: error.message } });
        }
      }
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: { code: 405, message: `Method ${req.method} Not Allowed` } });
    }
  } catch (error) {
    console.error(`Error in /api/chats/${patientId}/${doctorId} (${req.method}) for user ${userId}:`, error.message, error.stack);
    if (error.message.includes('Invalid sender type')) {
      return res.status(400).json({ error: { code: 400, message: error.message } });
    }
    return res.status(500).json({ error: { code: 500, message: 'Failed to process request', details: error.message } });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};