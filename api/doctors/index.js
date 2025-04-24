//api/doctors/index.js
import { Storage } from '@google-cloud/storage';
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

// Initialize Google Cloud Storage (GCS)
let storage;
try {
  const gcsPrivateKey = process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!process.env.GCS_CLIENT_EMAIL || !gcsPrivateKey) {
    throw new Error('Missing GCS credentials: GCS_CLIENT_EMAIL or GCS_PRIVATE_KEY');
  }

  storage = new Storage({
    credentials: {
      client_email: process.env.GCS_CLIENT_EMAIL,
      private_key: gcsPrivateKey,
    },
  });
  console.log('Google Cloud Storage initialized successfully');
} catch (error) {
  console.error('GCS initialization failed:', error.message);
  throw new Error(`GCS initialization failed: ${error.message}`);
}

const bucketName = 'fir-project-vercel';
const bucket = storage.bucket(bucketName);

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

// Retry logic for Firestore and GCS operations
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

// Upload with retry logic
async function uploadWithRetry(file, buffer, metadata, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await file.save(buffer, { metadata });
      console.log(`Upload successful on attempt ${attempt} for ${file.name}`);
      return true;
    } catch (error) {
      if (attempt === retries) {
        console.error(`Upload failed after ${retries} retries for ${file.name}: ${error.message}`);
        throw error;
      }
      console.warn(`Upload attempt ${attempt} failed for ${file.name}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
    }
  }
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "doctors"
  const param = pathSegments[2]; // e.g., [id], "by-specialty", or "assign"
  const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

  try {
    if (req.method === 'GET' && endpoint === 'doctors' && !param) {
      // Handle /api/doctors (GET all doctors)
      let files;
      try {
        [files] = await operationWithRetry(() => bucket.getFiles({ prefix: 'doctors/' }));
      } catch (error) {
        console.error('Failed to fetch files from GCS:', error.message);
        return res.status(500).json({ error: { code: 500, message: 'Failed to fetch doctor files from storage', details: error.message } });
      }

      if (!files || files.length === 0) {
        console.warn('No doctor files found in GCS bucket');
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = await Promise.all(
        files.map(async (file) => {
          try {
            const [contents] = await operationWithRetry(() => file.download());
            const data = JSON.parse(contents.toString('utf8'));
            return { id: file.name.split('/')[1].replace('.json', ''), ...data };
          } catch (fileError) {
            console.error(`Error processing doctor file ${file.name}: ${fileError.message}`);
            return null;
          }
        })
      );

      const filteredDoctors = doctorList.filter((doctor) => doctor !== null);
      if (filteredDoctors.length === 0) {
        console.warn('No valid doctor data after processing');
        return res.status(404).json({ error: { code: 404, message: 'No valid doctors found' } });
      }

      return res.status(200).json(filteredDoctors);
    } else if (req.method === 'GET' && endpoint === 'doctors' && param && param !== 'by-specialty') {
      // Handle /api/doctors/[id] (GET specific doctor)
      const doctorFile = bucket.file(`doctors/${param}.json`);
      let exists;
      try {
        [exists] = await operationWithRetry(() => doctorFile.exists());
      } catch (error) {
        console.error(`Failed to check if doctor file exists (${doctorFile.name}): ${error.message}`);
        return res.status(500).json({ error: { code: 500, message: 'Failed to check doctor file existence', details: error.message } });
      }

      if (!exists) {
        return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
      }

      let contents;
      try {
        [contents] = await operationWithRetry(() => doctorFile.download());
      } catch (error) {
        console.error(`Failed to download doctor file (${doctorFile.name}): ${error.message}`);
        return res.status(500).json({ error: { code: 500, message: 'Failed to download doctor file', details: error.message } });
      }

      return res.status(200).json(JSON.parse(contents.toString('utf8')));
    } else if (req.method === 'GET' && endpoint === 'doctors' && param === 'by-specialty' && specialty) {
      // Handle /api/doctors/by-specialty/[specialty] (GET doctors by specialty)
      let files;
      try {
        [files] = await operationWithRetry(() => bucket.getFiles({ prefix: 'doctors/' }));
      } catch (error) {
        console.error('Failed to fetch files from GCS for specialty:', error.message);
        return res.status(500).json({ error: { code: 500, message: 'Failed to fetch doctor files from storage', details: error.message } });
      }

      if (!files || files.length === 0) {
        console.warn('No doctor files found in GCS bucket for specialty');
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = await Promise.all(
        files.map(async (file) => {
          try {
            const [contents] = await operationWithRetry(() => file.download());
            const data = JSON.parse(contents.toString('utf8'));
            return data.specialty === specialty ? { id: file.name.split('/')[1].replace('.json', ''), ...data } : null;
          } catch (fileError) {
            console.error(`Error processing doctor file ${file.name}: ${fileError.message}`);
            return null;
          }
        })
      );

      const filteredDoctors = doctorList.filter((doctor) => doctor !== null);
      return res.status(200).json(filteredDoctors.length > 0 ? filteredDoctors : []);
    } else if (req.method === 'POST' && endpoint === 'doctors' && param === 'assign') {
      // Handle /api/doctors/assign (POST to assign doctor)
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

          const doctorQuery = await operationWithRetry(() => db.collection('doctors').where('doctorId', '==', doctorId).get());
          if (doctorQuery.empty) {
            return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
          }

          const patientDoc = await operationWithRetry(() => db.collection('patients').doc(patientId).get());
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

          const assignmentFile = bucket.file(`doctor_assignments/${patientId}-${doctorId}.json`);
          await uploadWithRetry(assignmentFile, JSON.stringify(assignmentData), { contentType: 'application/json' });

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
}}