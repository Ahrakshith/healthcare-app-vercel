import admin from 'firebase-admin';

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
    console.error('Failed to initialize Firebase Admin:', error.message);
    throw new Error('Firebase Admin initialization failed');
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { patientId } = req.query;
  const { 'x-user-uid': uid } = req.headers;

  // Validate UID
  if (!uid) {
    console.error('Missing UID in request headers');
    return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing UID in headers' } });
  }

  // Validate patientId
  if (!patientId || typeof patientId !== 'string' || patientId.trim() === '') {
    console.error('Invalid or missing patientId in query:', patientId);
    return res.status(400).json({ error: { code: 400, message: 'Invalid or missing patientId in query' } });
  }

  try {
    // Verify the user's identity and role
    const userRecord = await admin.auth().getUser(uid);
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.error('User document not found for UID:', uid);
      return res.status(404).json({ error: { code: 404, message: 'User not found' } });
    }

    const userData = userDoc.data();
    if (userData.role !== 'doctor') {
      console.error('Unauthorized: User is not a doctor. UID:', uid, 'Role:', userData.role);
      return res.status(403).json({ error: { code: 403, message: 'Unauthorized: Only doctors can update patient data' } });
    }

    // Ensure the doctorId in the request matches the authenticated doctor's UID
    if (req.method === 'POST') {
      const { diagnosis, prescription, doctorId } = req.body;

      // Validate request body
      if (!doctorId || doctorId !== uid) {
        console.error('Invalid or mismatched doctorId. Expected:', uid, 'Received:', doctorId);
        return res.status(403).json({ error: { code: 403, message: 'Invalid or mismatched doctorId' } });
      }

      // Validate that at least one field is provided to update
      if (!diagnosis && !prescription && !doctorId) {
        console.error('No fields provided to update for patient:', patientId);
        return res.status(400).json({ error: { code: 400, message: 'At least one field (diagnosis, prescription, or doctorId) is required' } });
      }

      // Validate field formats
      if (diagnosis && (typeof diagnosis !== 'string' || diagnosis.trim() === '')) {
        console.error('Invalid diagnosis format:', diagnosis);
        return res.status(400).json({ error: { code: 400, message: 'Diagnosis must be a non-empty string' } });
      }

      if (prescription) {
        if (typeof prescription === 'string') {
          // Validate prescription string format (e.g., "Medicine, 500mg, 8:00 AM and 8:00 PM, 5 days")
          const regex = /(.+?),\s*(\d+mg),\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM))\s*and\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM)),\s*(\d+)\s*days?/i;
          if (!regex.test(prescription)) {
            console.error('Invalid prescription string format:', prescription);
            return res.status(400).json({ error: { code: 400, message: 'Prescription string format invalid. Expected: "Medicine, dosage, time1 and time2, duration days"' } });
          }
        } else if (typeof prescription === 'object') {
          // Validate prescription object format
          if (!prescription.medicine || !prescription.dosage || !prescription.frequency || !prescription.duration) {
            console.error('Invalid prescription object format:', prescription);
            return res.status(400).json({ error: { code: 400, message: 'Prescription object must include medicine, dosage, frequency, and duration' } });
          }
        } else {
          console.error('Invalid prescription type:', typeof prescription);
          return res.status(400).json({ error: { code: 400, message: 'Prescription must be a string or an object' } });
        }
      }

      // Verify patient exists
      const patientRef = db.collection('patients').doc(patientId);
      const patientDoc = await patientRef.get();
      if (!patientDoc.exists) {
        console.error('Patient not found for patientId:', patientId);
        return res.status(404).json({ error: { code: 404, message: 'Patient not found' } });
      }

      // Prepare update data
      const updateData = {};
      if (diagnosis) updateData.diagnosis = diagnosis.trim();
      if (prescription) updateData.prescription = prescription;
      if (doctorId) updateData.doctorId = doctorId;

      // Update patient data
      await patientRef.set(updateData, { merge: true });
      console.log(`Successfully updated patient ${patientId} with data:`, updateData);

      return res.status(200).json({ success: true, message: 'Patient data updated successfully', data: updateData });
    } else {
      console.error('Method not allowed:', req.method);
      return res.status(405).json({ error: { code: 405, message: 'Method not allowed. Use POST.' } });
    }
  } catch (error) {
    console.error('Error in /api/patients/[patientId]/patients.js:', error.message);
    return res.status(500).json({ error: { code: 500, message: `Server error: ${error.message}` } });
  }
}