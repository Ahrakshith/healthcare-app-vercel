import admin from 'firebase-admin';
import Pusher from 'pusher';
import { Storage } from '@google-cloud/storage';
import busboy from 'busboy';
//import end

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

// Utility function for GCS delete with retry logic
const deleteWithRetry = async (fileOrDir, retries = 3, backoff = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fileOrDir.delete();
      console.log(`Successfully deleted ${fileOrDir.name} from GCS on attempt ${attempt}`);
      return true;
    } catch (error) {
      console.error(`Delete attempt ${attempt} failed for ${fileOrDir.name}:`, error.message);
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
  console.log(`[DEBUG] Entering handleAdminNotifyRequest with method: ${req.method}, URL: ${req.url}`);
  console.log(`[DEBUG] Request headers: ${JSON.stringify(req.headers)}`);

  if (req.method.toUpperCase() === 'POST') {
    try {
      console.log(`[DEBUG] Request body: ${JSON.stringify(req.body)}`);
      const { patientId, doctorId, message } = req.body;

      if (!patientId || !doctorId || !message) {
        console.log(`[DEBUG] Missing required fields: patientId=${patientId}, doctorId=${doctorId}, message=${message}`);
        return res.status(400).json({ success: false, message: 'patientId, doctorId, and message are required' });
      }

      // Verify the user is authorized (either patient or doctor)
      const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
      const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
      let isAuthorized = false;

      if (!patientQuery.empty && patientQuery.docs[0].data().patientId === patientId) {
        isAuthorized = true;
        console.log(`[DEBUG] User ${userId} authorized as patient ${patientId}`);
      } else if (!doctorQuery.empty && doctorQuery.docs[0].data().doctorId === doctorId) {
        isAuthorized = true;
        console.log(`[DEBUG] User ${userId} authorized as doctor ${doctorId}`);
      }

      if (!isAuthorized) {
        console.log(`[DEBUG] User ${userId} not authorized for patient ${patientId} or doctor ${doctorId}`);
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
      console.log(`[DEBUG] Notification stored in Firestore with ID: ${notificationRef.id}`);

      // Trigger Pusher event to notify the doctor
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'admin-notification', {
        id: notificationRef.id,
        patientId,
        doctorId,
        message,
        timestamp: new Date().toISOString(),
      });
      console.log(`[DEBUG] Pusher event triggered for channel chat-${patientId}-${doctorId}`);

      console.log(`Admin notification sent for patient ${patientId} and doctor ${doctorId}`);
      return res.status(200).json({ success: true, message: 'Notification sent successfully' });
    } catch (error) {
      console.error(`Error sending admin notification for user ${userId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to send notification', details: error.message });
    }
  } else {
    console.log(`[DEBUG] Method ${req.method} not allowed for /admin/notify`);
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

// Handler for deleting a doctor
const handleDeleteDoctorRequest = async (req, res, userId) => {
  if (req.method === 'POST') {
    try {
      const { doctorId } = req.body;

      if (!doctorId) {
        return res.status(400).json({ success: false, message: 'doctorId is required' });
      }

      // Verify the user is an admin
      const adminQuery = await db.collection('users').where('uid', '==', userId).get();
      if (adminQuery.empty || adminQuery.docs[0].data().role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only admins can delete doctors' });
      }

      // Check if the doctor exists
      const doctorQuery = await db.collection('doctors').where('doctorId', '==', doctorId).get();
      if (doctorQuery.empty) {
        return res.status(404).json({ success: false, message: 'Doctor not found' });
      }

      const doctorDoc = doctorQuery.docs[0];
      const doctorData = doctorDoc.data();

      // Delete doctor from Firestore
      await doctorDoc.ref.delete();
      console.log(`Doctor ${doctorId} deleted from Firestore`);

      // Clean up associated GCS data (e.g., chat files)
      const chatFiles = await bucket.getFiles({ prefix: `chats/-${doctorId}` });
      for (const [files] of chatFiles) {
        await Promise.all(files.map((file) => deleteWithRetry(file)));
      }
      console.log(`Deleted GCS chat files for doctor ${doctorId}`);

      return res.status(200).json({ success: true, message: 'Doctor deleted successfully' });
    } catch (error) {
      console.error(`Error deleting doctor ${doctorId} for user ${userId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to delete doctor', details: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /admin/delete-doctor` });
  }
};

// Handler for deleting a patient
const handleDeletePatientRequest = async (req, res, userId) => {
  if (req.method === 'POST') {
    try {
      const { patientId } = req.body;

      if (!patientId) {
        return res.status(400).json({ success: false, message: 'patientId is required' });
      }

      // Verify the user is an admin
      const adminQuery = await db.collection('users').where('uid', '==', userId).get();
      if (adminQuery.empty || adminQuery.docs[0].data().role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only admins can delete patients' });
      }

      // Check if the patient exists
      const patientQuery = await db.collection('patients').where('patientId', '==', patientId).get();
      if (patientQuery.empty) {
        return res.status(404).json({ success: false, message: 'Patient not found' });
      }

      const patientDoc = patientQuery.docs[0];

      // Delete patient from Firestore
      await patientDoc.ref.delete();
      console.log(`Patient ${patientId} deleted from Firestore`);

      // Clean up associated GCS data (e.g., chat files)
      const chatFiles = await bucket.getFiles({ prefix: `chats/${patientId}-` });
      for (const [files] of chatFiles) {
        await Promise.all(files.map((file) => deleteWithRetry(file)));
      }
      console.log(`Deleted GCS chat files for patient ${patientId}`);

      // Remove any assignments related to this patient
      const assignmentsQuery = await db.collection('doctor_assignments')
        .where('patientId', '==', patientId)
        .get();
      await Promise.all(assignmentsQuery.docs.map((doc) => doc.ref.delete()));
      console.log(`Deleted assignments for patient ${patientId}`);

      return res.status(200).json({ success: true, message: 'Patient deleted successfully' });
    } catch (error) {
      console.error(`Error deleting patient ${patientId} for user ${userId}:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to delete patient', details: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed for /admin/delete-patient` });
  }
};

// Main handler
export default async function handler(req, res) {
  console.log(`[DEBUG] Main handler called with method: ${req.method}, URL: ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    console.log('[DEBUG] Handling OPTIONS request');
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
      console.log('[DEBUG] Routing to handleMissedDoseAlertsRequest');
      if (!patientId || !doctorId) {
        return res.status(400).json({ success: false, message: 'patientId and doctorId are required' });
      }
      return handleMissedDoseAlertsRequest(req, res, patientId, doctorId, userId);
    } else if (req.url.includes('/notify')) {
      console.log('[DEBUG] Routing to handleAdminNotifyRequest');
      return handleAdminNotifyRequest(req, res, userId);
    } else if (req.url.includes('/accept-patient')) {
      console.log('[DEBUG] Routing to handleAcceptPatientRequest');
      return handleAcceptPatientRequest(req, res, userId);
    } else if (req.url.includes('/delete-doctor')) {
      console.log('[DEBUG] Routing to handleDeleteDoctorRequest');
      return handleDeleteDoctorRequest(req, res, userId);
    } else if (req.url.includes('/delete-patient')) {
      console.log('[DEBUG] Routing to handleDeletePatientRequest');
      return handleDeletePatientRequest(req, res, userId);
    } else {
      console.log('[DEBUG] Routing to handleChatRequest');
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