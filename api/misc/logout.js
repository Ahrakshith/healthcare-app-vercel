import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';
import multer from 'multer';
import path from 'path';

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
const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY, 'base64').toString())
  : JSON.parse(await import('fs').then(fs => fs.promises.readFile('./service-account.json', 'utf8')));
const storage = new Storage({ credentials: serviceAccountKeyPath });
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

// Configure Multer for image uploads
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!validTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
    cb(null, true);
  },
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

// Local storage fallback (for Vercel, we'll avoid using local file system)
const localStorageDir = path.join(process.cwd(), 'temp_images');
const ensureLocalDir = async (dir) => {
  // In Vercel, the file system is read-only except for /tmp
  const tempDir = '/tmp/temp_images';
  try {
    const fs = await import('fs').then(fs => fs.promises);
    if (!(await fs.stat(tempDir).catch(() => false))) {
      await fs.mkdir(tempDir, { recursive: true });
    }
    return tempDir;
  } catch (error) {
    console.error('Error creating local directory:', error.message);
    throw error;
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

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
      // Handle /api/misc/logout (POST)
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed' });
      }

      // In a real app, you might revoke tokens or clear session data
      return res.status(200).json({ message: 'Logged out successfully' });
    } else if (subEndpoint === 'notify-missed-dose') {
      // Handle /api/misc/notify-missed-dose (POST)
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
    } else if (subEndpoint === 'uploadImage' && patientId) {
      // Handle /api/misc/uploadImage/[patientId] (POST)
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const multerMiddleware = uploadImage.single('image');
      return await new Promise((resolve) => {
        multerMiddleware(req, res, async (err) => {
          if (err) {
            console.error('Multer error:', err.message);
            return resolve(res.status(400).json({ error: err.message }));
          }

          try {
            if (!req.file) {
              return resolve(res.status(400).json({ error: 'No image file uploaded' }));
            }

            const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
            if (patientQuery.empty || patientQuery.docs[0].data().patientId !== patientId) {
              return resolve(res.status(403).json({ error: 'You are not authorized to upload images for this patient' }));
            }

            const fileName = `images/${patientId}/${Date.now()}_${req.file.originalname}`;
            const blob = bucket.file(fileName);

            try {
              await uploadWithRetry(blob, req.file.buffer, { contentType: req.file.mimetype });
              await blob.makePublic();
              const imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
              return resolve(res.status(200).json({ imageUrl }));
            } catch (uploadError) {
              // Fallback to local storage (for Vercel, use /tmp)
              const localDir = await ensureLocalDir(path.join('temp_images', patientId));
              const localPath = path.join(localDir, `${Date.now()}_${req.file.originalname}`);
              const fs = await import('fs').then(fs => fs.promises);
              await fs.writeFile(localPath, req.file.buffer);
              const localUrl = `/temp_images/${patientId}/${path.basename(localPath)}`;
              return resolve(res.status(200).json({ imageUrl: localUrl, warning: 'Image stored locally due to GCS failure' }));
            }
          } catch (error) {
            console.error('Error in /api/misc/uploadImage:', error.message);
            if (error.message.includes('Invalid file type')) {
              return resolve(res.status(400).json({ error: error.message }));
            }
            if (error.code === 'LIMIT_FILE_SIZE') {
              return resolve(res.status(400).json({ error: 'File too large. Maximum size is 5MB.' }));
            }
            return resolve(res.status(500).json({ error: 'Failed to upload image', details: error.message }));
          }
        });
      });
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/misc/${subEndpoint || 'unknown'}:`, error.message);
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}