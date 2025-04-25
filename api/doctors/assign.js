import admin from 'firebase-admin';
import Pusher from 'pusher';

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !privateKey || !process.env.FIREBASE_CLIENT_EMAIL) {
      throw new Error('Missing Firebase credentials');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized successfully in assign.js');
  } catch (error) {
    console.error('Firebase Admin initialization failed in assign.js:', error.message, error.stack);
    throw error;
  }
}

const db = admin.firestore();

// Initialize Pusher
let pusher;
try {
  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
    console.warn('Missing Pusher credentials, Pusher will be disabled');
  } else {
    pusher = new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS: true,
    });
    console.log('Pusher initialized successfully in assign.js');
  }
} catch (error) {
  console.error('Pusher initialization failed in assign.js:', error.message, error.stack);
}

// Retry logic
async function operationWithRetry(operation, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Retry ${attempt}/${retries} failed:`, error.message, error.stack);
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
    }
  }
}

// Role validation middleware
async function checkRole(requiredRole, req, res, next) {
  const userId = req.headers['x-user-uid'];
  if (!userId) {
    return res.status(400).json({ error: { code: 400, message: 'Firebase UID is required in x-user-uid header' } });
  }

  try {
    const userDoc = await operationWithRetry(() => db.collection('users').doc(userId).get());
    if (!userDoc.exists) {
      return res.status(404).json({ error: { code: 404, message: 'User not found' } });
    }

    const userData = userDoc.data();
    if (userData.role !== requiredRole) {
      return res.status(403).json({ error: { code: 403, message: `Access denied. Required role: ${requiredRole}, User role: ${userData.role}` } });
    }

    if (requiredRole === 'patient') {
      const patientQuery = await operationWithRetry(() => db.collection('patients').where('uid', '==', userId).get());
      if (patientQuery.empty) {
        return res.status(404).json({ error: { code: 404, message: 'Patient profile not found for this user' } });
      }
      req.patientId = patientQuery.docs[0].data().patientId;
    }

    next();
  } catch (error) {
    console.error(`Role check failed for UID ${userId}:`, error.message, error.stack);
    return res.status(500).json({ error: { code: 500, message: 'Role check failed', details: error.message } });
  }
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

  await checkRole('patient', req, res, async () => {
    try {
      const { patientId, doctorId } = req.body;
      const userId = req.headers['x-user-uid'];

      if (!patientId || !doctorId || typeof patientId !== 'string' || typeof doctorId !== 'string') {
        return res.status(400).json({ error: { code: 400, message: 'patientId and doctorId must be non-empty strings' } });
      }

      if (req.patientId !== patientId.trim()) {
        return res.status(403).json({ error: { code: 403, message: 'You are not authorized to assign this patient' } });
      }

      const doctorQuery = await operationWithRetry(() =>
        db.collection('doctors').where('doctorId', '==', doctorId.trim()).get()
      );
      if (doctorQuery.empty) {
        return res.status(404).json({ error: { code: 404, message: `Doctor not found with doctorId: ${doctorId}` } });
      }

      const patientDoc = await operationWithRetry(() =>
        db.collection('patients').doc(patientId.trim()).get()
      );
      if (!patientDoc.exists) {
        return res.status(404).json({ error: { code: 404, message: `Patient not found with patientId: ${patientId}` } });
      }

      const patientData = patientDoc.data();
      const assignmentData = {
        patientId: patientId.trim(),
        doctorId: doctorId.trim(),
        timestamp: new Date().toISOString(),
        patientName: patientData.name || `Patient ${patientId}`,
        age: patientData.age || null,
        sex: patientData.sex || null,
      };

      const assignmentId = `${patientId.trim()}_${doctorId.trim()}`;
      await operationWithRetry(() =>
        db.collection('doctor_assignments').doc(assignmentId).set(assignmentData, { merge: true })
      );
      console.log(`Successfully saved assignment ${assignmentId}:`, assignmentData);

      if (pusher) {
        const channel = `private-patient-${patientId.trim()}`;
        await pusher.trigger(channel, 'assignmentUpdated', {
          ...assignmentData,
          assignmentId,
        });
        console.log(`Triggered assignmentUpdated on channel ${channel}`);
      }

      return res.status(200).json({ message: 'Doctor assigned successfully', assignment: assignmentData });
    } catch (error) {
      console.error('Assign doctor error:', error.message, error.stack);
      return res.status(500).json({ error: { code: 500, message: 'Failed to assign doctor', details: error.message } });
    }
  });
}