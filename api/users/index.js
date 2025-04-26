import admin from 'firebase-admin';
import Pusher from 'pusher';

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !privateKey ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY_ID ||
      !process.env.FIREBASE_CLIENT_ID ||
      !process.env.FIREBASE_CLIENT_CERT_URL
    ) {
      throw new Error('Missing Firebase credentials');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
        clientId: process.env.FIREBASE_CLIENT_ID,
        clientCertUrl: process.env.FIREBASE_CLIENT_CERT_URL,
      }),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

// Initialize Pusher (optional, remove if not needed)
let pusher;
try {
  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
    console.warn('Pusher credentials missing, skipping initialization');
  } else {
    pusher = new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
    });
    console.log('Pusher initialized successfully');
  }
} catch (error) {
  console.error('Pusher initialization failed:', error.message);
}

// Retry logic
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

// Generate unique ID (for doctorId or patientId)
async function generateUniqueId(collectionName, fieldName) {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let generatedId = '';
  const collectionRef = db.collection(collectionName);

  while (true) {
    generatedId = '';
    for (let i = 0; i < 6; i++) {
      generatedId += characters[Math.floor(Math.random() * characters.length)];
    }
    const snapshot = await operationWithRetry(() =>
      collectionRef.where(fieldName, '==', generatedId).get()
    );
    if (snapshot.empty) break;
    console.log(`Generated ${fieldName} ${generatedId} already exists, regenerating...`);
  }
  return generatedId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
  }

  const adminId = req.headers['x-user-uid'];
  if (!adminId) {
    return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing x-user-uid header' } });
  }

  try {
    // Verify admin role
    const userDoc = await operationWithRetry(() => db.collection('users').doc(adminId).get());
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ error: { code: 403, message: 'Forbidden: Only admins can perform this action' } });
    }

    const { role, email, password, name, age, sex, experience, specialty, qualification, address, contactNumber } = req.body;

    // Validate role
    if (!['doctor', 'patient', 'admin'].includes(role)) {
      return res.status(400).json({ error: { code: 400, message: 'Invalid role specified' } });
    }

    // Common validations
    if (!email || !password) {
      return res.status(400).json({ error: { code: 400, message: 'Email and password are required' } });
    }
    if (!email.endsWith('@gmail.com')) {
      return res.status(400).json({ error: { code: 400, message: 'Email must be a valid Gmail address' } });
    }

    // Role-specific validations
    let userData = { email, role, createdAt: new Date().toISOString() };
    let collectionName, idField, uniqueId;

    if (role === 'doctor') {
      if (!name || !age || !sex || !experience || !specialty || !qualification || !address || !contactNumber) {
        return res.status(400).json({ error: { code: 400, message: 'Missing required doctor fields' } });
      }
      if (isNaN(age) || age <= 0) {
        return res.status(400).json({ error: { code: 400, message: 'Invalid age' } });
      }
      if (isNaN(experience) || experience < 0) {
        return res.status(400).json({ error: { code: 400, message: 'Invalid experience' } });
      }
      if (!/^\d{10}$/.test(contactNumber)) {
        return res.status(400).json({ error: { code: 400, message: 'Invalid 10-digit contact number' } });
      }

      uniqueId = await generateUniqueId('doctors', 'doctorId');
      userData = {
        ...userData,
        name,
        age: parseInt(age),
        sex,
        experience: parseInt(experience),
        specialty,
        doctorId: uniqueId,
        qualification,
        address,
        contactNumber,
      };
      collectionName = 'doctors';
      idField = 'doctorId';
    } else if (role === 'patient') {
      if (!name || !age || !sex || !address) {
        return res.status(400).json({ error: { code: 400, message: 'Missing required patient fields' } });
      }
      if (isNaN(age) || age <= 0) {
        return res.status(400).json({ error: { code: 400, message: 'Invalid age' } });
      }

      uniqueId = await generateUniqueId('patients', 'patientId');
      userData = {
        ...userData,
        name,
        age: parseInt(age),
        sex,
        patientId: uniqueId,
        address,
      };
      collectionName = 'patients';
      idField = 'patientId';
    } else if (role === 'admin') {
      userData = { ...userData };
      collectionName = null;
      idField = null;
    }

    // Create user in Firebase Authentication
    const userRecord = await admin.auth().createUser({ email, password, displayName: name || email });
    const uid = userRecord.uid;
    userData.uid = uid;

    // Store in Firestore 'users' collection
    await operationWithRetry(() => db.collection('users').doc(uid).set(userData));

    // Store in role-specific collection (if applicable)
    if (collectionName && idField) {
      await operationWithRetry(() => db.collection(collectionName).doc(uniqueId).set(userData));
    }

    // Trigger Pusher event (optional)
    if (pusher && role === 'doctor') {
      pusher.trigger('admin-channel', 'doctor-added', { [idField]: uniqueId, name: name || email });
    }

    return res.status(201).json({ message: `${role.charAt(0).toUpperCase() + role.slice(1)} added successfully`, uid, ...(idField ? { [idField]: uniqueId } : {}) });
  } catch (error) {
    console.error(`Error in /api/users: ${error.message}`);
    if (error.code === 'auth/email-already-in-use') {
      return res.status(409).json({ error: { code: 409, message: 'This email is already registered' } });
    } else if (error.code === 'auth/invalid-email') {
      return res.status(400).json({ error: { code: 400, message: 'Invalid email address' } });
    } else if (error.code === 'auth/weak-password') {
      return res.status(400).json({ error: { code: 400, message: 'Password should be at least 6 characters long' } });
    }
    return res.status(500).json({ error: { code: 500, message: 'Server error', details: error.message } });
  }
}