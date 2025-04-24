import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';
import Pusher from 'pusher';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

// Initialize GCS
const storage = new Storage({
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
});
const bucketName = 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

// Utility function for GCS upload with retry logic
const uploadWithRetry = async (file, buffer, metadata, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { patientId, doctorId } = req.query;
  const userId = req.headers['x-user-uid'];

  if (!userId) {
    return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
  }

  if (!patientId || !doctorId) {
    return res.status(400).json({ error: 'patientId and doctorId are required' });
  }

  try {
    if (req.method === 'GET') {
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
        return res.status(403).json({ error: 'You are not authorized to access this chat' });
      }

      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ error: 'No chat assignment found' });
      }

      const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
      const [exists] = await file.exists();
      if (!exists) {
        return res.json({ messages: [] });
      }

      const [contents] = await file.download();
      const data = JSON.parse(contents.toString('utf8'));
      return res.json({ messages: data.messages || [], userRole });
    } else if (req.method === 'POST') {
      const { message } = req.body;
      if (!message || typeof message !== 'object') {
        return res.status(400).json({ error: 'Message object is required' });
      }

      const sender = message.sender;
      validateSender(sender);

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
        return res.status(403).json({ error: `You are not authorized to send messages as this ${sender}` });
      }

      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ error: 'No chat assignment found' });
      }

      const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
      let chatData = { messages: [] };
      const [exists] = await file.exists();
      if (exists) {
        const [contents] = await file.download();
        chatData = JSON.parse(contents.toString('utf8')) || { messages: [] };
      }

      const newMessage = {
        ...message,
        timestamp: message.timestamp || new Date().toISOString(),
        senderId: userId,
      };
      chatData.messages.push(newMessage);

      await uploadWithRetry(file, JSON.stringify(chatData), { contentType: 'application/json' });

      // Trigger Pusher event for real-time updates
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'new-message', newMessage);

      // Optionally save to Firestore for redundancy
      await db.collection('chats').doc(`${patientId}-${doctorId}`).set(chatData);

      return res.status(200).json({ message: 'Message saved' });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  } catch (error) {
    console.error(`Error in /api/chats/${patientId}/${doctorId} (${req.method}):`, error.message);
    if (error.message === 'Invalid sender type') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}