const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const serviceAccountKeyPath = process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY, 'base64').toString())
  : require('../../../service-account.json');
const storage = new Storage({ credentials: serviceAccountKeyPath });
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "doctors"
  const param = pathSegments[2]; // e.g., [id] or "by-specialty"
  const specialty = pathSegments[3]; // e.g., [specialty] if "by-specialty"

  try {
    if (endpoint === 'doctors' && !param) {
      // Handle /api/doctors (GET all doctors)
      const [files] = await bucket.getFiles({ prefix: 'doctors/' });
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
      return res.status(200).json(doctorList.filter((doctor) => doctor));
    } else if (endpoint === 'doctors' && param && param !== 'by-specialty') {
      // Handle /api/doctors/[id] (GET specific doctor)
      const doctorFile = bucket.file(`doctors/${param}.json`);
      const [exists] = await doctorFile.exists();
      if (!exists) return res.status(404).json({ error: 'Doctor not found' });

      const [contents] = await doctorFile.download();
      return res.status(200).json(JSON.parse(contents.toString('utf8')));
    } else if (endpoint === 'doctors' && param === 'by-specialty' && specialty) {
      // Handle /api/doctors/by-specialty/[specialty] (GET doctors by specialty)
      const [files] = await bucket.getFiles({ prefix: 'doctors/' });
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
      return res.status(200).json(doctorList.filter((doctor) => doctor));
    } else {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (error) {
    console.error(`Error in /api/doctors${param ? `/${param}` : ''}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch doctors', details: error.message });
  }
}