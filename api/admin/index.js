import admin from 'firebase-admin';
import Pusher from 'pusher';
import { Storage } from '@google-cloud/storage';
import busboy from 'busboy';

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized successfully in api/admin/index.js');
  } catch (error) {
    console.error('Firebase Admin initialization failed in api/admin/index.js:', error.message);
    throw new Error('Firebase Admin initialization failed');
  }
}

const db = admin.firestore();

// Initialize Google Cloud Storage (GCS)
let storage;
try {
  const gcsPrivateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n');
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

const bucketName = 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

// Initialize Pusher
let pusher;
try {
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

// Chat endpoint handler
const handleChatRequest = async (req, res, patientId, doctorId, userId) => {
  if (req.method === 'GET') {
    try {
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
        return res.status(403).json({ success: false, message: 'You are not authorized to access this chat' });
      }

      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ success: false, message: 'No chat assignment found' });
      }

      const chatFile = bucket.file(`chats/${patientId}-${doctorId}/messages.json`);
      const [exists] = await chatFile.exists();
      if (!exists) {
        console.log(`No messages found for chat between patient ${patientId} and doctor ${doctorId}`);
        return res.json({ success: true, messages: [], userRole });
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
      return res.json({ success: true, messages: messagesWithUrls, userRole });
    } catch (error) {
      console.error(`Error fetching chat for patient ${patientId} and doctor ${doctorId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to fetch messages', details: error.message });
    }
  } else if (req.method === 'POST') {
    const contentType = req.headers['content-type'];
    let messageData;

    if (contentType && contentType.includes('multipart/form-data')) {
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

          let expectedId;
          if (message.sender === 'doctor') {
            const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
            if (doctorQuery.empty) {
              return res.status(404).json({ success: false, message: 'Doctor profile not found for this user' });
            }
            expectedId = doctorQuery.docs[0].data().doctorId;
          } else if (message.sender === 'patient') {
            const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
            if (patientQuery.empty) {
              return res.status(404).json({ success: false, message: 'Patient profile not found for this user' });
            }
            expectedId = patientQuery.docs[0].data().patientId;
          }

          if ((message.sender === 'doctor' && doctorId !== expectedId) || (message.sender === 'patient' && patientId !== expectedId)) {
            return res.status(403).json({ success: false, message: `You are not authorized to send messages as this ${message.sender}` });
          }

          const assignmentQuery = await db.collection('doctor_assignments')
            .where('patientId', '==', patientId)
            .where('doctorId', '==', doctorId)
            .get();
          if (assignmentQuery.empty) {
            return res.status(404).json({ success: false, message: 'No chat assignment found' });
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

          if (audioFileBuffer && audioFileName) {
            const audioFile = bucket.file(`${chatDir}/audio/${audioFileName}`);
            await uploadWithRetry(audioFile, audioFileBuffer, { contentType: 'audio/mpeg' });
            newMessage.audioPath = `${chatDir}/audio/${audioFileName}`;
          }

          if (imageFileBuffer && imageFileName) {
            const imageFile = bucket.file(`${chatDir}/images/${imageFileName}`);
            await uploadWithRetry(imageFile, imageFileBuffer, { contentType: 'image/jpeg' });
            newMessage.imagePath = `${chatDir}/images/${imageFileName}`;
          }

          chatData.messages.push(newMessage);
          await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

          await pusher.trigger(`chat-${patientId}-${doctorId}`, 'new-message', newMessage);
          console.log(`Pusher event 'new-message' triggered on channel chat-${patientId}-${doctorId}`);

          return res.status(200).json({ success: true, message: 'Message saved successfully', newMessage });
        } catch (error) {
          console.error(`Error processing file upload for chat between patient ${patientId} and doctor ${doctorId}:`, error.message);
          return res.status(500).json({ success: false, message: 'Failed to process file upload', details: error.message });
        }
      });

      req.pipe(bb);
    } else {
      const { message, append } = req.body;
      if (!message || typeof message !== 'object') {
        return res.status(400).json({ success: false, message: 'Message object is required' });
      }

      try {
        validateSender(message.sender);

        let expectedId;
        if (message.sender === 'doctor') {
          const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
          if (doctorQuery.empty) {
            return res.status(404).json({ success: false, message: 'Doctor profile not found for this user' });
          }
          expectedId = doctorQuery.docs[0].data().doctorId;
        } else if (message.sender === 'patient') {
          const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
          if (patientQuery.empty) {
            return res.status(404).json({ success: false, message: 'Patient profile not found for this user' });
          }
          expectedId = patientQuery.docs[0].data().patientId;
        }

        if ((message.sender === 'doctor' && doctorId !== expectedId) || (message.sender === 'patient' && patientId !== expectedId)) {
          return res.status(403).json({ success: false, message: `You are not authorized to send messages as this ${message.sender}` });
        }

        const assignmentQuery = await db.collection('doctor_assignments')
          .where('patientId', '==', patientId)
          .where('doctorId', '==', doctorId)
          .get();
        if (assignmentQuery.empty) {
          return res.status(404).json({ success: false, message: 'No chat assignment found' });
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

        if (append) {
          chatData.messages.push(newMessage);
        } else {
          chatData.messages = [newMessage];
        }

        await uploadWithRetry(chatFile, JSON.stringify(chatData), { contentType: 'application/json' });

        await pusher.trigger(`chat-${patientId}-${doctorId}`, 'new-message', newMessage);
        console.log(`Pusher event 'new-message' triggered on channel chat-${patientId}-${doctorId}`);

        return res.status(200).json({ success: true, message: 'Message saved successfully', newMessage });
      } catch (error) {
        console.error(`Error saving message for chat between patient ${patientId} and doctor ${doctorId}:`, error.message);
        return res.status(500).json({ success: false, message: 'Failed to save message', details: error.message });
      }
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /chats/${patientId}/${doctorId}` });
  }
};

// Handler for missed dose alerts
const handleMissedDoseAlertsRequest = async (req, res, patientId, doctorId, userId) => {
  if (req.method === 'GET') {
    try {
      const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
      if (doctorQuery.empty) {
        return res.status(404).json({ success: false, message: 'Doctor profile not found for this user' });
      }
      const doctorData = doctorQuery.docs[0].data();
      if (doctorData.doctorId !== doctorId) {
        return res.status(403).json({ success: false, message: 'You are not authorized to access alerts for this doctor' });
      }

      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ success: false, message: 'No assignment found for this patient and doctor' });
      }

      const alertsQuery = await db.collection('missed_dose_alerts')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();

      const alerts = alertsQuery.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      console.log(`Fetched ${alerts.length} missed dose alerts for patient ${patientId} and doctor ${doctorId}`);
      return res.status(200).json({ success: true, alerts });
    } catch (error) {
      console.error(`Error fetching missed dose alerts for patient ${patientId} and doctor ${doctorId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to fetch missed dose alerts', details: error.message });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /missed-doses/${patientId}/${doctorId}` });
  }
};

// Handler for admin notifications
const handleAdminNotifyRequest = async (req, res, userId) => {
  console.log('handleAdminNotifyRequest called with method:', req.method); // Debug log
  if (req.method === 'POST') {
    try {
      console.log('Received body:', req.body); // Debug log
      const { patientId, doctorId, message } = req.body;

      if (!patientId || !doctorId || !message) {
        return res.status(400).json({ success: false, message: 'patientId, doctorId, and message are required' });
      }

      // Verify the user is authorized (either patient or doctor)
      const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
      const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
      let isAuthorized = false;

      if (!patientQuery.empty && patientQuery.docs[0].data().patientId === patientId) {
        isAuthorized = true;
      } else if (!doctorQuery.empty && doctorQuery.docs[0].data().doctorId === doctorId) {
        isAuthorized = true;
      }

      if (!isAuthorized) {
        return res.status(403).json({ success: false, message: 'You are not authorized to send this notification' });
      }

      // Store the notification in Firestore
      const notificationRef = db.collection('notifications').doc();
      await notificationRef.set({
        patientId,
        doctorId,
        message,
        timestamp: new Date().toISOString(),
        userId,
      });

      // Trigger Pusher event to notify the doctor
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'admin-notification', {
        id: notificationRef.id,
        patientId,
        doctorId,
        message,
        timestamp: new Date().toISOString(),
      });

      console.log(`Admin notification sent for patient ${patientId} and doctor ${doctorId}`);
      return res.status(200).json({ success: true, message: 'Notification sent successfully' });
    } catch (error) {
      console.error(`Error sending admin notification for user ${userId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to send notification', details: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /admin/notify` });
  }
};

// Handler for accepting a patient
const handleAcceptPatientRequest = async (req, res, userId) => {
  if (req.method === 'POST') {
    try {
      const { doctorId, patientId, accept } = req.body;

      if (!doctorId || !patientId || typeof accept !== 'boolean') {
        return res.status(400).json({ success: false, message: 'doctorId, patientId, and accept (boolean) are required' });
      }

      // Verify the user is the doctor
      const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
      if (doctorQuery.empty) {
        return res.status(404).json({ success: false, message: 'Doctor profile not found for this user' });
      }
      const doctorData = doctorQuery.docs[0].data();
      if (doctorData.doctorId !== doctorId) {
        return res.status(403).json({ success: false, message: 'You are not authorized to perform this action as this doctor' });
      }

      // Check if the patient is assigned to this doctor
      const assignmentQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .where('doctorId', '==', doctorId)
        .get();
      if (assignmentQuery.empty) {
        return res.status(404).json({ success: false, message: 'No assignment found for this patient and doctor' });
      }

      // Update the acceptance status in Firestore
      const acceptedRef = db.collection('doctor_accepted_patients').doc(doctorId);
      const acceptedDoc = await acceptedRef.get();
      let acceptedPatients = {};

      if (acceptedDoc.exists()) {
        acceptedPatients = acceptedDoc.data().accepted || {};
      }

      acceptedPatients[patientId] = accept;

      await acceptedRef.set({
        accepted: acceptedPatients,
      }, { merge: true });

      console.log(`Doctor ${doctorId} ${accept ? 'accepted' : 'rejected'} patient ${patientId}`);
      return res.status(200).json({ success: true, message: `Patient ${accept ? 'accepted' : 'rejected'} successfully` });
    } catch (error) {
      console.error(`Error in /admin/accept-patient for user ${userId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to process accept-patient request', details: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /admin/accept-patient` });
  }
};

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const userId = req.headers['x-user-uid'];
  const authHeader = req.headers['authorization'];

  if (!userId || !authHeader) {
    console.error('Missing authentication headers:', { userId, authHeader });
    return res.status(401).json({ success: false, message: 'Authentication headers missing' });
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.uid !== userId) {
      console.error('User ID mismatch:', { tokenUid: decodedToken.uid, headerUid: userId });
      return res.status(403).json({ success: false, message: 'Unauthorized: Token does not match user' });
    }

    const { patientId, doctorId } = req.query;

    if (req.url.includes('/missed-doses')) {
      if (!patientId || !doctorId) {
        return res.status(400).json({ success: false, message: 'patientId and doctorId are required' });
      }
      return handleMissedDoseAlertsRequest(req, res, patientId, doctorId, userId);
    } else if (req.url.includes('/notify')) {
      return handleAdminNotifyRequest(req, res, userId);
    } else if (req.url.includes('/accept-patient')) {
      return handleAcceptPatientRequest(req, res, userId);
    } else {
      if (!patientId || !doctorId) {
        return res.status(400).json({ success: false, message: 'patientId and doctorId are required' });
      }
      return handleChatRequest(req, res, patientId, doctorId, userId);
    }
  } catch (error) {
    console.error(`Error in api/admin/index.js (${req.method}) for user ${userId}:`, error.message);
    if (error.message === 'Invalid sender type') {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: 'Failed to process request', details: error.message });
  }
}