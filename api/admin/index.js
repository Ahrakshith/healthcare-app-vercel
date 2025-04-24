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
const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY, 'base64').toString())
  : JSON.parse(await import('fs').then(fs => fs.promises.readFile('./service-account.json', 'utf8')));
const storage = new Storage({ credentials: serviceAccountKeyPath });
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: 'ap2',
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

// Validate request body for POST
const validatePostBody = ({ patientId, doctorId }) => {
  if (!patientId || !doctorId) {
    throw new Error('patientId and doctorId are required');
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
    return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
  }

  try {
    if (req.method === 'GET') {
      const [files] = await bucket.getFiles({ prefix: 'admin_notifications/' });
      const notifications = await Promise.all(
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
      const filteredNotifications = notifications.filter((n) => n !== null && n !== undefined);
      console.log(`Fetched ${filteredNotifications.length} admin notifications`);
      return res.status(200).json(filteredNotifications);
    } else if (req.method === 'POST') {
      validatePostBody(req.body);

      const { patientName, age, sex, description, disease, medicine, patientId, doctorId } = req.body;
      const notificationId = `${Date.now()}`;
      const notificationData = {
        patientName: patientName || 'Unknown',
        age: age ? parseInt(age, 10) : null,
        sex: sex || 'N/A',
        description: description || 'N/A',
        disease: disease || 'N/A',
        medicine: medicine || null,
        patientId,
        doctorId,
        createdAt: new Date().toISOString(),
      };

      const notificationFile = bucket.file(`admin_notifications/${notificationId}.json`);
      await uploadWithRetry(notificationFile, JSON.stringify(notificationData), { contentType: 'application/json' });
      console.log(`Notification ${notificationId} saved to GCS`);

      // Emit to Pusher for real-time updates
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'missedDoseAlert', notificationData);

      // Save to Firestore for redundancy
      await db.collection('admin_notifications').doc(notificationId).set(notificationData);

      return res.status(200).json({ message: 'Notification saved', notificationId });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  } catch (error) {
    console.error(`Error in /api/admin (${req.method}):`, error.message);
    if (error.message === 'patientId and doctorId are required') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}