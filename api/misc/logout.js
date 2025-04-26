// api/misc/logout.js
import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';

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
const messaging = admin.messaging();

// Initialize GCS
const storage = new Storage({
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
});
const bucketName = 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

// Utility for GCS upload with retry
async function uploadWithRetry(file, buffer, metadata, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      return true;
    } catch (error) {
      console.error(`Upload attempt ${attempt} failed for ${file.name}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff * Math.pow(2, attempt - 1)));
    }
  }
}

// Parse multipart/form-data without multer
async function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = buffer.toString().split(`--${boundary}`);

      const filePart = parts.find((part) => part.includes('Content-Disposition: form-data; name="image"'));
      if (!filePart) return resolve(null);

      const fileMatch = filePart.match(/filename="(.+)"[\s\S]+Content-Type: ([\w\/]+)[\s\S]+?\r\n\r\n([\s\S]+?)\r\n--/);
      if (!fileMatch) return resolve(null);

      const [, filename, mimeType, fileContent] = fileMatch;
      const fileBuffer = Buffer.from(fileContent, 'binary');

      if (!['image/jpeg', 'image/png', 'image/gif'].includes(mimeType)) {
        return reject(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
      }
      if (fileBuffer.length > 5 * 1024 * 1024) {
        return reject(new Error('File too large. Maximum size is 5MB.'));
      }

      resolve({ buffer: fileBuffer, filename, mimeType });
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "misc"
  const subEndpoint = pathSegments[2]; // "logout", "notify-missed-dose", or "uploadImage"
  const patientId = pathSegments[3]; // [patientId] for uploadImage

  const userId = req.headers['x-user-uid'];
  if (!userId) {
    return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
  }

  try {
    if (endpoint !== 'misc') {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    if (subEndpoint === 'logout') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed' });
      }

      // Revoke all refresh tokens for the user
      await admin.auth().revokeRefreshTokens(userId);
      console.log(`Revoked refresh tokens for user ${userId}`);

      // Optionally, clear any session data in Firestore if needed
      await db.collection('users').doc(userId).update({
        lastLogout: new Date().toISOString(),
      });

      return res.status(200).json({ message: 'Logged out successfully' });
    }

    if (subEndpoint === 'notify-missed-dose') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed' });
      }

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
        } else {
          await db.collection('admin_notifications').doc(notificationId).set(notificationData);
        }
      } else {
        await db.collection('admin_notifications').doc(notificationId).set(notificationData);
      }

      return res.status(200).json({ message: 'Missed dose notification sent', notificationId });
    }

    if (subEndpoint === 'uploadImage' && patientId) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const fileData = await parseFormData(req);
      if (!fileData) {
        return res.status(400).json({ error: 'No image file uploaded' });
      }

      const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
      if (patientQuery.empty || patientQuery.docs[0].data().patientId !== patientId) {
        return res.status(403).json({ error: 'You are not authorized to upload images for this patient' });
      }

      const fileName = `images/${patientId}/${Date.now()}_${fileData.filename}`;
      const blob = bucket.file(fileName);

      try {
        await uploadWithRetry(blob, fileData.buffer, { contentType: fileData.mimeType });
        await blob.makePublic();
        const imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
        return res.status(200).json({ imageUrl });
      } catch (error) {
        console.error(`GCS upload failed for ${fileName}: ${error.message}`);
        return res.status(500).json({ error: 'Failed to upload image to GCS', details: error.message });
      }
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/misc/${subEndpoint || 'unknown'}: ${error.message}`);
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}