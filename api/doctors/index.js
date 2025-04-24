import { Storage } from '@google-cloud/storage';
import admin from 'firebase-admin';

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
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

// Initialize GCS with environment variables only (no local file fallback)
const storage = new Storage({
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: process.env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
});
const bucketName = 'fir-project-vercel'; // Updated bucket name
const bucket = storage.bucket(bucketName);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Method validation
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "doctors"
  const param = pathSegments[2]; // e.g., [id] or "by-specialty"
  const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

  try {
    if (endpoint === 'doctors' && !param) {
      // Handle /api/doctors (GET all doctors)
      const [files] = await bucket.getFiles({ prefix: 'doctors/' });
      if (!files || files.length === 0) {
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = await Promise.all(
        files.map(async (file) => {
          try {
            const [contents] = await file.download();
            const data = JSON.parse(contents.toString('utf8'));
            return { id: file.name.split('/')[1].replace('.json', ''), ...data };
          } catch (fileError) {
            console.error(`Error processing doctor file ${file.name}:`, fileError.message);
            return null;
          }
        })
      );
      const filteredDoctors = doctorList.filter((doctor) => doctor);
      return res.status(200).json(filteredDoctors);
    } else if (endpoint === 'doctors' && param && param !== 'by-specialty') {
      // Handle /api/doctors/[id] (GET specific doctor)
      const doctorFile = bucket.file(`doctors/${param}.json`);
      const [exists] = await doctorFile.exists();
      if (!exists) {
        return res.status(404).json({ error: { code: 404, message: 'Doctor not found' } });
      }

      const [contents] = await doctorFile.download();
      return res.status(200).json(JSON.parse(contents.toString('utf8')));
    } else if (endpoint === 'doctors' && param === 'by-specialty' && specialty) {
      // Handle /api/doctors/by-specialty/[specialty] (GET doctors by specialty)
      const [files] = await bucket.getFiles({ prefix: 'doctors/' });
      if (!files || files.length === 0) {
        return res.status(404).json({ error: { code: 404, message: 'No doctors found' } });
      }

      const doctorList = await Promise.all(
        files.map(async (file) => {
          try {
            const [contents] = await file.download();
            const data = JSON.parse(contents.toString('utf8'));
            return data.specialty === specialty ? { id: file.name.split('/')[1].replace('.json', ''), ...data } : null;
          } catch (fileError) {
            console.error(`Error processing doctor file ${file.name}:`, fileError.message);
            return null;
          }
        })
      );
      const filteredDoctors = doctorList.filter((doctor) => doctor);
      return res.status(200).json(filteredDoctors.length > 0 ? filteredDoctors : []);
    } else {
      return res.status(404).json({ error: { code: 404, message: 'Endpoint not found' } });
    }
  } catch (error) {
    console.error(`Error in /api/doctors${param ? `/${param}${specialty ? `/${specialty}` : ''}` : ''}:`, error.message);
    res.status(500).json({ error: { code: 500, message: 'Failed to fetch doctors', details: error.message } });
  }
}