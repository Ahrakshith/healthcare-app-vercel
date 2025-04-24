import admin from 'firebase-admin';
import Pusher from 'pusher';

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
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message);
    throw new Error(`Firebase Admin initialization failed: ${error.message}`);
  }
}

const db = admin.firestore();

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
  });
  console.log('Pusher initialized successfully');
} catch (error) {
  console.error('Pusher initialization failed:', error.message);
  throw new Error(`Pusher initialization failed: ${error.message}`);
}

// Retry logic for Firestore operations
async function operationWithRetry(operation, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`Retry ${attempt}/${retries} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "doctors"
  const param = pathSegments[2]; // e.g., [id], "by-specialty"
  const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

  try {
    if (endpoint === 'doctors' && !param) {
      // Fetch all doctors from Firestore
      const doctorsSnapshot = await operationWithRetry(() => db.collection('doctors').get());
      if (doctorsSnapshot.empty) {
        console.warn('No doctors found in Firestore');
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = doctorsSnapshot.docs.map(doc => ({
        id: doc.id,
        doctorId: doc.data().doctorId || doc.id,
        ...doc.data(),
      }));

      return res.status(200).json({ doctors: doctorList });
    } else if (endpoint === 'doctors' && param && param !== 'by-specialty') {
      // Fetch a specific doctor by ID from Firestore
      const doctorDoc = await operationWithRetry(() => db.collection('doctors').doc(param).get());
      if (!doctorDoc.exists) {
        return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
      }

      return res.status(200).json({ id: doctorDoc.id, doctorId: doctorDoc.data().doctorId || doctorDoc.id, ...doctorDoc.data() });
    } else if (endpoint === 'doctors' && param === 'by-specialty' && specialty) {
      // Fetch doctors by specialty from Firestore
      const doctorsSnapshot = await operationWithRetry(() =>
        db.collection('doctors').where('specialty', '==', specialty).get()
      );
      if (doctorsSnapshot.empty) {
        console.warn(`No doctors found with specialty: ${specialty}`);
        return res.status(404).json({ error: { code: 404, message: `No doctors found with specialty: ${specialty}` } });
      }

      const doctorList = doctorsSnapshot.docs.map(doc => ({
        id: doc.id,
        doctorId: doc.data().doctorId || doc.id,
        ...doc.data(),
      }));

      return res.status(200).json({ doctors: doctorList });
    } else {
      return res.status(404).json({ error: { code: 404, message: 'Endpoint not found', details: `Method: ${req.method}, Path: /${pathSegments.join('/')}` } });
    }
  } catch (error) {
    console.error(`Error in /api/doctors${param ? `/${param}${specialty ? `/${specialty}` : ''}` : ''}: ${error.message}`);
    return res.status(500).json({ error: { code: 500, message: 'A server error has occurred', details: error.message } });
  }
}