import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';
import Pusher from 'pusher';
import busboy from 'busboy';
//import

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !privateKey || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, or FIREBASE_CLIENT_EMAIL');
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized successfully in api/admin/index.js');
  } catch (error) {
    console.error('Firebase Admin initialization failed in api/admin/index.js:', error.message);
    throw new Error(`Firebase Admin initialization failed: ${error.message}`);
  }
}

const db = admin.firestore();

// Initialize GCS
let storage;
try {
  const gcsPrivateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!process.env.GCS_PROJECT_ID || !process.env.GCS_CLIENT_EMAIL || !gcsPrivateKey) {
    throw new Error('Missing GCS credentials: GCS_PROJECT_ID, GCS_CLIENT_EMAIL, or GCS_PRIVATE_KEY');
  }

  storage = new Storage({
    projectId: process.env.GCS_PROJECT_ID,
    credentials: {
      client_email: process.env.GCS_CLIENT_EMAIL,
      private_key: gcsPrivateKey,
    },
  });
  console.log('Google Cloud Storage initialized successfully in api/admin/index.js');
} catch (error) {
  console.error('GCS initialization failed in api/admin/index.js:', error.message);
  throw new Error(`GCS initialization failed: ${error.message}`);
}

const bucketName = 'fir-project-vercel'; // Update to the correct bucket in healthcare-app-d887 project
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
  console.log('Pusher initialized successfully in api/admin/index.js');
} catch (error) {
  console.error('Pusher initialization failed in api/admin/index.js:', error.message);
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Validate message sender
const validateSender = (sender) => {
  const validSenders = ['patient', 'doctor'];
  if (!validSenders.includes(sender)) {
    throw new Error('Invalid sender type');
  }
};

// Generate a signed URL for accessing GCS files
const generateSignedUrl = async (filePath) => {
  try {
    const file = bucket.file(filePath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 1000 * 60 * 60, // 1 hour expiry
    });
    console.log(`Generated signed URL for ${filePath}`);
    return url;
  } catch (error) {
    console.error(`Error generating signed URL for ${filePath}:`, error.message);
    throw error;
  }
};

// Admin endpoint to fetch missed dose alerts or other admin data
const handleAdminRequest = async (req, res, patientId, doctorId, userId) => {
  try {
    // Authorization check for admin role
    const adminQuery = await db.collection('admins').where('uid', '==', userId).get();
    if (adminQuery.empty) {
      return res.status(403).json({ error: { code: 403, message: 'You are not authorized as an admin' } });
    }

    // Example: Fetch missed dose alerts for the given patient and doctor
    const alertsRef = db.collection('missed_dose_alerts')
      .where('patientId', '==', patientId)
      .where('doctorId', '==', doctorId);
    const snapshot = await alertsRef.get();

    const alerts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate().toISOString() || new Date().toISOString(),
    }));

    console.log(`Fetched ${alerts.length} missed dose alerts for patient ${patientId} and doctor ${doctorId}`);
    return res.status(200).json({ alerts });
  } catch (error) {
    console.error(`Error in /api/admin for user ${userId}:`, error.message);
    return res.status(500).json({ error: { code: 500, message: 'Failed to fetch alerts', details: error.message } });
  }
};

// Chat endpoint handler
const handleChatRequest = async (req, res, patientId, doctorId, userId) => {
  if (req.method === 'GET') {
    // Authorization check
    const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
    const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
    let isAuthorized = false;
    let userRole = null;

    if (!patientQuery.empty && patientQuery.docs[0].data().patientId === patientId) {
      isAuthorized = true;
      userRole = 'patient';
    } else if (!doctorQuery.empty && doctorQuery.docs[0].data().doctorId === doctorId) {
      isAuthorized = true;
      userRole = 'doctor';
    }

    if (!isAuthorized) {
      return res.status(403).json({ error: { code: 403, message: 'You are not authorized to access this chat' } });
    }

    const assignmentQuery = await db.collection('doctor_assignments')
      .where('patientId', '==', patientId)
      .where('doctorId', '==', doctorId)
      .get();
    if (assignmentQuery.empty) {
      return res.status(404).json({ error: { code: 404, message: 'No chat assignment found' } });
    }

    const chatFile = bucket.file(`chats/${patientId}-${doctorId}/messages.json`);
    const [exists] = await chatFile.exists();
    if (!exists) {
      console.log(`No messages found for chat between patient ${patientId} and doctor ${doctorId}`);
      return res.json({ messages: [], userRole });
    }

    const [contents] = await chatFile.download();
    const data = JSON.parse(contents.toString('utf8'));

    // Generate signed URLs for audio and image files
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
    const contentType = req.headers['content-type'];
    let messageData;

    if (contentType && contentType.includes('multipart/form-data')) {
      // Handle file uploads (audio, image)
      const bb = busboy({ headers: req.headers });

      let message = {};
      let audioFileBuffer;
      let imageFileBuffer;
      let audioFileName;
      let imageFileName;

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
        message[name] = value;
      });

      bb.on('finish', async () => {
        try {
          validateSender(message.sender);

          // Authorization check
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
            return res.status(403).json({ error: { code: 403, message: `You are not authorized to send messages as this ${message.sender}` } });
          }

          const assignmentQuery = await db.collection('doctor_assignments')
            .where('patientId', '==', patientId)
            .where('doctorId', '==', doctorId)
            .get();
          if (assignmentQuery.empty) {
            return res.status(404).json({ error: { code: 404, message: 'No chat assignment found' } });
          }

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
            sender: message.sender,
            senderId: userId,
          };

          // Handle audio upload
          if (audioFileBuffer && audioFileName) {
            const audioFile = bucket.file(`${chatDir}/audio/${audioFileName}`);
            await uploadWithRetry(audioFile, audioFileBuffer, { contentType: 'audio/mpeg' });
            newMessage.audioPath = `${chatDir}/audio/${audioFileName}`;
          }

          // Handle image upload
          if (imageFileBuffer && imageFileName) {
            const imageFile = bucket.file(`${chatDir}/images/${imageFileName}`);
            await uploadWithRetry(imageFile, imageFileBuffer, { contentType: 'image/jpeg' });
            newMessage.imagePath = `${chatDir}/images/${imageFileName}`;
          }

          chatData.messages.push(newMessage);
          await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

          // Trigger Pusher event
          await pusher.trigger(`chat-${patientId}-${doctorId}`, 'new-message', newMessage);
          console.log(`Pusher event 'new-message' triggered on channel chat-${patientId}-${doctorId}`);

          return res.status(200).json({ message: 'Message saved successfully', newMessage });
        } catch (error) {
          console.error(`Error processing file upload for chat between patient ${patientId} and doctor ${doctorId}:`, error.message);
          return res.status(500).json({ error: { code: 500, message: 'Failed to process file upload', details: error.message } });
        }
      });

      req.pipe(bb);
    } else {
      // Handle text-only messages
      const { message } = req.body;
      if (!message || typeof message !== 'object') {
        return res.status(400).json({ error: { code: 400, message: 'Message object is required' } });
      }

      validateSender(message.sender);

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
        return res.status(403).json({ error: { code: 403, message: `You are not authorized to send messages as this ${message.sender}` } });
      }

      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ error: { code: 404, message: 'No chat assignment found' } });
      }

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

      // Trigger Pusher event
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'new-message', newMessage);
      console.log(`Pusher event 'new-message' triggered on channel chat-${patientId}-${doctorId}`);

      return res.status(200).json({ message: 'Message saved successfully', newMessage });
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const userId = req.headers['x-user-uid'];
  if (!userId) {
    return res.status(400).json({ error: { code: 400, message: 'Firebase UID is required in x-user-uid header' } });
  }

  // Handle dynamic routing based on path
  const { patientId, doctorId } = req.query;

  if (req.url.startsWith('/admin') && (req.method === 'GET' || req.method === 'POST')) {
    return handleAdminRequest(req, res, patientId, doctorId, userId);
  } else if (req.url.startsWith('/chats') && (req.method === 'GET' || req.method === 'POST')) {
    if (!patientId || !doctorId) {
      return res.status(400).json({ error: { code: 400, message: 'patientId and doctorId are required' } });
    }
    return handleChatRequest(req, res, patientId, doctorId, userId);
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: { code: 405, message: `Method ${req.method} Not Allowed for ${req.url}` } });
  }

  try {
  } catch (error) {
    console.error(`Error in api/admin/index.js (${req.method}) for user ${userId}:`, error.message);
    if (error.message === 'Invalid sender type') {
      return res.status(400).json({ error: { code: 400, message: error.message } });
    }
    return res.status(500).json({ error: { code: 500, message: 'Failed to process request', details: error.message } });
  }
}