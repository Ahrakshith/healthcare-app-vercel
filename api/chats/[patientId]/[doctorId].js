import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import Pusher from 'pusher';
import busboy from 'busboy';

// Initialize Firebase Admin
let app;
try {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error('Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, or FIREBASE_CLIENT_EMAIL');
  }

  app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log('Firebase Admin initialized successfully in api/chats/[patientId]/[doctorId].js');
} catch (error) {
  console.error('Firebase Admin initialization failed in api/chats/[patientId]/[doctorId].js:', error.message);
  throw new Error(`Firebase Admin initialization failed: ${error.message}`);
}

const auth = getAuth();
const db = getFirestore(); // Kept for doctor_assignments and user data lookup

// Initialize GCS
let storage;
try {
  if (!process.env.GCS_PROJECT_ID || !process.env.GCS_PRIVATE_KEY || !process.env.GCS_CLIENT_EMAIL) {
    throw new Error('Missing GCS credentials: GCS_PROJECT_ID, GCS_PRIVATE_KEY, or GCS_CLIENT_EMAIL');
  }

  storage = new Storage({
    projectId: process.env.GCS_PROJECT_ID,
    credentials: {
      client_email: process.env.GCS_CLIENT_EMAIL,
      private_key: process.env.GCS_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
  });
  console.log('Google Cloud Storage initialized successfully in api/chats/[patientId]/[doctorId].js');
} catch (error) {
  console.error('GCS initialization failed in api/chats/[patientId]/[doctorId].js:', error.message);
  throw new Error(`GCS initialization failed: ${error.message}`);
}

const bucketName = process.env.GCS_BUCKET_NAME || 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

// Initialize Pusher
let pusher;
try {
  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
    throw new Error('Missing Pusher credentials: PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, or PUSHER_CLUSTER');
  }

  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true,
  });
  console.log('Pusher initialized successfully in api/chats/[patientId]/[doctorId].js');
} catch (error) {
  console.error('Pusher initialization failed in api/chats/[patientId]/[doctorId].js:', error.message);
  throw new Error(`Pusher initialization failed: ${error.message}`);
}

// Utility function for GCS upload with retry logic
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      console.log(`Successfully uploaded ${file.name} to GCS on attempt ${attempt}`);
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}:`, error.message);
      if (attempt === retries) throw error;
      const delay = backoff * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Validate message sender
const validateSender = sender => {
  const validSenders = ['patient', 'doctor'];
  if (!sender || !validSenders.includes(sender)) {
    throw new Error(`Invalid sender type: ${sender || 'undefined'}`);
  }
};

// Generate a signed URL for accessing GCS files
const generateSignedUrl = async filePath => {
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
    console.error(`Error generating signed URL for ${filePath}:`, error.message);
    throw error;
  }
};

// Initialize doctor assignment in Firestore (optional)
const initializeDoctorAssignment = async (patientId, doctorId) => {
  const assignmentId = `${patientId}_${doctorId}`;
  const assignmentRef = db.collection('doctor_assignments').doc(assignmentId);
  const assignmentDoc = await assignmentRef.get();
  if (!assignmentDoc.exists) {
    await assignmentRef.set({
      patientId,
      doctorId,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`Created doctor assignment for patient ${patientId} and doctor ${doctorId}`);
  }
};

// Check if the doctor is assigned to the patient
const isDoctorAssignedToPatient = async (doctorId, patientId) => {
  try {
    const assignmentId = `${patientId}_${doctorId}`;
    const assignmentRef = db.collection('doctor_assignments').doc(assignmentId);
    const assignmentDoc = await assignmentRef.get();
    const isAssigned = assignmentDoc.exists;
    console.log(`Doctor ${doctorId} assignment check for patient ${patientId}: ${isAssigned}`);
    return isAssigned;
  } catch (error) {
    console.error(`Error checking doctor assignment for doctor ${doctorId} and patient ${patientId}:`, error.message);
    throw error;
  }
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { patientId, doctorId } = req.query;
  const userId = req.headers['x-user-uid'];
  const authHeader = req.headers.authorization;

  // Validate headers and query params
  if (!userId || !authHeader) {
    console.error('Missing authentication headers:', { userId, authHeader });
    return res.status(401).json({ error: 'Authentication headers missing' });
  }

  if (!patientId || !doctorId) {
    console.error('Missing patientId or doctorId:', { patientId, doctorId });
    return res.status(400).json({ error: 'Patient ID and Doctor ID are required' });
  }

  try {
    // Verify Firebase ID token
    const token = authHeader.replace('Bearer ', '');
    const decodedToken = await auth.verifyIdToken(token);
    if (decodedToken.uid !== userId) {
      console.error('User ID mismatch:', { tokenUid: decodedToken.uid, headerUid: userId });
      return res.status(403).json({ error: 'Unauthorized user' });
    }

    // Authorize user based on Firestore data instead of custom claims
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.error(`User ${userId} not found in Firestore`);
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const isPatient = userData.role === 'patient' && userData.patientId === patientId;
    const isDoctor = userData.role === 'doctor';
    let isAuthorized = false;
    let userRole = null;

    if (isPatient) {
      isAuthorized = true;
      userRole = 'patient';
      console.log(`User ${userId} authorized as patient ${patientId}`);
    } else if (isDoctor) {
      // Check if the doctor is assigned to the patient
      const doctorIdFromUser = userData.doctorId;
      const isAssigned = await isDoctorAssignedToPatient(doctorIdFromUser, patientId);
      if (isAssigned) {
        isAuthorized = true;
        userRole = 'doctor';
        console.log(`User ${userId} authorized as doctor ${doctorIdFromUser} for patient ${patientId}`);
      } else {
        console.log(`User ${userId} (doctor ${doctorIdFromUser}) is not assigned to patient ${patientId}`);
      }
    }

    if (!isAuthorized) {
      console.error(`User ${userId} not authorized for chat between patient ${patientId} and doctor ${doctorId}`);
      return res.status(403).json({ error: 'You are not authorized to access this chat' });
    }

    // Check or initialize doctor assignment (optional)
    await initializeDoctorAssignment(patientId, doctorId);

    const chatId = `${patientId}-${doctorId}`;
    const chatFile = bucket.file(`chats/${chatId}/messages.json`);

    if (req.method === 'GET') {
      // Fetch messages from GCS
      const [exists] = await chatFile.exists();
      if (!exists) {
        console.log(`No messages found for chat ${chatId}`);
        return res.status(200).json({ messages: [], userRole });
      }

      const [contents] = await chatFile.download();
      const data = JSON.parse(contents.toString('utf8'));
      const messagesWithUrls = await Promise.all(
        (data.messages || []).map(async message => {
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

      console.log(`Fetched ${messagesWithUrls.length} messages for chat ${chatId}`);
      return res.status(200).json({ messages: messagesWithUrls, userRole });
    } else if (req.method === 'POST') {
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
          const { filename } = info;
          const chunks = [];
          file.on('data', chunk => chunks.push(chunk));
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
            validateSender(effectiveSender);

            // Validate sender matches user role
            if ((effectiveSender === 'doctor' && userRole !== 'doctor') || (effectiveSender === 'patient' && userRole !== 'patient')) {
              console.error(`User ${userId} not authorized to send as ${effectiveSender}`);
              return res.status(403).json({ error: `You are not authorized to send messages as this ${effectiveSender}` });
            }

            const chatDir = `chats/${chatId}`;
            let chatData = { messages: [] };
            const [exists] = await chatFile.exists();
            if (exists) {
              const [contents] = await chatFile.download();
              chatData = JSON.parse(contents.toString('utf8')) || { messages: [] };
            }

            const newMessage = {
              text: message.text || '',
              timestamp: new Date().toISOString(),
              sender: effectiveSender,
              senderId: userId,
              language: message.language || 'en',
              recordingLanguage: message.recordingLanguage || 'en',
              translatedText: message.translatedText || '',
              doctorId,
              patientId: patientId, // Changed from userId to patientId to match front-end
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
              await uploadWithRetry(imageFile, imageFileBuffer, {
                contentType: imageFileName.endsWith('.png') ? 'image/png' : 'image/jpeg',
              });
              newMessage.imagePath = `${chatDir}/images/${imageFileName}`;
              newMessage.imageUrl = await generateSignedUrl(newMessage.imagePath);
            }

            chatData.messages.push(newMessage);
            await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

            // Trigger Pusher event with the correct event name and channel name
            const channelName = `chat-${patientId}-${doctorId}`;
            await pusher.trigger(channelName, 'new-message', newMessage);
            console.log(`Pusher event 'new-message' triggered on channel ${channelName}`);

            return res.status(200).json({ message: 'Message saved successfully', newMessage });
          } catch (error) {
            console.error(`Error processing file upload for chat ${chatId}:`, error.message);
            return res.status(500).json({ error: 'Failed to process file upload', details: error.message });
          }
        });

        req.pipe(bb);
      } else {
        const { message } = req.body;
        if (!message || typeof message !== 'object') {
          console.error('Invalid POST request body:', req.body);
          return res.status(400).json({ error: 'Message object is required' });
        }

        validateSender(message.sender);

        // Validate sender matches user role
        if ((message.sender === 'doctor' && userRole !== 'doctor') || (message.sender === 'patient' && userRole !== 'patient')) {
          console.error(`User ${userId} not authorized to send as ${message.sender}`);
          return res.status(403).json({ error: `You are not authorized to send messages as this ${message.sender}` });
        }

        let chatData = { messages: [] };
        const [exists] = await chatFile.exists();
        if (exists) {
          const [contents] = await chatFile.download();
          chatData = JSON.parse(contents.toString('utf8')) || { messages: [] };
        }

        const newMessage = {
          ...message,
          timestamp: new Date().toISOString(),
          senderId: userId,
          patientId: patientId, // Ensure patientId is included in the message
        };

        chatData.messages.push(newMessage);
        await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

        // Trigger Pusher event with the correct event name and channel name
        const channelName = `chat-${patientId}-${doctorId}`;
        await pusher.trigger(channelName, 'new-message', newMessage);
        console.log(`Pusher event 'new-message' triggered on channel ${channelName}`);

        return res.status(200).json({ message: 'Message saved successfully', newMessage });
      }
    } else {
      console.error('Method not allowed:', req.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error(`Authentication error for user ${userId}:`, error.message);
    return res.status(401).json({ error: 'Invalid or expired token', details: error.message });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};