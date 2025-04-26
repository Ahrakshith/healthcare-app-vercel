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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const adminId = req.headers['x-user-uid'];

  // Only check authentication for POST requests (admin-only action)
  if (req.method === 'POST' && !adminId) {
    return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing x-user-uid header' } });
  }

  try {
    if (req.method === 'GET') {
      // Allow both admins and patients to fetch doctors
      const pathSegments = req.url.split('/').filter(Boolean);
      const endpoint = pathSegments[1]; // "doctors"
      const param = pathSegments[2]; // e.g., [id], "by-specialty"
      const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

      if (endpoint === 'doctors' && !param) {
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
        const doctorDoc = await operationWithRetry(() => db.collection('doctors').doc(param).get());
        if (!doctorDoc.exists) {
          return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
        }

        return res.status(200).json({ id: doctorDoc.id, doctorId: doctorDoc.data().doctorId || doctorDoc.id, ...doctorDoc.data() });
      } else if (endpoint === 'doctors' && param === 'by-specialty' && specialty) {
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
    } else if (req.method === 'POST') {
      // Verify admin role for POST requests only
      if (!adminId) {
        return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing x-user-uid header' } });
      }
      const userDoc = await operationWithRetry(() => db.collection('users').doc(adminId).get());
      if (!userDoc.exists || userDoc.data().role !== 'admin') {
        return res.status(403).json({ error: { code: 403, message: 'Forbidden: Only admins can perform this action' } });
      }

      const { email, password, name, age, sex, experience, specialty, qualification, address, contactNumber } = req.body;

      // Validate inputs
      if (!email || !password || !name || !age || !sex || !experience || !specialty || !qualification || !address || !contactNumber) {
        return res.status(400).json({ error: { code: 400, message: 'Missing required fields' } });
      }

      if (!email.endsWith('@gmail.com')) {
        return res.status(400).json({ error: { code: 400, message: 'Email must be a valid Gmail address (e.g., example@gmail.com)' } });
      }

      if (isNaN(age) || age <= 0) {
        return res.status(400).json({ error: { code: 400, message: 'Please enter a valid age' } });
      }

      if (isNaN(experience) || experience < 0) {
        return res.status(400).json({ error: { code: 400, message: 'Please enter a valid experience (in years)' } });
      }

      if (!/^\d{10}$/.test(contactNumber)) {
        return res.status(400).json({ error: { code: 400, message: 'Please enter a valid 10-digit contact number' } });
      }

      // Generate unique doctorId
      let doctorId;
      const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const doctorIdsRef = db.collection('doctors');
      do {
        doctorId = '';
        for (let i = 0; i < 6; i++) {
          const randomIndex = Math.floor(Math.random() * characters.length);
          doctorId += characters[randomIndex];
        }
        const q = query(doctorIdsRef, where('doctorId', '==', doctorId));
        const querySnapshot = await operationWithRetry(() => getDocs(q));
        if (querySnapshot.empty) break;
        console.log(`Generated doctorId ${doctorId} already exists, regenerating...`);
      } while (true);

      // Create doctor user via Firebase Auth
      const userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: name,
      });
      const doctorUid = userRecord.uid;

      // Store doctor data in Firestore
      const doctorData = {
        uid: doctorUid,
        email,
        name,
        age: parseInt(age),
        sex,
        experience: parseInt(experience),
        specialty,
        doctorId,
        qualification,
        address,
        contactNumber,
        createdAt: new Date().toISOString(),
        role: 'doctor',
      };

      await operationWithRetry(() => db.collection('users').doc(doctorUid).set(doctorData));
      await operationWithRetry(() => db.collection('doctors').doc(doctorId).set(doctorData));

      // Trigger Pusher event (optional)
      pusher.trigger('admin-channel', 'doctor-added', { doctorId, name });

      return res.status(201).json({ message: 'Doctor added successfully', uid: doctorUid, doctorId });
    } else {
      return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
    }
  } catch (error) {
    console.error(`Error in /api/doctors: ${error.message}`);
    if (error.code === 'auth/email-already-in-use') {
      return res.status(409).json({ error: { code: 409, message: 'This email is already registered' } });
    } else if (error.code === 'auth/invalid-email') {
      return res.status(400).json({ error: { code: 400, message: 'Please enter a valid Gmail address' } });
    } else if (error.code === 'auth/weak-password') {
      return res.status(400).json({ error: { code: 400, message: 'Password should be at least 6 characters long' } });
    }
    return res.status(500).json({ error: { code: 500, message: 'A server error has occurred', details: error.message } });
  }
}