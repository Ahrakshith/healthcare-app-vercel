const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');
const { db } = require('../../../services/firebaseAdmin');

const storage = new Storage();
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

module.exports = async (req, res) => {
  const { patientId, doctorId } = req.query;
  const { method } = req;

  switch (method) {
    case 'GET':
      try {
        const userId = req.headers['x-user-uid'];
        if (!userId) {
          return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
        }

        const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
        const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
        let isAuthorized = false;
        let userRole = null;

        if (!patientQuery.empty && patientQuery.docs[0].data().patientId === patientId) {
          isAuthorized = true;
          userRole = 'patient';
        } else if (!doctorQuery.empty && doctorQuery.docs[0].data().doctorId === doctorId) {
          isAuthorized = true;
          userRole = 'doctor';
        }

        if (!isAuthorized) {
          return res.status(403).json({ error: 'You are not authorized to access this chat' });
        }

        const assignmentQuery = await db.collection('doctor_assignments')
          .where('patientId', '==', patientId)
          .where('doctorId', '==', doctorId)
          .get();
        if (assignmentQuery.empty) {
          return res.status(404).json({ error: 'No chat assignment found' });
        }

        const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
        const [exists] = await file.exists();
        if (!exists) {
          return res.json({ messages: [] });
        }

        const [contents] = await file.download();
        const data = JSON.parse(contents.toString('utf8'));
        res.json({ messages: data.messages || [] });
      } catch (error) {
        console.error('Error fetching chat messages:', error);
        res.status(500).json({ error: 'Failed to fetch chat messages', details: error.message });
      }
      break;

    case 'POST':
      try {
        const userId = req.headers['x-user-uid'];
        const message = req.body;

        const sender = message.sender;
        if (!['patient', 'doctor'].includes(sender)) {
          return res.status(400).json({ error: 'Invalid sender type' });
        }

        let expectedId;
        if (sender === 'doctor') {
          const doctorQuery = await db.collection('doctors').where('uid', '==', userId).get();
          if (doctorQuery.empty) {
            return res.status(404).json({ error: 'Doctor profile not found for this user' });
          }
          expectedId = doctorQuery.docs[0].data().doctorId;
        } else if (sender === 'patient') {
          const patientQuery = await db.collection('patients').where('uid', '==', userId).get();
          if (patientQuery.empty) {
            return res.status(404).json({ error: 'Patient profile not found for this user' });
          }
          expectedId = patientQuery.docs[0].data().patientId;
        }

        if ((sender === 'doctor' && doctorId !== expectedId) || (sender === 'patient' && patientId !== expectedId)) {
          return res.status(403).json({ error: `You are not authorized to send messages as this ${sender}` });
        }

        const assignmentQuery = await db.collection('doctor_assignments')
          .where('patientId', '==', patientId)
          .where('doctorId', '==', doctorId)
          .get();
        if (assignmentQuery.empty) {
          return res.status(404).json({ error: 'No chat assignment found' });
        }

        const file = bucket.file(`chats/${patientId}-${doctorId}.json`);
        let chatData = { messages: [] };
        const [exists] = await file.exists();
        if (exists) {
          const [contents] = await file.download();
          chatData = JSON.parse(contents.toString('utf8'));
        }

        const newMessage = { ...message, timestamp: message.timestamp || new Date().toISOString(), senderId: userId };
        chatData.messages.push(newMessage);

        // Placeholder for uploadWithRetry (implement based on server.js)
        await file.save(JSON.stringify(chatData), { contentType: 'application/json' });

        res.status(200).json({ message: 'Message saved' });
      } catch (error) {
        console.error('Error saving chat message:', error);
        res.status(500).json({ error: 'Failed to save chat message', details: error.message });
      }
      break;

    default:
      res.setHeader('Allow', ['GET', 'POST']);
      res.status(405).json({ error: `Method ${method} Not Allowed` });
      break;
  }
};