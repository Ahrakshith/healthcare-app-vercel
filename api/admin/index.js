const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');
const { db } = require('../../services/firebaseAdmin'); // Adjust path as needed
const { uploadWithRetry } = require('../../utils/gcsUtils'); // Custom utility for retry logic

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

// Initialize GCS
const storage = new Storage();
const bucketName = 'healthcare-app-d8997-audio';
const bucket = storage.bucket(bucketName);

module.exports = async (req, res) => {
  const { method } = req;

  switch (method) {
    case 'GET':
      try {
        const [files] = await bucket.getFiles({ prefix: 'admin_notifications/' });
        const notifications = await Promise.all(
          files.map(async (file) => {
            try {
              const [contents] = await file.download();
              const data = JSON.parse(contents.toString('utf8'));
              return { id: file.name.split('/')[1].replace('.json', ''), ...data };
            } catch (fileError) {
              console.error(`Error processing notification file ${file.name}:`, fileError.message);
              return null;
            }
          })
        );
        const filteredNotifications = notifications.filter((n) => n);
        console.log(`Fetched ${filteredNotifications.length} admin notifications`);
        res.status(200).json(filteredNotifications);
      } catch (error) {
        console.error('Error fetching admin notifications:', error);
        res.status(500).json({ error: 'Failed to fetch admin notifications', details: error.message });
      }
      break;

    case 'POST':
      try {
        const { patientName, age, sex, description, disease, medicine, patientId, doctorId } = req.body;
        if (!patientId || !doctorId) {
          return res.status(400).json({ error: 'patientId and doctorId are required' });
        }

        const notificationId = `${Date.now()}`;
        const notificationData = {
          patientName: patientName || 'Unknown',
          age: age ? parseInt(age, 10) : null,
          sex: sex || 'N/A',
          description: description || 'N/A',
          disease: disease || 'N/A',
          medicine: medicine || null,
          patientId,
          doctorId,
          createdAt: new Date().toISOString(),
        };

        const notificationFile = bucket.file(`admin_notifications/${notificationId}.json`);
        await uploadWithRetry(notificationFile, JSON.stringify(notificationData), { contentType: 'application/json' });
        console.log(`Notification ${notificationId} saved to GCS`);

        // Emit to Pusher (assuming Pusher is configured in your project)
        const Pusher = require('pusher');
        const pusher = new Pusher({
          appId: process.env.PUSHER_APP_ID,
          key: process.env.PUSHER_KEY,
          secret: process.env.PUSHER_SECRET,
          cluster: 'ap2',
          useTLS: true,
        });
        pusher.trigger(`chat-${patientId}-${doctorId}`, 'missedDoseAlert', notificationData);

        res.status(200).json({ message: 'Notification saved', notificationId });
      } catch (error) {
        console.error('Error saving admin notification:', error);
        res.status(500).json({ error: 'Failed to save notification', details: error.message });
      }
      break;

    default:
      res.setHeader('Allow', ['GET', 'POST']);
      res.status(405).json({ error: `Method ${method} Not Allowed` });
      break;
  }
};