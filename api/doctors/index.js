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
      if (attempt === retries) {
        console.error(`Operation failed after ${retries} retries: ${error.message}`);
        throw error;
      }
      console.warn(`Retry ${attempt}/${retries} failed: ${error.message}`);
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
    console.error(`Role check failed for UID ${userId}: ${error.message}`);
    return res.status(500).json({ error: { code: 500, message: 'Role check failed', details: error.message } });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "doctors"
  const param = pathSegments[2]; // e.g., [id], "by-specialty", or "assign"
  const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

  try {
    if (req.method === 'GET' && endpoint === 'doctors' && !param) {
      // Fetch all doctors from Firestore
      const doctorsSnapshot = await operationWithRetry(() => db.collection('doctors').get());
      if (doctorsSnapshot.empty) {
        console.warn('No doctors found in Firestore');
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = doctorsSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));

      return res.status(200).json(doctorList);
    } else if (req.method === 'GET' && endpoint === 'doctors' && param && param !== 'by-specialty') {
      // Fetch a specific doctor by ID from Firestore
      const doctorDoc = await operationWithRetry(() => db.collection('doctors').doc(param).get());
      if (!doctorDoc.exists) {
        return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
      }

      return res.status(200).json({ id: doctorDoc.id, ...doctorDoc.data() });
    } else if (req.method === 'GET' && endpoint === 'doctors' && param === 'by-specialty' && specialty) {
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
        ...doc.data(),
      }));

      return res.status(200).json(doctorList);
    } else if (req.method === 'POST' && endpoint === 'doctors' && param === 'assign') {
      // Assign a doctor to a patient
      await checkRole('patient', req, res, async () => {
        try {
          const { patientId, doctorId } = req.body;
          const userId = req.headers['x-user-uid'];

          if (!patientId || !doctorId) {
            return res.status(400).json({ error: { code: 400, message: 'patientId and doctorId are required' } });
          }

          if (req.patientId !== patientId) {
            return res.status(403).json({ error: { code: 403, message: 'You are not authorized to assign this patient' } });
          }

          const doctorQuery = await operationWithRetry(() =>
            db.collection('doctors').where('doctorId', '==', doctorId).get()
          );
          if (doctorQuery.empty) {
            return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
          }

          const patientDoc = await operationWithRetry(() =>
            db.collection('patients').doc(patientId).get()
          );
          if (!patientDoc.exists) {
            return res.status(404).json({ error: { code: 404, message: 'Patient not found' } });
          }

          const patientData = patientDoc.data();
          const assignmentData = {
            patientId,
            doctorId,
            timestamp: new Date().toISOString(),
            patientName: patientData.name || `Patient ${patientId}`,
            age: patientData.age || null,
            sex: patientData.sex || null,
          };

          await operationWithRetry(() =>
            db.collection('doctor_assignments').doc(`${patientId}_${doctorId}`).set(assignmentData, { merge: true })
          );

          // Trigger Pusher event
          const channel = `private-patient-${patientId}`;
          await pusher.trigger(channel, 'assignmentUpdated', {
            ...assignmentData,
            assignmentId: `${patientId}_${doctorId}`,
          });
          console.log(`Triggered assignmentUpdated on channel ${channel}`);

          return res.status(200).json({ message: 'Doctor assigned successfully', assignment: assignmentData });
        } catch (error) {
          console.error('Assign doctor error:', error.message);
          return res.status(500).json({ error: { code: 500, message: 'Failed to assign doctor', details: error.message } });
        }
      });
    } else {
      return res.status(404).json({ error: { code: 404, message: 'Endpoint not found' } });
    }
  } catch (error) {
    console.error(`Error in /api/doctors${param ? `/${param}${specialty ? `/${specialty}` : ''}` : ''}: ${error.message}`);
    return res.status(500).json({ error: { code: 500, message: 'A server error has occurred', details: error.message } });
  }
}