Below is the complete and updated `PatientChat.js` based on your current code, incorporating the project flow you described (speech-to-text, text-to-speech, message format adjustments), while retaining the profile, reminder system, and doctor's recommendations. The changes align with your specifications for language preferences (English/Kannada), recording behavior, message formatting for both patient and doctor sides, and the use of Pusher for real-time messaging. Authentication remains Firebase-based, with chats stored in Firestore and audio uploaded to GCS.

### Key Updates
1. **Language Preference and Recording**:
   - Language toggle defaults to `languagePreference` (English or Kannada) at the bottom left.
   - Recording uses `navigator.mediaDevices.getUserMedia` and `MediaRecorder`, with transcription adapting to `transcriptionLanguage`.
   - Text input remains English-only, while audio recording supports Kannada/English with translation as per your format.
2. **Message Format**:
   - **Patient (English Preference)**: `[Translated English text]`, `[Audio playback]`, `[Read aloud: English]`, `[Download audio]`.
   - **Patient (Kannada Preference)**: `[Translated Kannada text]`, `[Translated English text]`, `[Audio playback]`, `[Read aloud: Kannada] [Read aloud: English]`, `[Download audio]`.
   - **Doctor (Patient English Preference)**: `[Translated English text]`, `[Audio playback]`, `[Read aloud: English]`, `[Download audio]`.
   - **Doctor (Patient Kannada Preference)**: `[Translated Kannada text]`, `[Translated English text]`, `[Audio playback]`, `[Read aloud: Kannada] [Read aloud: English]`, `[Download audio]`.
3. **Doctor Prompt**:
   - Implemented a Yes/No prompt for the doctor on first contact or after 7 days (client-side logic; server-side integration would be needed for persistence).
4. **Retained Features**:
   - Profile view, reminder system (with adherence and missed dose alerts), and doctor's recommendations.
5. **Technical Adjustments**:
   - Removed `react-speech-recognition` dependency (replaced with manual transcription via `transcribeAudio` service).
   - Ensured Pusher integration remains intact.
   - Added proper error handling and retry logic for audio uploads.

---

### Updated `PatientChat.js`

```javascript
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Pusher from 'pusher-js';
import {
  transcribeAudio,
  translateText,
  textToSpeechConvert,
  detectLanguage,
} from '../services/speech.js';
import { verifyMedicine, notifyAdmin } from '../services/medicineVerify.js';
import { doc, getDoc, collection, addDoc, getDocs, updateDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';

function PatientChat({ user, firebaseUser, role, patientId, handleLogout }) {
  const { patientId: urlPatientId, doctorId } = useParams();
  const [messages, setMessages] = useState([]);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [error, setError] = useState('');
  const [transcriptionLanguage, setTranscriptionLanguage] = useState(null);
  const [languagePreference, setLanguagePreference] = useState(null);
  const [textInput, setTextInput] = useState('');
  const [validationResult, setValidationResult] = useState({});
  const [failedUpload, setFailedUpload] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeMenuOption, setActiveMenuOption] = useState(null);
  const [profileData, setProfileData] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [adherenceRate, setAdherenceRate] = useState(0);
  const [missedDoses, setMissedDoses] = useState(0);
  const [missedDoseAlerts, setMissedDoseAlerts] = useState([]);
  const [doctorPrompt, setDoctorPrompt] = useState(null); // For Yes/No prompt
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());
  const streamRef = useRef(null);
  const pusherRef = useRef(null);
  const messagesEndRef = useRef(null);
  const reminderTimeoutsRef = useRef(new Map());
  const errorTimeoutRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  const navigate = useNavigate();

  const effectiveUserId = user?.uid || '';
  const effectivePatientId = urlPatientId || patientId || '';
  const apiBaseUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';
  const pusherKey = process.env.REACT_APP_PUSHER_KEY || 'your-pusher-key';
  const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'ap2';

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (error) {
      errorTimeoutRef.current = setTimeout(() => {
        setError('');
        setFailedUpload(null);
      }, 5000);
    }
    return () => clearTimeout(errorTimeoutRef.current);
  }, [error]);

  useEffect(() => {
    const timers = missedDoseAlerts.map((alert) =>
      setTimeout(() => {
        setMissedDoseAlerts((prev) => prev.filter((a) => a.id !== alert.id));
      }, 5000)
    );
    return () => timers.forEach(clearTimeout);
  }, [missedDoseAlerts]);

  useEffect(() => {
    if (!effectiveUserId || !effectivePatientId || !doctorId || role !== 'patient') {
      setError('User authentication, role, or patient/doctor ID missing. Please log in as a patient.');
      navigate('/login');
      return;
    }

    if ('Notification' in window) {
      Notification.requestPermission().then((permission) => {
        if (permission !== 'granted') {
          setError('Notification permission denied. Reminders may not work.');
        }
      });
    }

    const fetchPatientData = async () => {
      try {
        const patientRef = doc(db, 'patients', effectivePatientId);
        const patientDoc = await getDoc(patientRef);
        if (patientDoc.exists() && patientDoc.data().uid === effectiveUserId) {
          const data = patientDoc.data();
          const pref = data.languagePreference || 'en';
          setLanguagePreference(pref);
          setTranscriptionLanguage(pref);
          setProfileData({
            name: data.name || 'N/A',
            patientId: effectivePatientId,
            email: data.email || 'N/A',
            languagePreference: pref,
            sex: data.sex || 'N/A',
            age: data.age || 'N/A',
            address: data.address || 'N/A',
          });
        } else {
          setError('Patient not found or unauthorized.');
          navigate('/login');
        }
      } catch (err) {
        setError(`Failed to fetch patient data: ${err.message}`);
        navigate('/login');
      }
    };

    const fetchReminders = async () => {
      try {
        const remindersRef = collection(db, `patients/${effectivePatientId}/reminders`);
        const snapshot = await getDocs(remindersRef);
        const fetchedReminders = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
          status: doc.data().status || 'pending',
          snoozeCount: doc.data().snoozeCount || 0,
          scheduledTime: doc.data().scheduledTime,
        }));
        setReminders(fetchedReminders);
        scheduleReminders(fetchedReminders);
        calculateAdherenceRate(fetchedReminders);
        checkMissedDoses(fetchedReminders);
      } catch (err) {
        setError(`Failed to fetch reminders: ${err.message}`);
      }
    };

    const checkDoctorPrompt = async () => {
      const lastContact = localStorage.getItem(`lastContact_${effectivePatientId}_${doctorId}`);
      const now = new Date();
      if (!lastContact || (now - new Date(lastContact) > 7 * 24 * 60 * 60 * 1000)) {
        setDoctorPrompt(true); // Trigger Yes/No prompt
      }
    };

    fetchPatientData();
    fetchReminders();
    checkDoctorPrompt();

    return () => {
      if (pusherRef.current) {
        pusherRef.current.disconnect();
        console.log('PatientChat.js: Pusher disconnected');
      }
      reminderTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
      reminderTimeoutsRef.current.clear();
      clearTimeout(retryTimeoutRef.current);
    };
  }, [effectiveUserId, effectivePatientId, doctorId, role, navigate]);

  useEffect(() => {
    const doctorMessages = messages.filter((msg) => msg.sender === 'doctor' && msg.prescription);
    if (doctorMessages.length > 0) {
      const latestPrescription = doctorMessages.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.prescription;
      if (latestPrescription) {
        console.log('Processing prescription:', latestPrescription, typeof latestPrescription);
        setupMedicationSchedule(latestPrescription);
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!languagePreference) return;

    try {
      pusherRef.current = new Pusher(pusherKey, {
        cluster: pusherCluster,
        authEndpoint: `${apiBaseUrl}/pusher/auth`,
        auth: { headers: { 'x-user-uid': effectiveUserId } },
      });

      pusherRef.current.connection.bind('error', (err) => {
        console.error('Pusher connection error:', err);
        setError('Failed to connect to real-time messaging. Attempting to reconnect...');
        setTimeout(() => pusherRef.current.connect(), 2000);
      });

      const channel = pusherRef.current.subscribe(`chat-${effectivePatientId}-${doctorId}`);
      channel.bind('newMessage', (message) => {
        console.log('PatientChat.js: Received new message:', {
          ...message,
          audioUrl: message.audioUrl ? '[Audio URL]' : null,
        });
        setMessages((prev) => {
          if (!prev.some((msg) => msg.timestamp === message.timestamp && (!msg.text || msg.text === message.text))) {
            return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          }
          console.log('PatientChat.js: Skipped duplicate message:', message.timestamp, message.text);
          return prev;
        });

        if (message.sender === 'doctor' && (message.diagnosis || message.prescription)) {
          validatePrescription(message.diagnosis, message.prescription, message.timestamp);
        }
      });

      channel.bind('missedDoseAlert', (alert) => {
        setMissedDoseAlerts((prev) => [...prev, { ...alert, id: Date.now().toString() }]);
      });

      const fetchMessages = async () => {
        try {
          console.log('Fetching messages:', {
            url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
            userId: effectiveUserId,
          });
          const idToken = await firebaseUser.getIdToken(true);
          const response = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
            headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
            credentials: 'include',
          });

          if (!response.ok) {
            if (response.status === 404) {
              console.log('Chat not found, initializing empty chat');
              setMessages([]);
              return;
            }
            const errorData = await response.json();
            throw new Error(`Failed to fetch messages: ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
          }

          const data = await response.json();
          const fetchedMessages = data.messages || [];
          setMessages(fetchedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

          const doctorMessages = fetchedMessages.filter((msg) => msg.sender === 'doctor');
          const latestDiagnosis = doctorMessages
            .filter((msg) => msg.diagnosis)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.diagnosis || '';
          const latestPrescription = doctorMessages
            .filter((msg) => msg.prescription)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.prescription || '';
          if (latestDiagnosis || latestPrescription) {
            validatePrescription(latestDiagnosis, latestPrescription, 'latest');
          }
        } catch (err) {
          console.error('Error fetching messages:', err);
          setError(`Error fetching messages: ${err.message}`);
          if (err.message.includes('404')) {
            setTimeout(fetchMessages, 2000);
          }
        }
      };

      fetchMessages();

      return () => {
        if (pusherRef.current) {
          pusherRef.current.unsubscribe(`chat-${effectivePatientId}-${doctorId}`);
          pusherRef.current.disconnect();
          console.log('PatientChat.js: Pusher disconnected');
        }
      };
    } catch (err) {
      console.error('Pusher initialization failed:', err);
      setError('Failed to initialize real-time messaging. Please refresh the page.');
    }
  }, [effectiveUserId, effectivePatientId, doctorId, languagePreference, apiBaseUrl, firebaseUser, pusherKey, pusherCluster]);

  const normalizeLanguageCode = useCallback((code) => {
    switch (code?.toLowerCase()) {
      case 'kn':
        return 'kn-IN';
      case 'en':
        return 'en-US';
      default:
        return code || 'en-US';
    }
  }, []);

  const setupMedicationSchedule = async (prescription) => {
    console.log('setupMedicationSchedule: Received prescription:', prescription, typeof prescription);

    if (!prescription) {
      setError('Prescription is missing or undefined.');
      console.error('setupMedicationSchedule: Prescription is undefined or null');
      return;
    }

    let medicine, dosage, time1Str, time2Str, durationDays;

    if (typeof prescription === 'object') {
      medicine = prescription.medicine;
      dosage = prescription.dosage;
      const frequency = prescription.frequency || '';
      durationDays = prescription.duration || '5';
      const times = frequency.split(' and ').map((t) => t.trim());
      time1Str = times[0] || '8:00 AM';
      time2Str = times[1] || '8:00 PM';

      if (!medicine || !dosage || !time1Str || !time2Str || !durationDays) {
        setError('Invalid prescription object format. Missing required fields.');
        console.error('setupMedicationSchedule: Invalid prescription object:', prescription);
        return;
      }
    } else if (typeof prescription === 'string') {
      const regex = /(.+?),\s*(\d+mg),\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM))\s*and\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM)),\s*(\d+)\s*days?/i;
      const match = prescription.match(regex);

      if (!match) {
        setError('Invalid prescription string format. Expected: "Medicine, dosage, time1 and time2, duration days"');
        console.error('setupMedicationSchedule: Invalid prescription string:', prescription);
        return;
      }

      [, medicine, dosage, time1Str, time2Str, durationDays] = match;
    } else {
      setError('Unsupported prescription format. Must be a string or object.');
      console.error('setupMedicationSchedule: Unsupported prescription type:', typeof prescription);
      return;
    }

    const days = parseInt(durationDays, 10);
    if (isNaN(days) || days <= 0) {
      setError('Invalid duration in prescription.');
      console.error('setupMedicationSchedule: Invalid duration:', durationDays);
      return;
    }

    const parseTime = (timeStr) => {
      const cleanTimeStr = timeStr.replace('.', ':');
      const [time, period] = cleanTimeStr.split(/\s*(AM|PM)/i);
      let [hours, minutes] = time.split(':').map(Number);
      if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
      return { hours, minutes };
    };

    const time1 = parseTime(time1Str);
    const time2 = parseTime(time2Str);

    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + days - 1);

    const newReminders = [];
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const scheduledDate1 = new Date(currentDate);
      scheduledDate1.setHours(time1.hours, time1.minutes, 0, 0);
      if (scheduledDate1 > new Date()) {
        const reminder1 = {
          medicine,
          dosage,
          scheduledTime: scheduledDate1.toISOString(),
          status: 'pending',
          snoozeCount: 0,
          createdAt: new Date().toISOString(),
          patientId: effectivePatientId,
        };
        try {
          const remindersRef = collection(db, `patients/${effectivePatientId}/reminders`);
          const docRef = await addDoc(remindersRef, reminder1);
          newReminders.push({ id: docRef.id, ...reminder1 });
        } catch (err) {
          console.error('setupMedicationSchedule: Failed to add reminder1:', err);
          setError(`Failed to add reminder: ${err.message}`);
        }
      }

      const scheduledDate2 = new Date(currentDate);
      scheduledDate2.setHours(time2.hours, time2.minutes, 0, 0);
      if (scheduledDate2 > new Date()) {
        const reminder2 = {
          medicine,
          dosage,
          scheduledTime: scheduledDate2.toISOString(),
          status: 'pending',
          snoozeCount: 0,
          createdAt: new Date().toISOString(),
          patientId: effectivePatientId,
        };
        try {
          const remindersRef = collection(db, `patients/${effectivePatientId}/reminders`);
          const docRef = await addDoc(remindersRef, reminder2);
          newReminders.push({ id: docRef.id, ...reminder2 });
        } catch (err) {
          console.error('setupMedicationSchedule: Failed to add reminder2:', err);
          setError(`Failed to add reminder: ${err.message}`);
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    setReminders((prev) => [...prev, ...newReminders]);
    scheduleReminders(newReminders);
    console.log('setupMedicationSchedule: Added reminders:', newReminders);
  };

  const scheduleReminders = useCallback((remindersToSchedule) => {
    remindersToSchedule.forEach((reminder) => {
      if (reminder.status !== 'pending' && reminder.status !== 'snoozed') return;

      const scheduledTime = new Date(reminder.scheduledTime);
      const now = new Date();
      const delayMs = scheduledTime - now;

      if (delayMs > 0) {
        const timeoutId = setTimeout(() => {
          if ('Notification' in window && Notification.permission === 'granted') {
            const notification = new Notification('Medication Reminder', {
              body: `Time to take ${reminder.dosage} of ${reminder.medicine}. Tap to confirm or snooze.`,
              tag: `reminder-${reminder.id}`,
            });

            notification.onclick = () => {
              handleConfirmReminder(reminder.id);
              notification.close();
            };

            setTimeout(() => {
              if (reminder.status === 'pending') handleSnoozeReminder(reminder.id);
            }, 30000);
          }
        }, delayMs);

        reminderTimeoutsRef.current.set(reminder.id, timeoutId);
      } else if (scheduledTime < now && reminder.status === 'pending') {
        handleMissedReminder(reminder.id);
      }
    });
  }, []);

  const calculateAdherenceRate = useCallback((remindersList) => {
    if (remindersList.length === 0) {
      setAdherenceRate(0);
      return;
    }
    const completed = remindersList.filter((r) => r.status === 'taken').length;
    const total = remindersList.length;
    const rate = (completed / total) * 100;
    setAdherenceRate(rate.toFixed(2));
  }, []);

  const checkMissedDoses = useCallback((remindersList) => {
    const missed = remindersList.filter((r) => r.status === 'missed').length;
    setMissedDoses(missed);

    let consecutiveMissed = 0;
    for (let i = 0; i < remindersList.length; i++) {
      if (remindersList[i].status === 'missed') {
        consecutiveMissed++;
        if (consecutiveMissed >= 3) {
          sendMissedDoseAlert();
          break;
        }
      } else {
        consecutiveMissed = 0;
      }
    }
  }, []);

  const sendMissedDoseAlert = async () => {
    try {
      await notifyAdmin(
        `Patient_${effectivePatientId}`,
        'Doctor',
        'Missed Doses Alert',
        `Patient has missed 3 consecutive doses.`
      );
      setMissedDoseAlerts((prev) => [
        ...prev,
        { id: Date.now().toString(), message: 'Alert: You have missed 3 consecutive doses. Notified your doctor.' },
      ]);
    } catch (err) {
      setError(`Failed to send missed dose alert: ${err.message}`);
    }
  };

  const handleConfirmReminder = async (id) => {
    try {
      const updatedReminders = reminders.map((reminder) =>
        reminder.id === id ? { ...reminder, status: 'taken', confirmedAt: new Date().toISOString() } : reminder
      );
      setReminders(updatedReminders);

      const reminderRef = doc(db, `patients/${effectivePatientId}/reminders`, id);
      await updateDoc(reminderRef, { status: 'taken', confirmedAt: new Date().toISOString() });

      calculateAdherenceRate(updatedReminders);
      checkMissedDoses(updatedReminders);
      clearTimeout(reminderTimeoutsRef.current.get(id));
      reminderTimeoutsRef.current.delete(id);
    } catch (err) {
      setError(`Failed to confirm reminder: ${err.message}`);
    }
  };

  const handleSnoozeReminder = async (id) => {
    try {
      const reminder = reminders.find((r) => r.id === id);
      if (!reminder) return;

      const newSnoozeCount = (reminder.snoozeCount || 0) + 1;
      const snoozeTime = new Date(new Date(reminder.scheduledTime).getTime() + 15 * 60 * 1000);

      const updatedReminders = reminders.map((r) =>
        r.id === id
          ? { ...r, status: 'snoozed', snoozeCount: newSnoozeCount, scheduledTime: snoozeTime.toISOString() }
          : r
      );
      setReminders(updatedReminders);

      const reminderRef = doc(db, `patients/${effectivePatientId}/reminders`, id);
      await updateDoc(reminderRef, {
        status: 'snoozed',
        snoozeCount: newSnoozeCount,
        scheduledTime: snoozeTime.toISOString(),
      });

      scheduleReminders(updatedReminders.filter((r) => r.id === id));
      clearTimeout(reminderTimeoutsRef.current.get(id));
      reminderTimeoutsRef.current.delete(id);
    } catch (err) {
      setError(`Failed to snooze reminder: ${err.message}`);
    }
  };

  const handleMissedReminder = async (id) => {
    try {
      const updatedReminders = reminders.map((reminder) =>
        reminder.id === id ? { ...reminder, status: 'missed' } : reminder
      );
      setReminders(updatedReminders);

      const reminderRef = doc(db, `patients/${effectivePatientId}/reminders`, id);
      await updateDoc(reminderRef, { status: 'missed' });

      checkMissedDoses(updatedReminders);
      clearTimeout(reminderTimeoutsRef.current.get(id));
      reminderTimeoutsRef.current.delete(id);
    } catch (err) {
      setError(`Failed to mark reminder as missed: ${err.message}`);
    }
  };

  const validatePrescription = async (diagnosis, prescription, timestamp) => {
    if (!diagnosis || !prescription) {
      setValidationResult((prev) => ({
        ...prev,
        [timestamp]: 'Diagnosis or prescription is missing.',
      }));
      return;
    }

    const medicine = typeof prescription === 'object' ? prescription.medicine : prescription;

    try {
      const isValid = await verifyMedicine(diagnosis, medicine);
      if (isValid) {
        setValidationResult((prev) => ({
          ...prev,
          [timestamp]: `Prescription "${medicine}" is valid for diagnosis "${diagnosis}".`,
        }));
      } else {
        setValidationResult((prev) => ({
          ...prev,
          [timestamp]: `Invalid prescription "${medicine}" for diagnosis "${diagnosis}".`,
        }));
        await notifyAdmin(`Patient_${effectivePatientId}`, 'Doctor', diagnosis, medicine);
      }
    } catch (error) {
      setValidationResult((prev) => ({
        ...prev,
        [timestamp]: `Error validating prescription: ${error.message}`,
      }));
      await notifyAdmin(`Patient_${effectivePatientId}`, 'Doctor', diagnosis, medicine);
    }
  };

  const retryUpload = async (audioBlob, language) => {
    if (!audioBlob || !language) {
      setError('Invalid retry data. Please start a new recording.');
      return;
    }

    setError('Retrying upload... (Attempts remaining: 3)');
    let attempts = 3;

    const attemptRetry = async () => {
      try {
        console.log('Retrying upload with:', { language, audioBlobSize: audioBlob.size });
        const transcriptionResult = await transcribeAudio(audioBlob, language, effectiveUserId);
        if (!transcriptionResult.audioUrl) {
          throw new Error('Transcription succeeded, but no audio URL was returned.');
        }
        const response = await fetch(transcriptionResult.audioUrl, { method: 'HEAD', mode: 'cors' });
        if (!response.ok) {
          throw new Error(`Audio URL inaccessible: ${transcriptionResult.audioUrl} (Status: ${response.status})`);
        }
        setError('');
        setFailedUpload(null);
        clearTimeout(retryTimeoutRef.current);

        const message = {
          sender: 'patient',
          text: transcriptionResult.transcription || 'Transcription failed',
          translatedText: transcriptionResult.translatedText || '',
          timestamp: new Date().toISOString(),
          language,
          recordingLanguage: language,
          doctorId,
          userId: effectivePatientId,
          audioUrl: transcriptionResult.audioUrl,
        };

        const formData = new FormData();
        formData.append('audio', audioBlob, `audio_${new Date().toISOString()}.webm`);
        formData.append('message', JSON.stringify(message));
        formData.append('sender', 'patient');

        console.log('Sending retry upload:', {
          url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
          message,
        });

        const idToken = await firebaseUser.getIdToken(true);
        const saveResponse = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
          method: 'POST',
          headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
          body: formData,
          credentials: 'include',
        });

        if (!saveResponse.ok) {
          const errorData = await saveResponse.json();
          throw new Error(`Failed to save message: ${saveResponse.statusText} - ${errorData.error?.message || 'Unknown error'}`);
        }
        const data = await saveResponse.json();
        setMessages((prev) => [...prev, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      } catch (err) {
        console.error('Retry upload failed:', err);
        attempts--;
        if (attempts > 0) {
          setError(`Retrying upload... (Attempts remaining: ${attempts})`);
          retryTimeoutRef.current = setTimeout(attemptRetry, 2000 * (4 - attempts));
        } else {
          setError(`Failed to transcribe audio after retries: ${err.message}`);
          setFailedUpload({ audioBlob, language });
          clearTimeout(retryTimeoutRef.current);
        }
      }
    };

    attemptRetry();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      setMediaRecorder(recorder);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => e.data.size > 0 && audioChunksRef.current.push(e.data);

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size === 0) {
          setError('Recorded audio is empty. Please try again.');
          return;
        }

        if (!effectiveUserId) {
          setError('User authentication failed. Please log in again.');
          navigate('/login');
          return;
        }

        const normalizedTranscriptionLanguage = normalizeLanguageCode(transcriptionLanguage);
        let text, translatedText = null;

        try {
          const transcriptionResult = await transcribeAudio(audioBlob, normalizedTranscriptionLanguage, effectiveUserId);
          text = transcriptionResult.transcription || 'Transcription failed';

          if (languagePreference === 'en' && transcriptionLanguage === 'kn') {
            translatedText = await translateText(text, 'kn', 'en');
          } else if (languagePreference === 'kn' && transcriptionLanguage === 'en') {
            translatedText = await translateText(text, 'en', 'kn');
          } else if (languagePreference === 'kn') {
            translatedText = await translateText(text, 'kn', 'en');
          }

          const message = {
            sender: 'patient',
            text: languagePreference === 'kn' ? text : translatedText || text,
            translatedText: languagePreference === 'kn' ? translatedText : null,
            timestamp: new Date().toISOString(),
            language: transcriptionLanguage,
            recordingLanguage: transcriptionLanguage,
            doctorId,
            userId: effectivePatientId,
            audioUrl: transcriptionResult.audioUrl,
          };

          const formData = new FormData();
          formData.append('audio', audioBlob, `audio_${new Date().toISOString()}.webm`);
          formData.append('message', JSON.stringify(message));
          formData.append('sender', 'patient');

          console.log('Sending audio message:', {
            url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
            message,
            audioSize: audioBlob.size,
          });

          const idToken = await firebaseUser.getIdToken(true);
          const response = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
            method: 'POST',
            headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
            body: formData,
            credentials: 'include',
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to save message: ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
          }
          const data = await response.json();
          setMessages((prev) => [...prev, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
        } catch (err) {
          console.error('Audio processing failed:', err);
          setError(`Failed to process audio: ${err.message}`);
          setFailedUpload({ audioBlob, language: normalizedTranscriptionLanguage });
        }

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      recorder.start();
      setRecording(true);
    } catch (err) {
      console.error('Error starting recording:', err);
      setError(`Error starting recording: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setMediaRecorder(null);
    }
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) {
      setError('No file selected. Please choose an image.');
      return;
    }

    if (!effectiveUserId || !effectivePatientId || !doctorId) {
      setError('Authentication or patient/doctor ID missing. Please log in again.');
      navigate('/login');
      return;
    }

    console.log('Selected file:', {
      name: file.name,
      type: file.type,
      size: file.size,
    });

    const validTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      setError('Invalid file type. Please upload a JPEG, PNG, or GIF image.');
      setFailedUpload({ file, type: 'image' });
      return;
    }
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      setError('File too large. Maximum size is 5MB.');
      setFailedUpload({ file, type: 'image' });
      return;
    }

    const message = {
      sender: 'patient',
      timestamp: new Date().toISOString(),
      doctorId,
      userId: effectivePatientId,
      messageType: 'image',
    };

    const formData = new FormData();
    formData.append('image', file);
    formData.append('message', JSON.stringify(message));
    formData.append('sender', 'patient');

    console.log('Uploading image:', {
      url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
      message,
      file: { name: file.name, type: file.type, size: file.size },
    });

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Image upload failed: ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      if (!data.newMessage.imageUrl) {
        throw new Error('Image upload succeeded, but no image URL was returned.');
      }

      setMessages((prev) => [...prev, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
    } catch (err) {
      console.error('Image upload failed:', err);
      setError(err.message);
      setFailedUpload({ file, type: 'image' });
    }
  };

  const readAloud = async (audioUrl, lang, fallbackText) => {
    try {
      if (!audioUrl && (!fallbackText || typeof fallbackText !== 'string' || fallbackText.trim() === '')) {
        setError('Cannot read aloud: No valid audio or text provided.');
        return;
      }
      const normalizedLang = normalizeLanguageCode(lang);
      const audioToPlay = audioUrl || (await textToSpeechConvert(fallbackText.trim(), normalizedLang));
      audioRef.current.src = audioToPlay;
      await audioRef.current.play();
    } catch (err) {
      console.error('Error reading aloud:', err);
      setError(`Error reading aloud: ${err.message}`);
    }
  };

  const handleSendText = async () => {
    if (!textInput.trim()) return;

    const message = {
      sender: 'patient',
      text: textInput,
      translatedText: null,
      timestamp: new Date().toISOString(),
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
    };

    setMessages((prev) => {
      if (!prev.some((msg) => msg.timestamp === message.timestamp && msg.text === message.text)) {
        return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      }
      console.log('PatientChat.js: Skipped duplicate text message:', message.timestamp, message.text);
      return prev;
    });
    setTextInput('');

    try {
      console.log('Sending text message:', {
        url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
        message,
      });
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': effectiveUserId,
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ message }),
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to save text message: ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
      }
      const data = await response.json();
      setMessages((prev) =>
        [...prev.filter((msg) => msg.timestamp !== message.timestamp), data.newMessage].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp)
        )
      );
    } catch (err) {
      console.error('Failed to save text message:', err);
      setError(`Failed to save text message: ${err.message}`);
      if (err.message.includes('404')) {
        setTimeout(() => handleSendText(), 2000);
      }
    }
  };

  const handleQuickReply = async (replyText) => {
    const message = {
      sender: 'patient',
      text: replyText,
      translatedText: null,
      timestamp: new Date().toISOString(),
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
    };

    setMessages((prev) => {
      if (!prev.some((msg) => msg.timestamp === message.timestamp && msg.text === message.text)) {
        return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      }
      console.log('PatientChat.js: Skipped duplicate quick reply:', message.timestamp, message.text);
      return prev;
    });

    try {
      console.log('Sending quick reply:', {
        url: `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`,
        message,
      });
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(`${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': effectiveUserId,
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ message }),
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to save quick reply message: ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
      }
      const data = await response.json();
      setMessages((prev) =>
        [...prev.filter((msg) => msg.timestamp !== message.timestamp), data.newMessage].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp)
        )
      );
    } catch (err) {
      console.error('Failed to save quick reply:', err);
      setError(`Failed to save quick reply message: ${err.message}`);
    }
  };

  const handleDoctorResponse = (response) => {
    if (response === 'yes') {
      setDoctorPrompt(false);
      localStorage.setItem(`lastContact_${effectivePatientId}_${doctorId}`, new Date().toISOString());
      // Notify server to enable chat (implement server-side logic)
    } else {
      setDoctorPrompt(false);
      navigate('/login'); // Redirect if No
    }
  };

  if (languagePreference === null || transcriptionLanguage === null) {
    return (
      <div className="loading-container">
        <p>Loading language preference...</p>
        <style>{`
          .loading-container {
            width: 100vw;
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
            font-family: 'Poppins', sans-serif;
            color: #E0E0E0;
            font-size: 1.2rem;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="patient-chat-container">
      <div className="chat-header">
        <button className="hamburger-button" onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <h2>Patient Chat (ID: {effectivePatientId})</h2>
        <div className="header-actions">
          <button onClick={handleLogout} className="logout-button">
            Logout
          </button>
        </div>
      </div>
      <div className="chat-layout">
        <div className={`sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Menu</h3>
            <button className="close-menu" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          <ul className="menu-list">
            <li
              onClick={() => {
                setActiveMenuOption('profile');
                setMenuOpen(false);
              }}
              className={activeMenuOption === 'profile' ? 'active' : ''}
            >
              View Profile
            </li>
            <li
              onClick={() => {
                setActiveMenuOption('reminders');
                setMenuOpen(false);
              }}
              className={activeMenuOption === 'reminders' ? 'active' : ''}
            >
              Reminders
            </li>
            <li
              onClick={() => {
                setActiveMenuOption('recommendations');
                setMenuOpen(false);
              }}
              className={activeMenuOption === 'recommendations' ? 'active' : ''}
            >
              Doctor's Recommendations
            </li>
          </ul>
        </div>
        <div className="chat-content">
          {doctorPrompt && (
            <div className="doctor-prompt">
              <p>Allow communication with doctor? (First contact or 7+ days)</p>
              <button onClick={() => handleDoctorResponse('yes')}>Yes</button>
              <button onClick={() => handleDoctorResponse('no')}>No</button>
            </div>
          )}
          {activeMenuOption === 'profile' && profileData && (
            <div className="profile-section">
              <h3>Patient Profile</h3>
              <p><strong>Name:</strong> {profileData.name}</p>
              <p><strong>Patient ID:</strong> {profileData.patientId}</p>
              <p><strong>Email:</strong> {profileData.email}</p>
              <p><strong>Language Preference:</strong> {profileData.languagePreference === 'kn' ? 'Kannada' : 'English'}</p>
              <p><strong>Sex:</strong> {profileData.sex}</p>
              <p><strong>Age:</strong> {profileData.age}</p>
              <p><strong>Address:</strong> {profileData.address}</p>
              <button onClick={() => setActiveMenuOption(null)} className="close-section-button">
                Close
              </button>
            </div>
          )}
          {activeMenuOption === 'reminders' && (
            <div className="reminders-section">
              <h3>Medication Reminders</h3>
              <p><strong>Adherence Rate:</strong> {adherenceRate}% (Taken {reminders.filter((r) => r.status === 'taken').length} of {reminders.length})</p>
              <p><strong>Missed Doses:</strong> {missedDoses}</p>
              {missedDoseAlerts.length > 0 && (
                <div className="missed-dose-alerts">
                  {missedDoseAlerts.map((alert) => (
                    <div key={alert.id} className="alert-item">
                      <p>{alert.message}</p>
                    </div>
                  ))}
                </div>
              )}
              {reminders.length > 0 ? (
                <div className="reminders-table">
                  <div className="table-header">
                    <span>Medicine</span>
                    <span>Dosage</span>
                    <span>Time</span>
                    <span>Status</span>
                    <span>Actions</span>
                  </div>
                  {reminders
                    .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime))
                    .map((reminder) => (
                      <div key={reminder.id} className="table-row">
                        <span>{reminder.medicine}</span>
                        <span>{reminder.dosage}</span>
                        <span>{new Date(reminder.scheduledTime).toLocaleString()}</span>
                        <span>{reminder.status}</span>
                        <span>
                          {reminder.status === 'pending' || reminder.status === 'snoozed' ? (
                            <>
                              <button
                                onClick={() => handleConfirmReminder(reminder.id)}
                                className="confirm-button"
                              >
                                Taken
                              </button>
                              <button
                                onClick={() => handleSnoozeReminder(reminder.id)}
                                className="snooze-button"
                              >
                                Snooze
                              </button>
                            </>
                          ) : (
                            '-'
                          )}
                        </span>
                      </div>
                    ))}
                </div>
              ) : (
                <p>No reminders set yet. Waiting for doctor's prescription.</p>
              )}
              <button onClick={() => setActiveMenuOption(null)} className="close-section-button">
                Close
              </button>
            </div>
          )}
          {activeMenuOption === 'recommendations' && (
            <div className="recommendations-section">
              <h3>Doctor's Recommendations</h3>
              {missedDoseAlerts.length > 0 && (
                <div className="missed-dose-alerts">
                  {missedDoseAlerts.map((alert) => (
                    <div key={alert.id} className="alert-item">
                      <p>{alert.message}</p>
                    </div>
                  ))}
                </div>
              )}
              {messages.filter((msg) => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription)).length > 0 ? (
                messages
                  .filter((msg) => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription))
                  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                  .map((msg, index) => (
                    <div key={`${msg.timestamp}-${index}`}>
                      {msg.diagnosis && (
                        <div className="recommendation-item">
                          <strong>Diagnosis:</strong>{' '}
                          {languagePreference === 'kn' ? msg.translatedDiagnosis || msg.diagnosis : msg.diagnosis}
                          <button
                            onClick={() =>
                              readAloud(
                                null,
                                languagePreference,
                                languagePreference === 'kn'
                                  ? msg.translatedDiagnosis || msg.diagnosis
                                  : msg.diagnosis
                              )
                            }
                            className="read-aloud-button"
                          >
                            🔊 ({languagePreference === 'kn' ? 'Kannada' : 'English'})
                          </button>
                        </div>
                      )}
                      {msg.prescription && (
                        <div className="recommendation-item">
                          <strong>Prescription:</strong>{' '}
                          {typeof msg.prescription === 'object'
                            ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                            : msg.prescription}
                          <button
                            onClick={() =>
                              validatePrescription(msg.diagnosis, msg.prescription, msg.timestamp)
                            }
                            className="validate-button"
                          >
                            ✅ Validate
                          </button>
                          {validationResult[msg.timestamp] && (
                            <span
                              className={
                                validationResult[msg.timestamp].includes('valid')
                                  ? 'validation-success'
                                  : 'validation-error'
                              }
                            >
                              {validationResult[msg.timestamp]}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))
              ) : (
                <p>No recommendations from the doctor yet.</p>
              )}
              <button onClick={() => setActiveMenuOption(null)} className="close-section-button">
                Close
              </button>
            </div>
          )}
          {activeMenuOption === null && (
            <div className="messages-container">
              {missedDoseAlerts.length > 0 && (
                <div className="missed-dose-alerts">
                  {missedDoseAlerts.map((alert) => (
                    <div key={alert.id} className="alert-item">
                      <p>{alert.message}</p>
                    </div>
                  ))}
                </div>
              )}
              {messages.length === 0 && <p className="no-messages">No messages yet.</p>}
              {messages.map((msg, index) => (
                <div
                  key={`${msg.timestamp}-${index}`}
                  className={`message ${msg.sender === 'patient' ? 'patient-message' : 'doctor-message'}`}
                >
                  <div className="message-content">
                    {msg.sender === 'patient' && (
                      <>
                        {languagePreference === 'en' ? (
                          <div className="message-block">
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            {msg.audioUrl && (
                              <div className="audio-container">
                                <audio controls src={msg.audioUrl} />
                                <button
                                  onClick={() => readAloud(msg.audioUrl, 'en', msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (English)
                                </button>
                                <a href={msg.audioUrl} download className="download-link">
                                  Download Audio
                                </a>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="message-block">
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            {msg.translatedText && (
                              <p className="translated-text">English: {msg.translatedText}</p>
                            )}
                            {msg.audioUrl && (
                              <div className="audio-container">
                                <audio controls src={msg.audioUrl} />
                                <button
                                  onClick={() => readAloud(msg.audioUrl, 'kn', msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (Kannada)
                                </button>
                                <button
                                  onClick={() => readAloud(msg.audioUrl, 'en', msg.translatedText || msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (English)
                                </button>
                                <a href={msg.audioUrl} download className="download-link">
                                  Download Audio
                                </a>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {msg.sender === 'doctor' && (
                      <div className="message-block">
                        {languagePreference === 'en' ? (
                          <p className="primary-text">{msg.text || 'No transcription'}</p>
                        ) : (
                          <>
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            {msg.translatedText && (
                              <p className="translated-text">English: {msg.translatedText}</p>
                            )}
                          </>
                        )}
                        {msg.audioUrl && (
                          <div className="audio-container">
                            <audio controls src={msg.audioUrl} />
                            {languagePreference === 'en' ? (
                              <button
                                onClick={() => readAloud(msg.audioUrl, 'en', msg.text)}
                                className="read-aloud-button"
                              >
                                🔊 (English)
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => readAloud(msg.audioUrl, 'kn', msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (Kannada)
                                </button>
                                <button
                                  onClick={() => readAloud(msg.audioUrl, 'en', msg.translatedText || msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (English)
                                </button>
                              </>
                            )}
                            <a href={msg.audioUrl} download className="download-link">
                              Download Audio
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                    {msg.imageUrl && <img src={msg.imageUrl} alt="Patient upload" className="chat-image" />}
                    {msg.audioError && <p className="audio-error">{msg.audioError}</p>}
                    <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
          {error && (
            <div className="error-message">
              {error}
              {failedUpload && failedUpload.audioBlob && (
                <button onClick={() => retryUpload(failedUpload.audioBlob, failedUpload.language)} className="retry-button">
                  Retry Upload
                </button>
              )}
              {failedUpload && failedUpload.type === 'image' && failedUpload.file && (
                <button onClick={() => handleImageUpload({ target: { files: [failedUpload.file] } })} className="retry-button">
                  Retry Image Upload
                </button>
              )}
            </div>
          )}
          {activeMenuOption === null && (
            <div className="controls">
              <div className="language-buttons">
                <button
                  onClick={() => setTranscriptionLanguage('kn')}
                  className={transcriptionLanguage === 'kn' ? 'active-lang' : ''}
                >
                  Kannada
                </button>
                <button
                  onClick={() => setTranscriptionLanguage('en')}
                  className={transcriptionLanguage === 'en' ? 'active-lang' : ''}
                >
                  English
                </button>
              </div>
              <div className="recording-buttons">
                <button
                  onClick={startRecording}
                  disabled={recording}
                  className={recording ? 'disabled-button' : 'start-button'}
                >
                  🎙️ Start Recording
                </button>
                <button
                  onClick={stopRecording}
                  disabled={!recording}
                  className={!recording ? 'disabled-button' : 'stop-button'}
                >
                  🛑 Stop Recording
                </button>
                <label className="image-upload">
                  📷 Upload Image
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif"
                    onChange={handleImageUpload}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
              <div className="text-input-container">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Type your message (English only)..."
                  onKeyPress={(e) => e.key === 'Enter' && handleSendText()}
                />
                <button onClick={handleSendText} className="send-button">
                  Send
                </button>
              </div>
              <div className="quick-replies">
                <button onClick={() => handleQuickReply("Let's do it")}>Let's do it</button>
                <button onClick={() => handleQuickReply('Great!')}>Great!</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .patient-chat-container {
          width: 100vw;
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: linear-gradient(135deg, #2C1A3D, #3E2A5A);
          font-family: 'Poppins', sans-serif;
          color: #E0E0E0;
          overflow: hidden;
        }

        .chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 30px;
          background: rgba(44, 26, 61, 0.8);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .hamburger-button {
          background: none;
          border: none;
          color: #FFFFFF;
          font-size: 1.8rem;
          cursor: pointer;
          transition: transform 0.3s ease;
        }

        .hamburger-button:hover {
          transform: scale(1.1);
        }

        .chat-header h2 {
          font-size: 1.8rem;
          font-weight: 600;
          color: #FFFFFF;
          position: relative;
        }

        .chat-header h2::after {
          content: '';
          width: 40px;
          height: 4px;
          background: #6E48AA;
          position: absolute;
          bottom: -5px;
          left: 0;
          border-radius: 2px;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 15px;
        }

        .logout-button {
          padding: 8px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 25px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .logout-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .chat-layout {
          display: flex;
          flex: 1;
          overflow: hidden;
        }

        .sidebar {
          width: 0;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          padding: 0;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          overflow-y: auto;
          transition: width 0.3s ease, padding 0.3s ease;
        }

        .sidebar.open {
          width: 250px;
          padding: 20px;
        }

        .sidebar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .sidebar-header h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
        }

        .close-menu {
          background: none;
          border: none;
          color: #FFFFFF;
          font-size: 1.5rem;
          cursor: pointer;
          transition: transform 0.3s ease;
        }

        .close-menu:hover {
          transform: scale(1.1);
        }

        .menu-list {
          list-style: none;
          padding: 0;
        }

        .menu-list li {
          padding: 15px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          margin-bottom: 10px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .menu-list li:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: translateX(5px);
        }

        .menu-list li.active {
          background: #6E48AA;
          color: #FFFFFF;
        }

        .chat-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 20px 30px;
          overflow-y: auto;
        }

        .doctor-prompt {
          background: rgba(255, 255, 255, 0.05);
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 20px;
          text-align: center;
        }

        .doctor-prompt button {
          padding: 8px 20px;
          margin: 0 10px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          cursor: pointer;
          transition: background 0.3s ease;
        }

        .doctor-prompt button:hover {
          background: #5A3E8B;
        }

        .profile-section,
        .reminders-section,
        .recommendations-section {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 20px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .profile-section h3,
        .reminders-section h3,
        .recommendations-section h3 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #FFFFFF;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .profile-section h3::before {
          content: '👤';
          font-size: 1.4rem;
        }

        .reminders-section h3::before {
          content: '⏰';
          font-size: 1.4rem;
        }

        .recommendations-section h3::before {
          content: '⚕️';
          font-size: 1.4rem;
        }

        .profile-section p,
        .reminders-section p,
        .recommendations-section p {
          font-size: 1rem;
          margin-bottom: 10px;
        }

        .close-section-button {
          padding: 8px 20px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
          margin-top: 10px;
        }

        .close-section-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
        }

        .reminders-table {
          width: 100%;
          border-collapse: collapse;
        }

        .table-header,
        .table-row {
          display: flex;
          justify-content: space-between;
          padding: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .table-header {
          font-weight: 600;
          color: #FFFFFF;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px 10px 0 0;
        }

        .table-row {
          background: rgba(255, 255, 255, 0.05);
        }

        .table-header span,
        .table-row span {
          flex: 1;
          text-align: center;
        }

        .table-row span:last-child {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 10px;
        }

        .confirm-button {
          padding: 5px 10px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 10px;
          cursor: pointer;
        }

        .confirm-button:hover {
          background: #219653;
        }

        .snooze-button {
          padding: 5px 10px;
          background: #F39C12;
          color: #FFFFFF;
          border: none;
          border-radius: 10px;
          cursor: pointer;
        }

        .snooze-button:hover {
          background: #E67E22;
        }

        .missed-dose-alerts {
          background: rgba(231, 76, 60, 0.1);
          border-radius: 10px;
          padding: 15px;
          margin-bottom: 20px;
          border: 1px solid rgba(231, 76, 60, 0.3);
        }

        .alert-item {
          background: rgba(231, 76, 60, 0.2);
          border-radius: 8px;
          padding: 10px;
          margin-bottom: 10px;
          animation: fadeIn 0.5s ease-in-out;
        }

        .alert-item p {
          font-size: 1rem;
          color: #E74C3C;
        }

        .recommendation-item {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          padding: 15px;
          margin-bottom: 10px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 1rem;
          color: #E0E0E0;
          flex-wrap: wrap;
        }

        .recommendation-item strong {
          color: #FFFFFF;
        }

        .messages-container {
          flex: 1;
          padding: 20px;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          overflow-y: auto;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .no-messages {
          color: #A0A0A0;
          font-size: 1rem;
          text-align: center;
          margin-top: 20px;
        }

        .message {
          display: flex;
          margin-bottom: 20px;
          max-width: 70%;
          position: relative;
        }

        .patient-message {
          margin-left: auto;
          justify-content: flex-end;
        }

        .doctor-message {
          margin-right: auto;
          justify-content: flex-start;
        }

        .message-content {
          padding: 15px;
          border-radius: 15px;
          position: relative;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .patient-message .message-content {
          background: #6E48AA;
          color: #FFFFFF;
          border-bottom-right-radius: 5px;
        }

        .doctor-message .message-content {
          background: #4A3270;
          color: #E0E0E0;
          border-bottom-left-radius: 5px;
        }

        .message-content:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }

        .message-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .primary-text {
          margin: 0;
          font-size: 1rem;
          line-height: 1.4;
        }

        .translated-text {
          font-size: 0.85rem;
          font-style: italic;
          color: #B0B0B0;
          margin: 0;
        }

        .audio-container {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .audio-container audio {
          width: 100%;
          border-radius: 10px;
        }

        .download-link {
          font-size: 0.85rem;
          color: #6E48AA;
          text-decoration: none;
          transition: color 0.3s ease;
        }

        .download-link:hover {
          color: #9D50BB;
          text-decoration: underline;
        }

        .read-aloud-buttons {
          display: flex;
          gap: 10px;
        }

        .read-aloud-button {
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.1);
          color: #FFFFFF;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .read-aloud-button:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.05);
        }

        .validate-button {
          padding: 6px 12px;
          background: rgba(39, 174, 96, 0.2);
          color: #27AE60;
          border: 1px solid #27AE60;
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .validate-button:hover {
          background: rgba(39, 174, 96, 0.4);
          transform: scale(1.05);
        }

        .validation-success {
          margin-left: 10px;
          font-size: 0.9rem;
          color: #27AE60;
        }

        .validation-error {
          margin-left: 10px;
          font-size: 0.9rem;
          color: #E74C3C;
        }

        .chat-image {
          max-width: 100%;
          border-radius: 10px;
          margin-top: 10px;
        }

        .timestamp {
          font-size: 0.8rem;
          color: #A0A0A0;
          margin-top: 8px;
          display: block;
        }

        .audio-error {
          font-size: 0.85rem;
          color: #E74C3C;
          margin-top: 5px;
        }

        .error-message {
          color: #E74C3C;
          font-size: 0.9rem;
          text-align: center;
          margin-bottom: 20px;
          animation: shake 0.5s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          background: rgba(231, 76, 60, 0.2);
          padding: 10px;
          border-radius: 8px;
          border: 1px solid rgba(231, 76, 60, 0.3);
        }

        .retry-button {
          padding: 6px 12px;
          background: #F39C12;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .retry-button:hover {
          background: #E67E22;
          transform: scale(1.05);
        }

        .controls {
          background: rgba(44, 26, 61, 0.8);
          backdrop-filter: blur(10px);
          padding: 20px;
          border-radius: 15px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .language-buttons {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }

        .language-buttons button {
          padding: 8px 20px;
          background: rgba(255, 255, 255, 0.1);
          color: #E0E0E0;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .language-buttons .active-lang {
          background: #6E48AA;
          color: #FFFFFF;
          border-color: #6E48AA;
          transform: scale(1.05);
        }

        .language-buttons button:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.05);
        }

        .recording-buttons {
          display: flex;
          gap: 10px;
          align-items: center;
          margin-bottom: 15px;
        }

        .start-button {
          padding: 8px 20px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .start-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .stop-button {
          padding: 8px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .stop-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .disabled-button {
          padding: 8px 20px;
          background: #666;
          color: #A0A0A0;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: not-allowed;
        }

        .image-upload {
          padding: 8px 20px;
          background: rgba(255, 255, 255, 0.1);
          color: #E0E0E0;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .image-upload:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.05);
        }

        .text-input-container {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }

        .text-input-container input {
          flex: 1;
          padding: 12px 20px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 25px;
          font-size: 1rem;
          color: #FFFFFF;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }




        .text-input-container input:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
          background: rgba(255, 255, 255, 0.05);
        }

        .text-input-container input::placeholder {
          color: #A0A0A0;
        }

        .send-button {
          padding: 12px 30px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 25px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .send-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
        }

        .quick-replies {
          display: flex;
          gap: 10px;
          justify-content: center;
        }

        .quick-replies button {
          padding: 8px 20px;
          background: rgba(255, 255, 255, 0.1);
          color: #E0E0E0;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 20px;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .quick-replies button:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.05);
        }

        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
          20%, 40%, 60%, 80% { transform: translateX(5px); }
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

export default PatientChat;