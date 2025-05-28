import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Pusher from 'pusher-js';
import {
  transcribeAudio,
  translateText,
  textToSpeechConvert,
  detectLanguage,
  playAudio,
} from '../services/speech.js';
import { verifyMedicine, notifyAdmin } from '../services/medicineVerify.js';
import { doc, getDoc, collection, getDocs, updateDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../services/firebase.js';
import { signOut, updatePassword } from 'firebase/auth';
import '../components/patient.css';

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
  const [doctorPrompt, setDoctorPrompt] = useState(null);
  const [doctorName, setDoctorName] = useState('Unknown Doctor');
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editProfileData, setEditProfileData] = useState(null);
  const audioChunksRef = useRef([]);
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
  const pusherKey = process.env.REACT_APP_PUSHER_KEY || '2ed44c3ce3ef227d9924';
  const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'ap2';

  // Fetch interceptor for debugging
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      console.log('Fetch request:', args[0], { method: args[1]?.method, mode: args[1]?.mode });
      try {
        const response = await originalFetch(...args);
        if (!response.ok) {
          console.warn(`Fetch failed: ${args[0]} - Status ${response.status}`);
        }
        return response;
      } catch (err) {
        console.error(`Fetch error for ${args[0]}:`, err);
        throw err;
      }
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

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

  // Validate user state and fetch patient and doctor data
  useEffect(() => {
    if (!firebaseUser || !effectiveUserId || !effectivePatientId || !doctorId || role !== 'patient') {
      console.log('PatientChat: Invalid user state or missing params, redirecting to /login', {
        firebaseUser,
        effectiveUserId,
        effectivePatientId,
        doctorId,
        role,
      });
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
            name: data.name || 'Unknown Patient',
            patientId: effectivePatientId,
            email: data.email || 'N/A',
            languagePreference: pref,
            sex: data.sex || 'N/A',
            age: data.age || 'N/A',
            address: data.address || 'N/A',
            phoneNumber: data.phoneNumber || 'N/A',
            aadhaarNumber: data.aadhaarNumber || 'N/A',
          });
          setEditProfileData({
            name: data.name || '',
            password: '',
            age: data.age || '',
            sex: data.sex || '',
            address: data.address || '',
            phoneNumber: data.phoneNumber || '',
          });
        } else {
          setError('Patient not found or unauthorized.');
          navigate('/login');
        }
      } catch (err) {
        console.error('PatientChat: Failed to fetch patient data:', err.message);
        setError(`Failed to fetch patient data: ${err.message}`);
        navigate('/login');
      }
    };

    const fetchDoctorData = async () => {
      try {
        const doctorRef = doc(db, 'doctors', doctorId);
        const doctorDoc = await getDoc(doctorRef);
        if (doctorDoc.exists()) {
          setDoctorName(doctorDoc.data().name || 'Unknown Doctor');
        } else {
          console.warn('Doctor not found, using default name:', doctorId);
        }
      } catch (err) {
        console.error('PatientChat: Failed to fetch doctor data:', err.message);
        setDoctorName('Unknown Doctor');
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
        console.error('PatientChat: Failed to fetch reminders:', err.message);
        setError(`Failed to fetch reminders: ${err.message}`);
      }
    };

    const checkDoctorPrompt = async () => {
      const lastContact = localStorage.getItem(`lastContact_${effectivePatientId}_${doctorId}`);
      const now = new Date();
      if (!lastContact || now - new Date(lastContact) > 7 * 24 * 60 * 60 * 1000) {
        setDoctorPrompt(true);
      }
    };

    fetchPatientData();
    fetchDoctorData();
    fetchReminders();
    checkDoctorPrompt();

    return () => {
      reminderTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
      reminderTimeoutsRef.current.clear();
      clearTimeout(retryTimeoutRef.current);
    };
  }, [firebaseUser, effectiveUserId, effectivePatientId, doctorId, role, navigate]);

  // Handle profile update
  const handleProfileUpdate = async () => {
    if (!firebaseUser) {
      setError('User authentication failed. Please log in again.');
      navigate('/login');
      return;
    }

    try {
      const patientRef = doc(db, 'patients', effectivePatientId);

      if (!editProfileData.name || !editProfileData.age || !editProfileData.sex || !editProfileData.address || !editProfileData.phoneNumber) {
        setError('Please fill in all editable fields.');
        return;
      }

      const phoneRegex = /^\+?[1-9]\d{1,14}$/;
      if (!phoneRegex.test(editProfileData.phoneNumber)) {
        setError('Invalid phone number format. Please use a valid format (e.g., +918792693974).');
        return;
      }

      const ageNum = Number(editProfileData.age);
      if (isNaN(ageNum) || ageNum < 0 || ageNum > 150) {
        setError('Please enter a valid age between 0 and 150.');
        return;
      }

      const validSexOptions = ['Male', 'Female', 'Other'];
      if (!validSexOptions.includes(editProfileData.sex)) {
        setError('Please select a valid sex: Male, Female, or Other.');
        return;
      }

      const updatedData = {
        name: editProfileData.name,
        age: ageNum,
        sex: editProfileData.sex,
        address: editProfileData.address,
        phoneNumber: editProfileData.phoneNumber,
      };

      await updateDoc(patientRef, updatedData);

      if (editProfileData.password) {
        if (editProfileData.password.length < 6) {
          setError('Password must be at least 6 characters long.');
          return;
        }
        await updatePassword(firebaseUser, editProfileData.password);
      }

      setProfileData((prev) => ({
        ...prev,
        ...updatedData,
      }));

      setIsEditingProfile(false);
      setError('Profile updated successfully!');
    } catch (err) {
      console.error('Failed to update profile:', err.message);
      setError(`Failed to update profile: ${err.message}`);
    }
  };

  // Handle Pusher and message fetching with session handling
  useEffect(() => {
    if (!firebaseUser || !languagePreference) return;

    const fetchMessages = async () => {
      try {
        const fetchUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
        console.log('Fetching messages:', { url: fetchUrl, userId: effectiveUserId });
        const idToken = await firebaseUser.getIdToken(true);
        const response = await fetch(fetchUrl, {
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
          throw new Error(`Failed to fetch messages: ${response.status} - ${errorData.message || 'Unknown error'}`);
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
        console.error('PatientChat: Error fetching messages:', err.message);
        setError(`Error fetching messages: ${err.message}`);
        if (err.message.includes('404')) {
          setTimeout(fetchMessages, 2000);
        }
      }
    };

    try {
      const pusherConfig = {
        cluster: pusherCluster,
        authEndpoint: `${apiBaseUrl}/pusher/auth`,
        auth: { headers: { 'x-user-uid': effectiveUserId } },
        userAuthentication: {
          endpoint: `${apiBaseUrl}/pusher/user-auth`,
          transport: 'ajax',
          headers: { 'x-user-uid': effectiveUserId },
        },
      };

      if (pusherRef.current) {
        pusherRef.current.disconnect();
        pusherRef.current = null;
      }

      pusherRef.current = new Pusher(pusherKey, pusherConfig);

      pusherRef.current.connection.bind('error', (err) => {
        console.error('Pusher connection error:', err);
        setError('Failed to connect to real-time messaging. Attempting to reconnect...');
        setTimeout(() => {
          if (pusherRef.current) pusherRef.current.connect();
        }, 2000);
      });

      pusherRef.current.connection.bind('connected', () => {
        console.log('Pusher connected successfully');
        setError('');
      });

      const channelName = `chat-${effectivePatientId}-${doctorId}`;
      const channel = pusherRef.current.subscribe(channelName);

      channel.bind('new-message', async (message) => {
        console.log('PatientChat: Received new message:', {
          ...message,
          audioUrl: message.audioUrl ? '[Audio URL]' : null,
        });

        let updatedMessage = { ...message };

        if (message.sender === 'doctor' && languagePreference === 'kn' && !message.diagnosis && !message.prescription) {
          try {
            const idToken = await firebaseUser.getIdToken(true);
            const kannadaText = await translateText(message.text, 'en-US', 'kn-IN', effectiveUserId, idToken);
            updatedMessage = {
              ...message,
              text: kannadaText,
              translatedText: message.text,
            };
          } catch (err) {
            console.error('Failed to translate doctor message:', err);
            setError(`Failed to translate doctor's message: ${err.message}`);
          }
        }

        setMessages((prev) => {
          const isDuplicate = prev.some(
            (msg) =>
              msg.sender === updatedMessage.sender &&
              msg.text === updatedMessage.text &&
              msg.audioUrl === updatedMessage.audioUrl &&
              msg.imageUrl === updatedMessage.imageUrl &&
              Math.abs(new Date(msg.timestamp) - new Date(updatedMessage.timestamp)) < 1000
          );
          if (isDuplicate) {
            console.log('PatientChat: Skipped duplicate message from Pusher:', updatedMessage.timestamp, updatedMessage.text);
            return prev;
          }
          return [...prev, updatedMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        });

        if (updatedMessage.sender === 'doctor') {
          if (updatedMessage.diagnosis || updatedMessage.prescription) {
            validatePrescription(updatedMessage.diagnosis || '', updatedMessage.prescription || '', updatedMessage.timestamp);
            setupMedicationSchedule(updatedMessage.diagnosis, updatedMessage.prescription, updatedMessage.timestamp);
          }
        }
      });

      channel.bind('admin-notification', (alert) => {
        setMissedDoseAlerts((prev) => [...prev, { ...alert, id: Date.now().toString() }]);
      });

      fetchMessages();
    } catch (err) {
      console.error('Pusher initialization failed:', err);
      setError('Failed to initialize real-time messaging. Please refresh the page or check your session.');
    }

    return () => {
      if (pusherRef.current) {
        pusherRef.current.unsubscribe(`chat-${effectivePatientId}-${doctorId}`);
        pusherRef.current.disconnect();
        console.log('PatientChat: Pusher disconnected');
      }
    };
  }, [firebaseUser, effectiveUserId, effectivePatientId, doctorId, languagePreference, apiBaseUrl, pusherKey, pusherCluster]);

  // Process prescriptions and diagnoses together
  const setupMedicationSchedule = async (diagnosis, prescription, issuanceTimestamp) => {
    console.log('setupMedicationSchedule: Received:', { diagnosis, prescription, issuanceTimestamp });

    if (!prescription || !issuanceTimestamp) {
      setError('Prescription or issuance timestamp is missing.');
      console.error('setupMedicationSchedule: Prescription or timestamp is undefined');
      return;
    }

    let medicine, dosage, times, durationDays, timesStr;

    const prescriptionText = typeof prescription === 'object'
      ? `${prescription.medicine}, ${prescription.dosage}, ${prescription.frequency || ''}, ${prescription.duration || '5'}`
      : prescription;

    if (typeof prescriptionText === 'object') {
      medicine = prescriptionText.medicine;
      dosage = prescriptionText.dosage;
      const frequency = prescriptionText.frequency || '';
      durationDays = prescriptionText.duration || '5';
      timesStr = frequency;
      times = frequency.split(' and ').map((t) => t.trim());
    } else if (typeof prescriptionText === 'string') {
      const regex = /(.+?),\s*(\d+mg),\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM)(?:\s*and\s*\d{1,2}[:.]\d{2}\s*(?:AM|PM))?),?\s*(\d+)\s*days?/i;
      const match = prescriptionText.match(regex);
      if (!match) {
        setError('Invalid prescription string format.');
        console.error('setupMedicationSchedule: Invalid prescription string:', prescriptionText);
        return;
      }
      [, medicine, dosage, timesStr, durationDays] = match;
      times = timesStr.split(' and ').map((t) => t.trim());
    } else {
      setError('Unsupported prescription format.');
      console.error('setupMedicationSchedule: Unsupported prescription type:', typeof prescriptionText);
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
      return { hours, minutes, original: timeStr };
    };

    const timeSchedules = times.map(parseTime);

    const issuanceTime = new Date(issuanceTimestamp);
    let startDate = new Date(issuanceTime);

    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    const newReminders = [];
    let dosesScheduled = 0;

    for (let dayOffset = 0; dayOffset < days; dayOffset++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + dayOffset);
      const dateStr = currentDate.toISOString().split('T')[0];

      for (let i = 0; i < timeSchedules.length; i++) {
        const time = timeSchedules[i];
        const timeStr = times[i];

        const scheduledDate = new Date(currentDate);
        scheduledDate.setHours(time.hours, time.minutes, 0, 0);

        const now = new Date();
        if (scheduledDate <= now) {
          continue;
        }

        const reminderId = `${medicine}_${dateStr}_${timeStr.replace(/[:.\s]/g, '-')}`;
        const reminderRef = doc(db, `patients/${effectivePatientId}/reminders`, reminderId);
        const reminder = {
          medicine,
          dosage,
          scheduledTime: scheduledDate.toISOString(),
          status: 'pending',
          snoozeCount: 0,
          createdAt: new Date().toISOString(),
          patientId: effectivePatientId,
          diagnosis: diagnosis || 'Not specified',
        };

        try {
          const reminderSnap = await getDoc(reminderRef);
          if (reminderSnap.exists()) {
            console.log(`setupMedicationSchedule: Reminder ${reminderId} exists, updating`);
            await setDoc(reminderRef, reminder, { merge: true });
          } else {
            console.log(`setupMedicationSchedule: Creating reminder ${reminderId}`);
            await setDoc(reminderRef, reminder);
          }
          newReminders.push({ id: reminderId, ...reminder });
          dosesScheduled++;
        } catch (err) {
          console.error('setupMedicationSchedule: Failed to add reminder:', err.message);
          setError(`Failed to add reminder: ${err.message}`);
        }
      }
    }

    if (newReminders.length > 0) {
      setReminders((prev) => {
        const otherReminders = prev.filter((r) => !r.id.startsWith(medicine));
        const updatedReminders = [...otherReminders, ...newReminders];
        return updatedReminders.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
      });
      scheduleReminders(newReminders);
      console.log('setupMedicationSchedule: Added reminders:', newReminders);
    } else {
      console.warn('setupMedicationSchedule: No new reminders added (all scheduled times in the past)');
      setError('No future reminders scheduled.');
    }
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
              body: `Time to take ${reminder.dosage} of ${reminder.medicine} at ${new Date(reminder.scheduledTime).toLocaleTimeString('en-US', { hour12: true })}. Tap to confirm or snooze.`,
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
    const taken = remindersList.filter((r) => r.status === 'taken').length;
    const total = remindersList.length;
    const rate = (taken / total) * 100;
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

  const writeWithRetry = async (ref, data, options, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await setDoc(ref, data, options);
        console.log(`Firestore write successful for ${ref.path} on attempt ${attempt}`);
        return;
      } catch (error) {
        console.warn(`Retry ${attempt}/${retries} failed for ${ref.path}: ${error.message}`);
        if (attempt === retries) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  };

  const sendMissedDoseAlert = async () => {
    if (!firebaseUser) {
      setError('User authentication failed. Cannot send missed dose alert.');
      return;
    }

    if (!effectivePatientId || !doctorId) {
      setError('Invalid patient or doctor ID. Cannot send missed dose alert.');
      console.error('sendMissedDoseAlert: Invalid IDs', { effectivePatientId, doctorId });
      return;
    }

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const alertData = {
        patientId: effectivePatientId,
        doctorId,
        message: `Patient has missed 3 consecutive doses on ${new Date().toLocaleString()}.`,
        timestamp: new Date().toISOString(),
        userId: effectiveUserId,
      };

      console.log('sendMissedDoseAlert: Preparing to write alert:', alertData);
      const alertRef = doc(collection(db, 'missed_dose_alerts'));
      await writeWithRetry(alertRef, alertData, {});

      const notificationResponse = await notifyAdmin(
        profileData?.name || 'Unknown Patient',
        doctorId,
        alertData.message,
        effectivePatientId,
        doctorId,
        effectiveUserId,
        idToken
      );
      if (!notificationResponse.success) {
        throw new Error(notificationResponse.message || 'Failed to notify admin.');
      }

      setMissedDoseAlerts((prev) => [...prev, { id: alertRef.id, ...alertData }]);
      console.log('Missed dose alert sent successfully:', alertData);
    } catch (err) {
      console.error('Failed to send missed dose alert:', err.message);
      setError(`Failed to send missed dose alert: ${err.message}. Retrying in 5 seconds...`);
      setTimeout(sendMissedDoseAlert, 5000);
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
      const snoozeTime = new Date(new Date(reminder.scheduledTime).getTime() + 10 * 60 * 1000);

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
    if (!firebaseUser) {
      setError('User authentication failed. Cannot validate prescription.');
      return;
    }

    console.log('Validating prescription:', { diagnosis, prescription, timestamp });

    if (!diagnosis || !prescription) {
      console.warn('Diagnosis or prescription missing:', { diagnosis, prescription });
      setValidationResult((prev) => ({
        ...prev,
        [timestamp]: 'Diagnosis or prescription is missing.',
      }));
      return;
    }

    let englishDiagnosis = diagnosis;
    if (languagePreference === 'kn' && messages.find(msg => msg.timestamp === timestamp)?.translatedDiagnosis) {
      englishDiagnosis = messages.find(msg => msg.timestamp === timestamp)?.diagnosis || diagnosis;
    }

    const medicine = typeof prescription === 'object' ? prescription.medicine : prescription.split(',')[0].trim();
    console.log('Extracted medicine:', medicine);

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const isValid = await verifyMedicine(
        englishDiagnosis,
        medicine,
        effectiveUserId,
        idToken,
        profileData || {},
        doctorId,
        doctorName
      );
      console.log('verifyMedicine response:', isValid);

      if (isValid.success) {
        setValidationResult((prev) => ({
          ...prev,
          [timestamp]: `Prescription "${medicine}" is valid for diagnosis "${englishDiagnosis}".`,
        }));
      } else {
        setValidationResult((prev) => ({
          ...prev,
          [timestamp]: `Invalid prescription "${medicine}" for diagnosis "${englishDiagnosis}".`,
        }));
        const notificationMessage = `Invalid prescription: "${medicine}" for diagnosis "${englishDiagnosis}" (Patient: ${profileData?.name || 'Unknown Patient'}, Doctor: ${doctorName})`;
        const notificationResponse = await notifyAdmin(
          profileData?.name || 'Unknown Patient',
          doctorName,
          notificationMessage,
          effectivePatientId,
          doctorId,
          effectiveUserId,
          idToken
        );
        if (!notificationResponse.success) {
          throw new Error(notificationResponse.message || 'Failed to notify admin about invalid prescription.');
        }
      }
    } catch (error) {
      console.error('Error in validatePrescription:', error.message);
      setValidationResult((prev) => ({
        ...prev,
        [timestamp]: `Error validating prescription: ${error.message}. Retrying in 5 seconds...`,
      }));
      const notificationMessage = `Error validating prescription: ${error.message} (Diagnosis: ${englishDiagnosis}, Medicine: ${medicine}, Patient: ${profileData?.name || 'Unknown Patient'}, Doctor: ${doctorName})`;
      setTimeout(() => validatePrescription(englishDiagnosis, prescription, timestamp), 5000);
      await notifyAdmin(
        profileData?.name || 'Unknown Patient',
        doctorName,
        notificationMessage,
        effectivePatientId,
        doctorId,
        effectiveUserId,
        await firebaseUser.getIdToken(true)
      );
    }
  };

  const normalizeLanguageCode = useCallback((code) => {
    switch (code?.toLowerCase()) {
      case 'kn':
      case 'kn-in':
        return 'kn-IN';
      case 'en':
      case 'en-us':
        return 'en-US';
      default:
        return 'en-US';
    }
  }, []);

  const retryUpload = async (audioBlob, language) => {
    if (!firebaseUser || !audioBlob || !language) {
      setError('Invalid retry data or user session. Please log in again.');
      navigate('/login');
      return;
    }

    setError('Retrying upload... (Attempts remaining: 3)');
    let attempts = 3;

    const attemptRetry = async () => {
      try {
        console.log('Retrying upload with:', { language, audioBlobSize: audioBlob.size });
        const idToken = await firebaseUser.getIdToken(true);
        if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
          throw new Error('Invalid idToken: Must be a non-empty string.');
        }
        const transcriptionResult = await transcribeAudio(audioBlob, language, effectiveUserId, idToken);
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

        const postUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
        console.log('Sending retry upload:', { url: postUrl, message });

        const saveResponse = await fetch(postUrl, {
          method: 'POST',
          headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
          body: formData,
          credentials: 'include',
        });

        if (!saveResponse.ok) {
          const errorData = await saveResponse.json();
          throw new Error(`Failed to save message: ${saveResponse.status} - ${errorData.message || 'Unknown error'}`);
        }
        const data = await saveResponse.json();
        setMessages((prev) => {
          const isDuplicate = prev.some(
            (msg) =>
              msg.timestamp === data.newMessage.timestamp &&
              msg.sender === data.newMessage.sender &&
              msg.text === data.newMessage.text &&
              msg.audioUrl === data.newMessage.audioUrl
          );
          if (isDuplicate) {
            console.log('PatientChat: Skipped duplicate retry message:', data.newMessage.timestamp, data.newMessage.text);
            return prev;
          }
          return [...prev, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        });
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
    if (!firebaseUser) {
      setError('User authentication failed. Please log in again.');
      navigate('/login');
      return;
    }

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

        const normalizedTranscriptionLanguage = normalizeLanguageCode(transcriptionLanguage);
        let text, translatedText = null;

        try {
          const idToken = await firebaseUser.getIdToken(true);
          if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
            throw new Error('Invalid idToken: Must be a non-empty string.');
          }
          const transcriptionResult = await transcribeAudio(audioBlob, normalizedTranscriptionLanguage, effectiveUserId, idToken);
          text = transcriptionResult.transcription || 'Transcription failed';

          if (normalizedTranscriptionLanguage === 'kn-IN') {
            translatedText = await translateText(text, 'kn-IN', 'en-US', effectiveUserId, idToken);
          } else if (normalizedTranscriptionLanguage === 'en-US' && languagePreference === 'kn') {
            translatedText = await translateText(text, 'en-US', 'kn-IN', effectiveUserId, idToken);
          }

          const message = {
            sender: 'patient',
            text,
            translatedText,
            timestamp: new Date().toISOString(),
            language: normalizedTranscriptionLanguage,
            recordingLanguage: normalizedTranscriptionLanguage,
            doctorId,
            userId: effectivePatientId,
            audioUrl: transcriptionResult.audioUrl,
          };

          const formData = new FormData();
          formData.append('audio', audioBlob, `audio_${new Date().toISOString()}.webm`);
          formData.append('message', JSON.stringify(message));
          formData.append('sender', 'patient');

          const postUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
          console.log('Sending audio message:', { url: postUrl, message, audioSize: audioBlob.size });

          const response = await fetch(postUrl, {
            method: 'POST',
            headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
            body: formData,
            credentials: 'include',
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to save message: ${response.status} - ${errorData.message || 'Unknown error'}`);
          }
          const data = await response.json();
          setMessages((prev) => {
            const isDuplicate = prev.some(
              (msg) =>
                msg.timestamp === data.newMessage.timestamp &&
                msg.sender === data.newMessage.sender &&
                msg.text === data.newMessage.text &&
                msg.audioUrl === data.newMessage.audioUrl
            );
            if (isDuplicate) {
              console.log('PatientChat: Skipped duplicate recording message:', data.newMessage.timestamp, data.newMessage.text);
              return prev;
            }
            return [...prev, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          });
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
    if (!firebaseUser) {
      setError('User authentication failed. Please log in again.');
      navigate('/login');
      return;
    }

    const file = e.target.files[0];
    if (!file) {
      setError('No file selected. Please choose an image.');
      return;
    }

    console.log('Selected file:', { name: file.name, type: file.type, size: file.size });

    const validTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      setError('Invalid file type. Please upload a JPEG, PNG, or GIF image.');
      setFailedUpload({ file, type: 'image' });
      return;
    }
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      setError('File too large. Maximum size is 5MB.');
      setFailedUpload({ file, type: 'image' });
      return;
    }

    const tempMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();

    const message = {
      sender: 'patient',
      timestamp,
      doctorId,
      userId: effectivePatientId,
      messageType: 'image',
      tempMessageId,
    };

    const formData = new FormData();
    formData.append('image', file);
    formData.append('message', JSON.stringify(message));
    formData.append('sender', 'patient');

    const postUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
    console.log('Uploading image:', { url: postUrl, message, file: { name: file.name, type: file.type, size: file.size } });

    try {
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: { 'x-user-uid': effectiveUserId, Authorization: `Bearer ${idToken}` },
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Image upload failed: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      const data = await response.json();
      if (!data.newMessage.imageUrl) {
        throw new Error('Image upload succeeded, but no image URL was returned.');
      }

      setMessages((prev) => {
        const filteredMessages = prev.filter((msg) => msg.tempMessageId !== tempMessageId);
        const isDuplicate = filteredMessages.some(
          (msg) =>
            msg.timestamp === data.newMessage.timestamp &&
            msg.imageUrl === data.newMessage.imageUrl &&
            msg.sender === data.newMessage.sender
        );
        if (isDuplicate) {
          console.log('PatientChat: Skipped duplicate image message:', data.newMessage.timestamp, data.newMessage.imageUrl);
          return filteredMessages;
        }
        return [...filteredMessages, data.newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      });
    } catch (err) {
      console.error('Image upload failed:', err);
      setError(err.message);
      setFailedUpload({ file, type: 'image' });
    }
  };

  const retryTextToSpeech = async (text, lang, attempts = 3) => {
    if (attempts <= 0) {
      throw new Error('Text-to-speech conversion failed after retries. Please try again later.');
    }

    if (!firebaseUser) {
      throw new Error('User authentication failed. Cannot perform text-to-speech conversion.');
    }

    try {
      const idToken = await firebaseUser.getIdToken(true);
      console.log('retryTextToSpeech: Fetched idToken:', idToken ? 'Valid token' : 'No token');

      if (!idToken || typeof idToken !== 'string' || idToken.trim() === '') {
        throw new Error('Invalid idToken: Must be a non-empty string.');
      }

      const normalizedLang = normalizeLanguageCode(lang);
      const audioUrl = await textToSpeechConvert(text.trim(), normalizedLang, effectiveUserId, idToken);
      const response = await fetch(audioUrl, { method: 'HEAD', mode: 'cors' });
      if (!response.ok) {
        throw new Error(`Audio URL inaccessible: ${audioUrl} (Status: ${response.status}) - ${response.statusText}`);
      }
      return audioUrl;
    } catch (err) {
      console.error(`Text-to-speech attempt ${4 - attempts} failed:`, err);
      if (err.message.includes('404')) {
        throw new Error('Text-to-speech service is unavailable (404). Please contact support.');
      } else if (err.message.includes('CORS')) {
        throw new Error('CORS policy blocked audio access. Please contact support to update server settings.');
      }
      setError(`Retrying text-to-speech... (Attempts remaining: ${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return retryTextToSpeech(text, lang, attempts - 1);
    }
  };

  const readAloud = async (text, lang, attempts = 3) => {
    if (attempts <= 0) {
      setError('Failed to read aloud after retries. Please try again later.');
      return;
    }

    if (!firebaseUser) {
      setError('User authentication failed. Cannot read aloud.');
      navigate('/login');
      return;
    }

    try {
      if (!text || typeof text !== 'string' || text.trim() === '') {
        setError('Cannot read aloud: No valid text provided.');
        return;
      }
      const audioUrl = await retryTextToSpeech(text, lang);
      await playAudio(audioUrl);
    } catch (err) {
      console.error('Error reading aloud:', err);
      if (attempts > 1 && err.message.includes('Failed to load audio')) {
        setError(`Retrying audio playback... (Attempts remaining: ${attempts - 1})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return readAloud(text, lang, attempts - 1);
      }
      let errorMessage = `Error reading aloud: ${err.message}`;
      if (err.message.includes('Failed to load audio')) {
        errorMessage = 'Error reading aloud: Audio file could not be loaded. It may be inaccessible or unsupported.';
      } else if (err.message.includes('CORS')) {
        errorMessage = 'Error reading aloud: CORS policy blocked access. Please contact support.';
      } else if (err.message.includes('Playback failed')) {
        errorMessage = 'Error reading aloud: Audio playback failed. Please check your browser or device audio settings.';
      } else if (err.message.includes('Invalid idToken')) {
        errorMessage = 'Error reading aloud: Authentication failed. Please log in again.';
        navigate('/login');
      }
      setError(errorMessage);
    }
  };

  const handleSendText = async () => {
    if (!firebaseUser) {
      setError('User authentication failed. Please log in again.');
      navigate('/login');
      return;
    }

    if (!textInput.trim()) return;

    const tempMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();

    const message = {
      sender: 'patient',
      text: textInput,
      translatedText: null,
      timestamp,
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
      tempMessageId,
    };

    setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
    setTextInput('');

    try {
      const postUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
      console.log('Sending text message:', { url: postUrl, message });
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(postUrl, {
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
        throw new Error(`Failed to save text message: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }
      const data = await response.json();
      const newMessage = data.newMessage;

      setMessages((prev) => {
        const filteredMessages = prev.filter((msg) => msg.tempMessageId !== tempMessageId);
        const isDuplicate = filteredMessages.some(
          (msg) =>
            msg.sender === newMessage.sender &&
            msg.text === newMessage.text &&
            Math.abs(new Date(msg.timestamp) - new Date(newMessage.timestamp)) < 1000
        );
        if (isDuplicate) {
          console.log('PatientChat: Skipped duplicate text message from server:', newMessage.timestamp, newMessage.text);
          return filteredMessages;
        }
        return [...filteredMessages, newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      });
    } catch (err) {
      console.error('Failed to save text message:', err);
      setError(`Failed to save text message: ${err.message}`);
      setMessages((prev) => prev.filter((msg) => msg.tempMessageId !== tempMessageId));
      if (err.message.includes('404')) {
        setTimeout(() => handleSendText(), 2000);
      }
    }
  };

  const handleQuickReply = async (replyText) => {
    if (!firebaseUser) {
      setError('User authentication failed. Please log in again.');
      navigate('/login');
      return;
    }

    const tempMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();

    const message = {
      sender: 'patient',
      text: replyText,
      translatedText: null,
      timestamp,
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
      tempMessageId,
    };

    setMessages((prev) => [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

    try {
      const postUrl = `${apiBaseUrl}/chats/${effectivePatientId}/${doctorId}`;
      console.log('Sending quick reply:', { url: postUrl, message });
      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(postUrl, {
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
        throw new Error(`Failed to save quick reply message: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }
      const data = await response.json();
      const newMessage = data.newMessage;

      setMessages((prev) => {
        const filteredMessages = prev.filter((msg) => msg.tempMessageId !== tempMessageId);
        const isDuplicate = filteredMessages.some(
          (msg) =>
            msg.sender === newMessage.sender &&
            msg.text === newMessage.text &&
            Math.abs(new Date(msg.timestamp) - new Date(newMessage.timestamp)) < 1000
        );
        if (isDuplicate) {
          console.log('PatientChat: Skipped duplicate quick reply:', newMessage.timestamp, newMessage.text);
          return filteredMessages;
        }
        return [...filteredMessages, newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      });
    } catch (err) {
      console.error('Failed to save quick reply:', err);
      setError(`Failed to save quick reply message: ${err.message}`);
      setMessages((prev) => prev.filter((msg) => msg.tempMessageId !== tempMessageId));
    }
  };

  const handleDoctorResponse = (response) => {
    if (response === 'yes') {
      setDoctorPrompt(false);
      localStorage.setItem(`lastContact_${effectivePatientId}_${doctorId}`, new Date().toISOString());
    } else {
      setDoctorPrompt(false);
      navigate('/login');
    }
  };

  const handleLogoutClick = async () => {
    try {
      await signOut(auth);
      await fetch(`${apiBaseUrl}/misc/logout`, {
        method: 'POST',
        headers: {
          'x-user-uid': effectiveUserId,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      if (handleLogout) handleLogout();
      console.log('PatientChat: Logged out successfully, redirecting to /login');
      navigate('/login');
    } catch (err) {
      console.error('PatientChat: Logout error:', err.message);
      setError('Failed to log out. Please try again.');
    }
  };

  // Translate doctor's messages (diagnosis and prescription) to patient's preferred language
  const translateDoctorMessages = async () => {
    if (!firebaseUser || !languagePreference || languagePreference !== 'kn') return;

    const doctorMessages = messages.filter((msg) => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription));
    if (doctorMessages.length === 0) return;

    const updatedMessages = [...messages];
    let hasChanges = false;

    try {
      const idToken = await firebaseUser.getIdToken(true);
      for (let i = 0; i < updatedMessages.length; i++) {
        const msg = updatedMessages[i];
        if (msg.sender === 'doctor' && (msg.diagnosis || msg.prescription)) {
          if (msg.diagnosis && !msg.translatedDiagnosis) {
            const translatedDiagnosis = await translateText(msg.diagnosis, 'en-US', 'kn-IN', effectiveUserId, idToken);
            updatedMessages[i] = { ...msg, translatedDiagnosis };
            hasChanges = true;
          }
          if (msg.prescription && !msg.translatedPrescription) {
            const prescriptionText = typeof msg.prescription === 'object'
              ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
              : msg.prescription;
            const translatedPrescription = await translateText(prescriptionText, 'en-US', 'kn-IN', effectiveUserId, idToken);
            updatedMessages[i] = { ...updatedMessages[i], translatedPrescription };
            hasChanges = true;
          }
        }
      }

      if (hasChanges) {
        setMessages(updatedMessages);
      }
    } catch (err) {
      console.error('Failed to translate doctor messages:', err.message);
      setError(`Failed to translate doctor's messages: ${err.message}`);
    }
  };

  useEffect(() => {
    translateDoctorMessages();
  }, [messages, languagePreference, firebaseUser]);

  if (languagePreference === null || transcriptionLanguage === null) {
    return (
      <div className="loading-container">
        <p>Loading language preference...</p>
      </div>
    );
  }

  return (
    <div className="patient-chat-container">
      <div className="chat-header">
        <button className="hamburger-button" onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <h2>Patient Chat with {doctorName}</h2>
        <div className="header-actions">
          <button onClick={handleLogoutClick} className="logout-button">
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
              {isEditingProfile ? (
                <>
                  <div className="profile-field">
                    <strong>Name:</strong>
                    <input
                      type="text"
                      value={editProfileData.name}
                      onChange={(e) => setEditProfileData({ ...editProfileData, name: e.target.value })}
                    />
                  </div>
                  <div className="profile-field">
                    <strong>Password:</strong>
                    <input
                      type="password"
                      value={editProfileData.password}
                      onChange={(e) => setEditProfileData({ ...editProfileData, password: e.target.value })}
                      placeholder="Leave blank to keep unchanged"
                    />
                  </div>
                  <div className="profile-field">
                    <strong>Age:</strong>
                    <input
                      type="number"
                      value={editProfileData.age}
                      onChange={(e) => setEditProfileData({ ...editProfileData, age: e.target.value })}
                    />
                  </div>
                  <div className="profile-field">
                    <strong>Sex:</strong>
                    <select
                      value={editProfileData.sex}
                      onChange={(e) => setEditProfileData({ ...editProfileData, sex: e.target.value })}
                    >
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div className="profile-field">
                    <strong>Address:</strong>
                    <input
                      type="text"
                      value={editProfileData.address}
                      onChange={(e) => setEditProfileData({ ...editProfileData, address: e.target.value })}
                    />
                  </div>
                  <div className="profile-field">
                    <strong>Phone Number:</strong>
                    <input
                      type="text"
                      value={editProfileData.phoneNumber}
                      onChange={(e) => setEditProfileData({ ...editProfileData, phoneNumber: e.target.value })}
                    />
                  </div>
                  <p><strong>Patient ID:</strong> {profileData.patientId}</p>
                  <p><strong>Email:</strong> {profileData.email}</p>
                  <p><strong>Language Preference:</strong> {profileData.languagePreference === 'kn' ? 'Kannada' : 'English'}</p>
                  <p><strong>Aadhaar Number:</strong> {profileData.aadhaarNumber}</p>
                  <div className="profile-actions">
                    <button onClick={handleProfileUpdate} className="save-button">
                      Save Changes
                    </button>
                    <button onClick={() => setIsEditingProfile(false)} className="cancel-button">
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p><strong>Name:</strong> {profileData.name}</p>
                  <p><strong>Patient ID:</strong> {profileData.patientId}</p>
                  <p><strong>Email:</strong> {profileData.email}</p>
                  <p><strong>Language Preference:</strong> {profileData.languagePreference === 'kn' ? 'Kannada' : 'English'}</p>
                  <p><strong>Sex:</strong> {profileData.sex}</p>
                  <p><strong>Age:</strong> {profileData.age}</p>
                  <p><strong>Address:</strong> {profileData.address}</p>
                  <p><strong>Phone Number:</strong> {profileData.phoneNumber}</p>
                  <p><strong>Aadhaar Number:</strong> {profileData.aadhaarNumber}</p>
                  <div className="profile-actions">
                    <button onClick={() => setIsEditingProfile(true)} className="update-button">
                      Update Profile
                    </button>
                    <button onClick={() => setActiveMenuOption(null)} className="close-section-button">
                      Close
                    </button>
                  </div>
                </>
              )}
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
                    <span>Diagnosis</span>
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
                        <span>{reminder.diagnosis}</span>
                        <span>{new Date(reminder.scheduledTime).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + ' ' + new Date(reminder.scheduledTime).toLocaleTimeString('en-US', { hour12: true })}</span>
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
                (() => {
                  const doctorMessages = messages
                    .filter((msg) => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription))
                    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

                  let lastDiagnosis = '';
                  const combinedMessages = [];

                  for (let i = 0; i < doctorMessages.length; i++) {
                    const msg = doctorMessages[i];
                    if (msg.diagnosis) {
                      lastDiagnosis = msg.diagnosis;
                    }
                    if (msg.prescription) {
                      const prescriptionText = typeof msg.prescription === 'object'
                        ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                        : msg.prescription;

                      const diagnosisToUse = lastDiagnosis || 'Not specified';

                      const note = msg.diagnosis ? '' : lastDiagnosis ? '(Note: Only prescription was given, using last diagnosis)' : '(Note: No prior diagnosis available)';

                      combinedMessages.push({
                        timestamp: msg.timestamp,
                        diagnosis: diagnosisToUse,
                        prescription: prescriptionText,
                        note,
                        translatedDiagnosis: msg.translatedDiagnosis,
                        translatedPrescription: msg.translatedPrescription,
                      });
                    }
                  }

                  return combinedMessages.map((entry, index) => (
                    <div key={`${entry.timestamp}-${index}`} className="recommendation-item">
                      <div className="recommendation-content">
                        {languagePreference === 'kn' && entry.translatedDiagnosis ? (
                          <p><strong>Diagnosis:</strong> {entry.translatedDiagnosis}</p>
                        ) : (
                          <p><strong>Diagnosis:</strong> {entry.diagnosis}</p>
                        )}
                        {languagePreference === 'kn' && entry.translatedPrescription ? (
                          <p><strong>Prescription:</strong> {entry.translatedPrescription}</p>
                        ) : (
                          <p><strong>Prescription:</strong> {entry.prescription}</p>
                        )}
                        {entry.note && <p className="recommendation-note">{entry.note}</p>}
                      </div>
                      <div className="recommendation-actions">
                        <button
                          onClick={() => validatePrescription(entry.diagnosis, entry.prescription, entry.timestamp)}
                          className="validate-button"
                        >
                          ✅ Validate
                        </button>
                        {validationResult[entry.timestamp] && (
                          <span
                            className={
                              validationResult[entry.timestamp].includes('valid')
                                ? 'validation-success'
                                : 'validation-error'
                            }
                          >
                            {validationResult[entry.timestamp]}
                          </span>
                        )}
                      </div>
                    </div>
                  ));
                })()
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
                    {msg.sender === 'patient' && msg.audioUrl && (
                      <>
                        {msg.recordingLanguage === 'en-US' ? (
                          <div className="message-block">
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            <div className="audio-container">
                              <audio controls src={msg.audioUrl} onError={() => setError('Failed to load audio. It may be inaccessible or unsupported.')} />
                              <div className="read-aloud-container">
                                <button
                                  onClick={() => readAloud(msg.text, 'en')}
                                  className="read-aloud-button"
                                >
                                  🔊 English
                                </button>
                              </div>
                              <a href={msg.audioUrl} download className="download-link">
                                Download Audio
                              </a>
                            </div>
                          </div>
                        ) : (
                          <div className="message-block">
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            {msg.translatedText && <p className="translated-text">English: {msg.translatedText}</p>}
                            <div className="audio-container">
                              <audio controls src={msg.audioUrl} onError={() => setError('Failed to load audio. It may be inaccessible or unsupported.')} />
                              <div className="read-aloud-container">
                                <button
                                  onClick={() => readAloud(msg.text, 'kn')}
                                  className="read-aloud-button"
                                >
                                  🔊 Kannada
                                </button>
                                <button
                                  onClick={() => readAloud(msg.translatedText || msg.text, 'en')}
                                  className="read-aloud-button"
                                >
                                  🔊 English
                                </button>
                              </div>
                              <a href={msg.audioUrl} download className="download-link">
                                Download Audio
                              </a>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {msg.sender === 'patient' && !msg.audioUrl && (
                      <div className="message-block">
                        <p className="primary-text">{msg.text || 'No transcription'}</p>
                      </div>
                    )}
                    {msg.sender === 'doctor' && (
                      <div className="message-block">
                        {msg.diagnosis || msg.prescription ? (
                          <>
                            {languagePreference === 'kn' ? (
                              <>
                                <p className="primary-text">Doctor has provided a recommendation</p>
                                {msg.diagnosis && (
                                  <p className="primary-text">
                                    <strong>Diagnosis:</strong> {msg.translatedDiagnosis || msg.diagnosis}
                                    <button
                                      onClick={() => readAloud(msg.translatedDiagnosis || msg.diagnosis, 'kn')}
                                      className="read-aloud-button"
                                    >
                                      🔊 Kannada
                                    </button>
                                  </p>
                                )}
                                {msg.prescription && (
                                  <p className="primary-text">
                                    <strong>Prescription:</strong>{' '}
                                    {msg.translatedPrescription || (typeof msg.prescription === 'object'
                                      ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                                      : msg.prescription)}
                                    <button
                                      onClick={() => readAloud(msg.translatedPrescription || (typeof msg.prescription === 'object'
                                        ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                                        : msg.prescription), 'kn')}
                                      className="read-aloud-button"
                                    >
                                      🔊 Kannada
                                    </button>
                                  </p>
                                )}
                              </>
                            ) : (
                              <>
                                {msg.diagnosis && (
                                  <p className="primary-text">
                                    <strong>Diagnosis:</strong> {msg.diagnosis}
                                    {languagePreference === 'en' && (
                                      <button
                                        onClick={() => readAloud(msg.diagnosis, 'en')}
                                        className="read-aloud-button"
                                      >
                                        🔊 English
                                      </button>
                                    )}
                                  </p>
                                )}
                                {msg.prescription && (
                                  <p className="primary-text">
                                    <strong>Prescription:</strong>{' '}
                                    {typeof msg.prescription === 'object'
                                      ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                                      : msg.prescription}
                                    {languagePreference === 'en' && (
                                      <button
                                        onClick={() => readAloud(typeof msg.prescription === 'object'
                                          ? `${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`
                                          : msg.prescription, 'en')}
                                        className="read-aloud-button"
                                      >
                                        🔊 English
                                      </button>
                                    )}
                                  </p>
                                )}
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            {languagePreference === 'en' ? (
                              <div className="message-block">
                                <p className="primary-text">{msg.text || 'No message content'}</p>
                                {msg.audioUrl && (
                                  <div className="audio-container">
                                    <audio controls src={msg.audioUrl} onError={() => setError('Failed to load audio. It may be inaccessible or unsupported.')} />
                                    <div className="read-aloud-container">
                                      <button
                                        onClick={() => readAloud(msg.text, 'en')}
                                        className="read-aloud-button"
                                      >
                                        🔊 English
                                      </button>
                                    </div>
                                    <a href={msg.audioUrl} download className="download-link">
                                      Download Audio
                                    </a>
                                  </div>
                                )}
                              </div>
                            ) : (

                              <div className="message-block">
                                <p className="primary-text">{msg.text || 'No message content'}</p>
                                {msg.translatedText && <p className="translated-text">English: {msg.translatedText}</p>}
                                {msg.audioUrl && (
                                  <div className="audio-container">
                                    <audio controls src={msg.audioUrl} onError={() => setError('Failed to load audio. It may be inaccessible or unsupported.')} />
                                    <div className="read-aloud-container">
                                      <button
                                        onClick={() => readAloud(msg.text, 'kn')}
                                        className="read-aloud-button"
                                      >
                                        🔊 Kannada
                                      </button>
                                      <button
                                        onClick={() => readAloud(msg.translatedText || msg.text, 'en')}
                                        className="read-aloud-button"
                                      >
                                        🔊 English
                                      </button>
                                    </div>
                                    <a href={msg.audioUrl} download className="download-link">
                                      Download Audio
                                    </a>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {msg.imageUrl && <img src={msg.imageUrl} alt="Patient upload" className="chat-image" />}
                    {msg.audioError && <p className="audio-error">{msg.audioError}</p>}
                    <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString('en-US', { hour12: true })}</span>
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
              <div className="controls-row">
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default PatientChat