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
    console.log('Firebase Admin initialized successfully in api/users/index.js');
  } catch (error) {
    console.error('Firebase Admin initialization failed in api/users/index.js:', error.message, error.stack);
    throw error;
  }
}

const db = admin.firestore();

// Initialize Pusher (optional, remove if not needed)
let pusher;
try {
  if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
    console.warn('Pusher credentials missing, skipping initialization in api/users/index.js');
  } else {
    pusher = new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS: true,
    });
    console.log('Pusher initialized successfully in api/users/index.js');
  }
} catch (error) {
  console.error('Pusher initialization failed in api/users/index.js:', error.message, error.stack);
}

// Retry logic
async function operationWithRetry(operation, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`Retry ${attempt}/${retries} failed in api/users/index.js: ${error.message}`, error.stack);
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
    console.log(`Generated ${fieldName} ${generatedId} already exists in ${collectionName}, regenerating...`);
  }
  return generatedId;
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS request in api/users/index.js');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.error(`Method ${req.method} not allowed in api/users/index.js`);
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
  }

  const adminId = req.headers['x-user-uid'];
  const authHeader = req.headers['authorization'];

  if (!adminId || !authHeader) {
    console.error('Missing authentication headers in api/users/index.js:', { adminId, authHeader });
    return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing authentication headers' } });
  }

  try {
    // Verify the Firebase ID token
    const token = authHeader.replace('Bearer ', '');
    const decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.uid !== adminId) {
      console.error('Token UID does not match adminId in api/users/index.js:', { tokenUid: decodedToken.uid, adminId });
      return res.status(403).json({ error: { code: 403, message: 'Unauthorized: Token does not match user' } });
    }

    // Verify admin role in Firestore
    const userDoc = await operationWithRetry(() => db.collection('users').doc(adminId).get());
    if (!userDoc.exists) {
      console.error(`User document not found for adminId ${adminId} in api/users/index.js`);
      return res.status(404).json({ error: { code: 404, message: 'User not found' } });
    }
    const userDataFromDoc = userDoc.data();
    if (userDataFromDoc.role !== 'admin') {
      console.error(`User ${adminId} is not an admin in api/users/index.js, role: ${userDataFromDoc.role}`);
      return res.status(403).json({ error: { code: 403, message: 'Forbidden: Only admins can perform this action' } });
    }

    const { role, email, password, name, age, sex, experience, specialty, qualification, address, contactNumber } = req.body;

    // Validate role
    if (!['doctor', 'patient', 'admin'].includes(role)) {
      console.error(`Invalid role specified in api/users/index.js: ${role}`);
      return res.status(400).json({ error: { code: 400, message: 'Invalid role specified' } });
    }

    // Common validations
    if (!email || !password) {
      console.error('Missing email or password in api/users/index.js');
      return res.status(400).json({ error: { code: 400, message: 'Email and password are required' } });
    }
    if (!email.endsWith('@gmail.com')) {
      console.error(`Invalid email format in api/users/index.js: ${email}`);
      return res.status(400).json({ error: { code: 400, message: 'Email must be a valid Gmail address' } });
    }
    if (password.length < 6) {
      console.error('Password too short in api/users/index.js');
      return res.status(400).json({ error: { code: 400, message: 'Password should be at least 6 characters long' } });
    }

    // Role-specific validations
    let userData = { email, role, createdAt: new Date().toISOString() };
    let collectionName, idField, uniqueId;

    if (role === 'doctor') {
      if (!name || !age || !sex || !experience || !specialty || !qualification || !address || !contactNumber) {
        console.error('Missing required doctor fields in api/users/index.js');
        return res.status(400).json({ error: { code: 400, message: 'Missing required doctor fields' } });
      }
      if (isNaN(age) || age <= 0) {
        console.error(`Invalid age in api/users/index.js: ${age}`);
        return res.status(400).json({ error: { code: 400, message: 'Invalid age' } });
      }
      if (isNaN(experience) || experience < 0) {
        console.error(`Invalid experience in api/users/index.js: ${experience}`);
        return res.status(400).json({ error: { code: 400, message: 'Invalid experience' } });
      }
      if (!/^\d{10}$/.test(contactNumber)) {
        console.error(`Invalid contact number in api/users/index.js: ${contactNumber}`);
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
        console.error('Missing required patient fields in api/users/index.js');
        return res.status(400).json({ error: { code: 400, message: 'Missing required patient fields' } });
      }
      if (isNaN(age) || age <= 0) {
        console.error(`Invalid age in api/users/index.js: ${age}`);
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
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: name || email,
      });
    } catch (authError) {
      console.error(`Firebase Auth error in api/users/index.js: ${authError.code}`, authError.stack);
      if (authError.code === 'auth/email-already-in-use') {
        return res.status(409).json({ error: { code: 409, message: 'This email is already registered' } });
      }
      throw authError; // Re-throw other auth errors
    }

    const uid = userRecord.uid;
    userData.uid = uid;

    // Store in Firestore 'users' collection
    await operationWithRetry(() => db.collection('users').doc(uid).set(userData));
    console.log(`Stored user data in Firestore 'users' collection for UID: ${uid}`);

    // Store in role-specific collection (if applicable)
    if (collectionName && idField) {
      await operationWithRetry(() => db.collection(collectionName).doc(uniqueId).set(userData));
      console.log(`Stored ${role} data in Firestore '${collectionName}' collection with ${idField}: ${uniqueId}`);
    }

    // Trigger Pusher event (optional)
    if (pusher && role === 'doctor') {
      try {
        await pusher.trigger('admin-channel', 'doctor-added', { [idField]: uniqueId, name: name || email });
        console.log(`Pusher event 'doctor-added' triggered for ${idField}: ${uniqueId}`);
      } catch (pusherError) {
        console.warn(`Pusher trigger failed for doctor-added: ${pusherError.message}`, pusherError.stack);
      }
    }

    return res.status(201).json({
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} added successfully`,
      uid,
      ...(idField ? { [idField]: uniqueId } : {}),
    });
  } catch (error) {
    console.error(`Error in /api/users for admin ${adminId}:`, error.message, error.stack);
    let errorResponse = { error: { code: 500, message: 'A server error has occurred' } };
    if (error.code === 'auth/email-already-in-use') {
      errorResponse = { error: { code: 409, message: 'This email is already registered' } };
    } else if (error.code === 'auth/invalid-email') {
      errorResponse = { error: { code: 400, message: 'Invalid email address' } };
    } else if (error.code === 'auth/weak-password') {
      errorResponse = { error: { code: 400, message: 'Password should be at least 6 characters long' } };
    } else if (error.code === 'auth/invalid-id-token') {
      errorResponse = { error: { code: 401, message: 'Invalid authentication token' } };
    }
    return res.status(errorResponse.error.code).json(errorResponse);
  }
}