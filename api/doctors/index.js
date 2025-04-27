import admin from 'firebase-admin';

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

// Handler for storing doctor-patient records
const handleRecordsRequest = async (req, res, userId) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const { doctorId, patientId, diagnosis, prescription } = req.body;

      // Validate request body
      if (!doctorId || !patientId || (!diagnosis && !prescription)) {
        return res.status(400).json({
          error: { code: 400, message: 'doctorId, patientId, and at least one of diagnosis or prescription are required' }
        });
      }

      // Verify user role and doctorId
      const userDoc = await operationWithRetry(() => db.collection('users').doc(userId).get());
      if (!userDoc.exists || userDoc.data().role !== 'doctor') {
        return res.status(403).json({
          error: { code: 403, message: 'Forbidden: Only doctors can store records' }
        });
      }

      const doctorQuery = await operationWithRetry(() =>
        db.collection('doctors').where('uid', '==', userId).get()
      );
      if (doctorQuery.empty || doctorQuery.docs[0].data().doctorId !== doctorId) {
        return res.status(403).json({
          error: { code: 403, message: 'Forbidden: doctorId does not match authenticated user' }
        });
      }

      // Verify patient exists
      const patientDoc = await operationWithRetry(() => db.collection('patients').doc(patientId).get());
      if (!patientDoc.exists) {
        return res.status(404).json({
          error: { code: 404, message: 'Patient not found' }
        });
      }

      // Prepare the record entry
      const recordEntry = {
        diagnosis: diagnosis || null,
        prescription: prescription || null,
        timestamp: new Date().toISOString(),
        valid: true, // Default to true; validation process updates this
      };

      // Store or update the record in Firestore
      const recordId = `${doctorId}_${patientId}`;
      const recordRef = db.collection('doctor_patient_records').doc(recordId);
      const recordDoc = await operationWithRetry(() => recordRef.get());

      if (recordDoc.exists) {
        // Append to existing records
        await operationWithRetry(() =>
          recordRef.update({
            records: admin.firestore.FieldValue.arrayUnion(recordEntry),
          })
        );
      } else {
        // Create new document with the first record
        await operationWithRetry(() =>
          recordRef.set({
            doctorId,
            patientId,
            records: [recordEntry],
          })
        );
      }

      console.log(`Record stored successfully for doctor ${doctorId} and patient ${patientId}`);
      return res.status(req.method === 'POST' ? 201 : 200).json({
        success: true,
        message: `Record ${req.method === 'POST' ? 'created' : 'updated'} successfully`,
      });
    } catch (error) {
      console.error(`Error storing record for user ${userId}:`, error.message);
      return res.status(500).json({
        error: { code: 500, message: 'Server error', details: error.message }
      });
    }
  } else if (req.method === 'GET') {
    try {
      // Verify user is an admin
      const userDoc = await operationWithRetry(() => db.collection('users').doc(userId).get());
      if (!userDoc.exists || userDoc.data().role !== 'admin') {
        return res.status(403).json({
          error: { code: 403, message: 'Forbidden: Only admins can fetch all records' }
        });
      }

      // Fetch all doctor_patient_records
      const recordsSnapshot = await operationWithRetry(() => db.collection('doctor_patient_records').get());
      const allRecords = [];

      for (const doc of recordsSnapshot.docs) {
        const data = doc.data();
        const { doctorId, patientId, records } = data;

        records.forEach((record) => {
          allRecords.push({
            doctorId,
            patientId,
            diagnosis: record.diagnosis || 'N/A',
            prescription: record.prescription || 'N/A',
            timestamp: record.timestamp,
            valid: record.valid !== undefined ? record.valid : true,
          });
        });
      }

      console.log(`Fetched ${allRecords.length} records for admin ${userId}`);
      return res.status(200).json({ success: true, records: allRecords });
    } catch (error) {
      console.error(`Error fetching records for user ${userId}:`, error.message);
      return res.status(500).json({
        error: { code: 500, message: 'Server error', details: error.message }
      });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'PUT']);
    return res.status(405).json({
      error: { code: 405, message: `Method ${req.method} Not Allowed for /doctors/records` }
    });
  }
};

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const userId = req.headers['x-user-uid'];
  if (!userId) {
    return res.status(401).json({
      error: { code: 401, message: 'Unauthorized: Missing x-user-uid header' }
    });
  }

  try {
    // Handle /api/doctors/records route
    if (req.url.includes('/records')) {
      return handleRecordsRequest(req, res, userId);
    }

    // Existing GET endpoint for fetching doctors
    if (req.method !== 'GET') {
      return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
    }

    // Verify user role
    const userDoc = await operationWithRetry(() => db.collection('users').doc(userId).get());
    if (!userDoc.exists || userDoc.data().role !== 'patient') {
      return res.status(403).json({
        error: { code: 403, message: 'Forbidden: Only patients can fetch doctors' }
      });
    }

    // Get specialty from query parameter
    const { specialty = 'All' } = req.query;

    // Fetch doctors based on specialty
    let doctorsSnapshot;
    if (specialty !== 'All') {
      doctorsSnapshot = await operationWithRetry(() =>
        db.collection('doctors').where('specialty', '==', specialty).get()
      );
    } else {
      doctorsSnapshot = await operationWithRetry(() => db.collection('doctors').get());
    }

    const doctors = doctorsSnapshot.docs.map(doc => ({ doctorId: doc.id, ...doc.data() }));

    return res.status(200).json({ doctors });
  } catch (error) {
    console.error(`Error in /api/doctors: ${error.message}`);
    return res.status(500).json({
      error: { code: 500, message: 'Server error', details: error.message }
    });
  }
}