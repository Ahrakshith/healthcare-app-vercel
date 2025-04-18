// src/components/PatientChat.js
import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import { transcribeAudio, translateText, textToSpeechConvert, detectLanguage } from '../services/speech.js';
import { verifyMedicine, notifyAdmin } from '../services/medicineVerify.js';
import { doc, getDoc, collection, addDoc, getDocs, updateDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';

function PatientChat({ user, role, patientId, handleLogout }) {
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
  const audioChunksRef = useRef([]);
  const audioRef = useRef(new Audio());
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const reminderTimeoutsRef = useRef(new Map());
  const navigate = useNavigate();

  const effectiveUserId = user?.uid;
  const effectivePatientId = urlPatientId || patientId;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

    fetchPatientData();
    fetchReminders();

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      reminderTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
      reminderTimeoutsRef.current.clear();
    };
  }, [effectiveUserId, effectivePatientId, doctorId, role, navigate]);

  useEffect(() => {
    if (messages.some(msg => msg.sender === 'doctor' && msg.prescription)) {
      const latestPrescription = messages
        .filter(msg => msg.sender === 'doctor' && msg.prescription)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.prescription;
      if (latestPrescription) {
        setupMedicationSchedule(latestPrescription);
      }
    }
  }, [messages]);

  useEffect(() => {
    if (languagePreference === null) return;

    socketRef.current = io('http://localhost:5005', {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current.on('connect', () => {
      const room = `${effectivePatientId}-${doctorId}`;
      socketRef.current.emit('joinRoom', room);
    });

    socketRef.current.on('newMessage', (message) => {
      setMessages((prev) => {
        if (!prev.some((msg) => msg.timestamp === message.timestamp)) {
          return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }
        return prev;
      });

      if (message.sender === 'doctor' && (message.diagnosis || message.prescription)) {
        validatePrescription(message.diagnosis, message.prescription, message.timestamp);
      }
    });

    const fetchMessages = async () => {
      try {
        const response = await fetch(`http://localhost:5005/chats/${effectivePatientId}/${doctorId}`, {
          headers: { 'x-user-uid': effectiveUserId },
          credentials: 'include',
        });
        if (!response.ok && response.status !== 404) throw new Error(`Failed to fetch messages: ${response.statusText}`);
        const data = await response.json();
        const fetchedMessages = data.messages || [];

        const validatedMessages = await Promise.all(
          fetchedMessages.map(async (msg) => {
            const updatedMsg = { ...msg };
            if (msg.audioUrl) {
              const response = await fetch(msg.audioUrl, { method: 'HEAD' });
              if (!response.ok) updatedMsg.audioUrl = null;
            }
            if (msg.audioUrlEn) {
              const response = await fetch(msg.audioUrlEn, { method: 'HEAD' });
              if (!response.ok) updatedMsg.audioUrlEn = null;
            }
            if (msg.audioUrlKn) {
              const response = await fetch(msg.audioUrlKn, { method: 'HEAD' });
              if (!response.ok) updatedMsg.audioUrlKn = null;
            }
            return updatedMsg;
          })
        );

        setMessages(validatedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

        const doctorMessages = validatedMessages.filter((msg) => msg.sender === 'doctor');
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
        setError('Error fetching messages: ' + err.message);
      }
    };

    fetchMessages();

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [effectiveUserId, effectivePatientId, doctorId, languagePreference]);

  const normalizeLanguageCode = (code) => {
    switch (code?.toLowerCase()) {
      case 'kn':
        return 'kn-IN';
      case 'en':
        return 'en-US';
      default:
        return code || 'en-US';
    }
  };

  const setupMedicationSchedule = async (prescription) => {
    const regex = /(.+?),\s*(\d+mg),\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM))\s*and\s*(\d{1,2}[:.]\d{2}\s*(?:AM|PM)),\s*(\d+)\s*days?/i;
    const match = prescription.match(regex);

    if (!match) {
      setError('Invalid prescription format. Expected: "Medicine, dosage, time1 and time2, duration days"');
      return;
    }

    const [, medicine, dosage, time1Str, time2Str, durationDays] = match;
    const days = parseInt(durationDays, 10);

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
        };
        const remindersRef = collection(db, `patients/${effectivePatientId}/reminders`);
        const docRef = await addDoc(remindersRef, reminder1);
        newReminders.push({ id: docRef.id, ...reminder1 });
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
        };
        const remindersRef = collection(db, `patients/${effectivePatientId}/reminders`);
        const docRef = await addDoc(remindersRef, reminder2);
        newReminders.push({ id: docRef.id, ...reminder2 });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    setReminders((prev) => [...prev, ...newReminders]);
    scheduleReminders(newReminders);
  };

  const scheduleReminders = (remindersToSchedule) => {
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
  };

  const calculateAdherenceRate = (remindersList) => {
    if (remindersList.length === 0) {
      setAdherenceRate(0);
      return;
    }
    const completed = remindersList.filter((r) => r.status === 'taken').length;
    const total = remindersList.length;
    const rate = (completed / total) * 100;
    setAdherenceRate(rate.toFixed(2));
  };

  const checkMissedDoses = (remindersList) => {
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
  };

  const sendMissedDoseAlert = async () => {
    try {
      await notifyAdmin(
        `Patient_${effectivePatientId}`,
        'Doctor',
        'Missed Doses Alert',
        `Patient has missed 3 consecutive doses.`
      );
      setError('Alert: You have missed 3 consecutive doses. Notified your doctor.');
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
    try {
      setError('');
      setFailedUpload(null);
      const transcriptionResult = await transcribeAudio(audioBlob, language, effectiveUserId);
      if (!transcriptionResult.audioUrl) {
        setError('Transcription succeeded, but no audio URL was returned.');
        return null;
      }
      const response = await fetch(transcriptionResult.audioUrl, { method: 'HEAD' });
      if (!response.ok) {
        setError(`Audio URL inaccessible: ${transcriptionResult.audioUrl} (Status: ${response.status})`);
        return null;
      }
      return transcriptionResult;
    } catch (err) {
      setError(`Failed to transcribe audio on retry: ${err.message}`);
      setFailedUpload({ audioBlob, language });
      return null;
    }
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
        let transcriptionResult;
        let audioUrl;
        let audioUrlEn;
        let audioUrlKn = null;
        let text;
        let translatedText = null;
        let recordingLanguage = transcriptionLanguage;

        try {
          transcriptionResult = await transcribeAudio(audioBlob, normalizedTranscriptionLanguage, effectiveUserId);
          audioUrl = transcriptionResult.audioUrl;
          if (!audioUrl) {
            setError('Transcription succeeded, but no audio URL was returned.');
            return;
          }
          const response = await fetch(audioUrl, { method: 'HEAD' });
          if (!response.ok) {
            setError(`Audio URL inaccessible: ${audioUrl} (Status: ${response.status})`);
            return;
          }

          if (languagePreference === 'en' && transcriptionLanguage === 'en') {
            text = transcriptionResult.transcription || 'Transcription failed';
            translatedText = null;
            audioUrlEn = await textToSpeechConvert(text, 'en-US');
            recordingLanguage = 'en';
          } else if (languagePreference === 'en' && transcriptionLanguage === 'kn') {
            text = transcriptionResult.transcription || 'Transcription failed';
            translatedText = await translateText(text, 'kn', 'en');
            audioUrlEn = await textToSpeechConvert(translatedText, 'en-US');
            audioUrlKn = await textToSpeechConvert(text, 'kn-IN');
            recordingLanguage = 'kn';
          } else if (languagePreference === 'kn' && transcriptionLanguage === 'kn') {
            text = transcriptionResult.transcription || 'Transcription failed';
            translatedText = await translateText(text, 'kn', 'en');
            audioUrlEn = await textToSpeechConvert(translatedText, 'en-US');
            audioUrlKn = await textToSpeechConvert(text, 'kn-IN');
            recordingLanguage = 'kn';
          } else if (languagePreference === 'kn' && transcriptionLanguage === 'en') {
            text = transcriptionResult.transcription || 'Transcription failed';
            translatedText = null;
            audioUrlEn = await textToSpeechConvert(text, 'en-US');
            recordingLanguage = 'en';
          }
        } catch (err) {
          setError(`Failed to process audio: ${err.message}`);
          setFailedUpload({ audioBlob, language: normalizedTranscriptionLanguage });
          return;
        }

        const newMessage = {
          sender: 'patient',
          text,
          translatedText,
          timestamp: new Date().toISOString(),
          language: transcriptionLanguage,
          recordingLanguage,
          audioUrl,
          audioUrlEn,
          audioUrlKn,
          doctorId,
          userId: effectivePatientId,
        };

        setMessages((prev) => [...prev, newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

        try {
          const response = await fetch(`http://localhost:5005/chats/${effectivePatientId}/${doctorId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-uid': effectiveUserId,
            },
            body: JSON.stringify(newMessage),
            credentials: 'include',
          });
          if (!response.ok) throw new Error(`Failed to save message: ${response.statusText}`);
          socketRef.current.emit('newMessage', newMessage);
          if (languagePreference === 'kn') {
            setTranscriptionLanguage('kn');
          }
        } catch (err) {
          setError(`Failed to save message: ${err.message}`);
        }
      };

      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Error starting recording: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('uid', effectiveUserId);

    try {
      const response = await fetch(`http://localhost:5005/uploadImage/${effectivePatientId}`, {
        method: 'POST',
        body: formData,
        headers: {
          'x-user-uid': effectiveUserId,
        },
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 503) {
          setError('Image upload to cloud failed. Saved locally on server. Please try again later.');
          return;
        }
        throw new Error('Failed to upload image');
      }

      const { imageUrl } = await response.json();
      const imageMessage = {
        sender: 'patient',
        imageUrl,
        timestamp: new Date().toISOString(),
        doctorId,
        userId: effectivePatientId,
      };

      setMessages((prev) => [...prev, imageMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

      await fetch(`http://localhost:5005/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': effectiveUserId,
        },
        body: JSON.stringify(imageMessage),
        credentials: 'include',
      });
      socketRef.current.emit('newMessage', imageMessage);
    } catch (err) {
      setError(`Error uploading image: ${err.message}`);
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
      audioRef.current.play();
    } catch (err) {
      setError(`Error reading aloud: ${err.message}`);
    }
  };

  const handleSendText = async () => {
    if (!textInput.trim()) return;

    const newMessage = {
      sender: 'patient',
      text: textInput,
      translatedText: null,
      timestamp: new Date().toISOString(),
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
    };

    setMessages((prev) => [...prev, newMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
    setTextInput('');

    try {
      const response = await fetch(`http://localhost:5005/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': effectiveUserId,
        },
        body: JSON.stringify(newMessage),
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Failed to save text message: ${response.statusText}`);
      socketRef.current.emit('newMessage', newMessage);
    } catch (err) {
      setError(`Failed to save text message: ${err.message}`);
    }
  };

  const handleQuickReply = async (replyText) => {
    const quickMessage = {
      sender: 'patient',
      text: replyText,
      translatedText: null,
      timestamp: new Date().toISOString(),
      language: 'en',
      recordingLanguage: 'en',
      doctorId,
      userId: effectivePatientId,
    };

    setMessages((prev) => [...prev, quickMessage].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

    try {
      const response = await fetch(`http://localhost:5005/chats/${effectivePatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': effectiveUserId,
        },
        body: JSON.stringify(quickMessage),
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Failed to save quick reply message: ${response.statusText}`);
      socketRef.current.emit('newMessage', quickMessage);
    } catch (err) {
      setError(`Failed to save quick reply message: ${err.message}`);
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
              {messages.filter(msg => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription)).length > 0 ? (
                messages
                  .filter(msg => msg.sender === 'doctor' && (msg.diagnosis || msg.prescription))
                  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                  .map((msg, index) => (
                    <div key={index}>
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
              {messages.length === 0 && <p className="no-messages">No messages yet.</p>}
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`message ${msg.sender === 'patient' ? 'patient-message' : 'doctor-message'}`}
                >
                  <div className="message-content">
                    {msg.sender === 'patient' && (
                      <>
                        {(msg.recordingLanguage || msg.language) === 'en' ? (
                          <div className="message-block">
                            <p className="primary-text">{msg.text || 'No transcription'}</p>
                            {msg.audioUrl && (
                              <div className="audio-container">
                                <audio controls>
                                  <source src={msg.audioUrl} type="audio/webm" />
                                  Your browser does not support the audio element.
                                </audio>
                                <a href={msg.audioUrl} download className="download-link">
                                  Download Audio
                                </a>
                              </div>
                            )}
                            {msg.audioUrlEn && (
                              <div className="read-aloud-buttons">
                                <button
                                  onClick={() => readAloud(msg.audioUrlEn, 'en', msg.text)}
                                  className="read-aloud-button"
                                >
                                  🔊 (English)
                                </button>
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
                                <audio controls>
                                  <source src={msg.audioUrl} type="audio/webm" />
                                  Your browser does not support the audio element.
                                </audio>
                                <a href={msg.audioUrl} download className="download-link">
                                  Download Audio
                                </a>
                              </div>
                            )}
                            {(msg.audioUrlKn || msg.audioUrlEn) && (
                              <div className="read-aloud-buttons">
                                {msg.audioUrlKn && (
                                  <button
                                    onClick={() => readAloud(msg.audioUrlKn, 'kn', msg.text)}
                                    className="read-aloud-button"
                                  >
                                    🔊 (Kannada)
                                  </button>
                                )}
                                {msg.audioUrlEn && (
                                  <button
                                    onClick={() => readAloud(msg.audioUrlEn, 'en', msg.translatedText || msg.text)}
                                    className="read-aloud-button"
                                  >
                                    🔊 (English)
                                  </button>
                                )}
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
                          <p className="primary-text">{msg.translatedText || msg.text || 'No transcription'}</p>
                        )}
                        {msg.audioUrl && (
                          <div className="audio-container">
                            <audio controls>
                              <source src={msg.audioUrl} type="audio/webm" />
                              Your browser does not support the audio element.
                            </audio>
                            <a href={msg.audioUrl} download className="download-link">
                              Download Audio
                            </a>
                          </div>
                        )}
                        {(msg.audioUrlKn || msg.audioUrlEn) && (
                          <div className="read-aloud-buttons">
                            {msg.audioUrlKn && (
                              <button
                                onClick={() => readAloud(msg.audioUrlKn, 'kn', msg.translatedText || msg.text)}
                                className="read-aloud-button"
                              >
                                🔊 (Kannada)
                              </button>
                            )}
                            {msg.audioUrlEn && (
                              <button
                                onClick={() => readAloud(msg.audioUrlEn, 'en', msg.text)}
                                className="read-aloud-button"
                              >
                                🔊 (English)
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {msg.imageUrl && <img src={msg.imageUrl} alt="Patient upload" className="chat-image" />}
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
              {failedUpload && (
                <button
                  onClick={() => retryUpload(failedUpload.audioBlob, failedUpload.language)}
                  className="retry-button"
                >
                  Retry Upload
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
                    accept="image/*"
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
          0%,
          100% {
            transform: translateX(0);
          }
          10%,
          30%,
          50%,
          70%,
          90% {
            transform: translateX(-5px);
          }
          20%,
          40%,
          60%,
          80% {
            transform: translateX(5px);
          }
        }
      `}</style>
    </div>
  );
}

export default PatientChat;