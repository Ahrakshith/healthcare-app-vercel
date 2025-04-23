import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, onSnapshot, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';
import io from 'socket.io-client';
import { transcribeAudio, translateText, textToSpeechConvert } from '../services/speech.js';

function DoctorChat({ user, role, handleLogout }) {
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [selectedPatientName, setSelectedPatientName] = useState('');
  const [patients, setPatients] = useState([]);
  const [messages, setMessages] = useState([]);
  const [missedDoseAlerts, setMissedDoseAlerts] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [prescription, setPrescription] = useState({
    medicine: '',
    dosage: '',
    frequency: '',
    duration: '',
  });
  const [error, setError] = useState('');
  const [failedUpload, setFailedUpload] = useState(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [diagnosisPrompt, setDiagnosisPrompt] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [languagePreference, setLanguagePreference] = useState('en');
  const [menuOpen, setMenuOpen] = useState(false);
  const [doctorProfile, setDoctorProfile] = useState(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState('');
  const [patientMessageTimestamps, setPatientMessageTimestamps] = useState({}); // New state to track message timestamps
  const audioRef = useRef(new Audio());
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const navigate = useNavigate();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Fetch Doctor ID and Profile
  useEffect(() => {
    if (role !== 'doctor' || !user?.uid) {
      setError('Please log in as a doctor.');
      navigate('/login');
      return;
    }

    const fetchDoctorId = async () => {
      try {
        const q = query(collection(db, 'doctors'), where('uid', '==', user.uid));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
          setError('Doctor profile not found.');
          setLoadingPatients(false);
          return;
        }
        const doctorDoc = querySnapshot.docs[0];
        const doctorData = doctorDoc.data();
        setDoctorId(doctorData.doctorId);
        setDoctorProfile({
          name: doctorData.name || 'N/A',
          doctorId: doctorData.doctorId || 'N/A',
          email: doctorData.email || 'N/A',
        });
      } catch (err) {
        setError(`Failed to fetch doctor profile: ${err.message}`);
        setLoadingPatients(false);
      }
    };

    fetchDoctorId();
  }, [role, user?.uid, navigate]);

  // Fetch Assigned Patients
  useEffect(() => {
    if (!doctorId) return;

    setLoadingPatients(true);
    const q = query(collection(db, 'doctor_assignments'), where('doctorId', '==', doctorId));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const assignedPatients = snapshot.docs.map((doc) => ({
          patientId: doc.data().patientId,
          doctorId: doc.data().doctorId,
          timestamp: doc.data().timestamp,
          patientName: doc.data().patientName || `Patient ${doc.data().patientId}`,
          age: doc.data().age || 'N/A',
          sex: doc.data().sex || 'N/A',
        }));
        setPatients(assignedPatients);
        setLoadingPatients(false);
        if (!selectedPatientId && assignedPatients.length > 0) {
          setSelectedPatientId(assignedPatients[0].patientId);
          setSelectedPatientName(assignedPatients[0].patientName);
        }
      },
      (err) => {
        setError(`Failed to fetch patients: ${err.message}`);
        setLoadingPatients(false);
      }
    );

    return () => unsubscribe();
  }, [doctorId]);

  // WebSocket and Data Fetching
  useEffect(() => {
    if (!selectedPatientId || !user?.uid || !doctorId) return;

    socketRef.current = io(process.env.REACT_APP_WEBSOCKET_URL || 'http://localhost:5005', {
      auth: { uid: user.uid },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      withCredentials: true, // Ensure cookies are sent in incognito
    });

    socketRef.current.on('connect', () => {
      console.log('DoctorChat.js: WebSocket connected, socket ID:', socketRef.current.id);
      socketRef.current.emit('joinRoom', { patientId: selectedPatientId, doctorId });
      console.log(`DoctorChat.js: Emitted joinRoom for patientId=${selectedPatientId}, doctorId=${doctorId}`);
    });

    socketRef.current.on('connect_error', (error) => {
      console.error('DoctorChat.js: WebSocket connection error:', error.message);
      setError(`WebSocket connection failed: ${error.message}`);
    });

    socketRef.current.on('error', (error) => {
      console.error('DoctorChat.js: WebSocket error:', error.message, error.receivedData || '');
      setError(`WebSocket error: ${error.message}`);
    });

    socketRef.current.on('newMessage', (message) => {
      console.log('DoctorChat.js: Received new message:', { ...message, audioUrl: message.audioUrl ? '[Audio URL]' : null });
      setMessages((prev) => {
        // Enhanced deduplication: Check timestamp and text
        if (!prev.some((msg) => msg.timestamp === message.timestamp && msg.text === message.text)) {
          const updatedMessages = [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          // Update patient message timestamps if the message is from the patient
          if (message.sender === 'patient') {
            setPatientMessageTimestamps((prevTimestamps) => ({
              ...prevTimestamps,
              [message.patientId]: {
                firstMessageTime: prevTimestamps[message.patientId]?.firstMessageTime || message.timestamp,
                lastMessageTime: message.timestamp,
              },
            }));
          }
          return updatedMessages;
        }
        console.log('DoctorChat.js: Skipped duplicate message:', message.timestamp, message.text);
        return prev;
      });
    });

    socketRef.current.on('missedDoseAlert', (alert) => {
      if (alert.patientId === selectedPatientId) {
        setMissedDoseAlerts((prev) => [...prev, { ...alert, id: Date.now().toString() }]);
      }
    });

    const fetchMessages = async () => {
      setLoadingMessages(true);
      try {
        const response = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
          headers: { 'x-user-uid': user.uid },
          credentials: 'include',
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Failed to fetch messages: ${response.statusText}`);
        }
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

        const sortedMessages = validatedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        setMessages(sortedMessages);

        // Initialize patient message timestamps from fetched messages
        const patientMessages = sortedMessages.filter((msg) => msg.sender === 'patient');
        if (patientMessages.length > 0) {
          setPatientMessageTimestamps((prev) => ({
            ...prev,
            [selectedPatientId]: {
              firstMessageTime: patientMessages[0].timestamp,
              lastMessageTime: patientMessages[patientMessages.length - 1].timestamp,
            },
          }));
        }
      } catch (err) {
        setError(`Error fetching messages: ${err.message}`);
      } finally {
        setLoadingMessages(false);
      }
    };

    const fetchLanguagePreference = async () => {
      try {
        const patientRef = doc(db, 'patients', selectedPatientId);
        const patientDoc = await getDoc(patientRef);
        setLanguagePreference(patientDoc.exists() ? patientDoc.data().languagePreference || 'en' : 'en');
      } catch (err) {
        setError(`Failed to fetch language preference: ${err.message}`);
      }
    };

    const fetchMissedDoseAlerts = async () => {
      try {
        const response = await fetch('http://localhost:5005/admin_notifications', {
          headers: { 'x-user-uid': user.uid },
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Failed to fetch alerts');
        const notifications = await response.json();
        setMissedDoseAlerts(
          notifications
            .filter((n) => n.patientId === selectedPatientId)
            .map((n) => ({ ...n, id: n.id || Date.now().toString() }))
        );
      } catch (err) {
        setError(`Failed to fetch alerts: ${err.message}`);
      }
    };

    fetchMessages();
    fetchLanguagePreference();
    fetchMissedDoseAlerts();

    return () => {
      if (socketRef.current) {
        socketRef.current.off('connect');
        socketRef.current.off('connect_error');
        socketRef.current.off('error');
        socketRef.current.off('newMessage');
        socketRef.current.off('missedDoseAlert');
        socketRef.current.disconnect();
        console.log('DoctorChat.js: WebSocket disconnected');
      }
    };
  }, [selectedPatientId, user?.uid, doctorId]);

  // Diagnosis Prompt Logic
  useEffect(() => {
    if (!selectedPatientId || !patients.length) return;

    const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
    if (!patientAssignment) return;

    const timestamps = patientMessageTimestamps[selectedPatientId];
    const now = new Date();

    // If no patient messages exist, check if within 24 hours of assignment
    if (!timestamps || !timestamps.firstMessageTime) {
      const hoursSinceAssignment = (now - new Date(patientAssignment.timestamp)) / (1000 * 60 * 60);
      if (hoursSinceAssignment <= 24) {
        setDiagnosisPrompt(selectedPatientId);
      } else {
        setDiagnosisPrompt(null);
      }
      return;
    }

    // Check time since first and last patient messages
    const hoursSinceFirstMessage = (now - new Date(timestamps.firstMessageTime)) / (1000 * 60 * 60);
    const hoursSinceLastMessage = (now - new Date(timestamps.lastMessageTime)) / (1000 * 60 * 60);

    if (hoursSinceFirstMessage <= 24 || hoursSinceLastMessage >= 168) {
      setDiagnosisPrompt(selectedPatientId);
    } else {
      setDiagnosisPrompt(null);
    }
  }, [selectedPatientId, patients, patientMessageTimestamps]);

  const handleDiagnosisDecision = useCallback(
    async (accept) => {
      if (!selectedPatientId) {
        setError('No patient selected.');
        return;
      }
      if (accept) {
        setDiagnosisPrompt(null);
      } else {
        const message = {
          sender: 'doctor',
          text: 'Sorry, I am not available at the moment. Please chat with another doctor.',
          translatedText:
            languagePreference === 'kn'
              ? await translateText(
                  'Sorry, I am not available at the moment. Please chat with another doctor.',
                  'en',
                  'kn'
                )
              : null,
          language: 'en',
          recordingLanguage: 'en',
          timestamp: new Date().toISOString(),
          doctorId,
          patientId: selectedPatientId,
        };
        try {
          const response = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
            body: JSON.stringify(message),
            credentials: 'include',
          });
          if (!response.ok) throw new Error(`Failed to send message: ${response.statusText}`);
          socketRef.current.emit('newMessage', message);
          setPatients((prev) => prev.filter((p) => p.patientId !== selectedPatientId));
          setSelectedPatientId(null);
          setSelectedPatientName('');
          setDiagnosisPrompt(null);
        } catch (err) {
          setError(`Failed to send message: ${err.message}`);
        }
      }
    },
    [selectedPatientId, languagePreference, doctorId, user.uid]
  );

  const retryUpload = useCallback(
    async (audioBlob, language) => {
      try {
        setError('');
        setFailedUpload(null);
        const transcriptionResult = await transcribeAudio(audioBlob, language, user.uid);
        if (!transcriptionResult.audioUrl) {
          setError('Transcription succeeded, but no audio URL was returned.');
          return null;
        }
        const response = await fetch(transcriptionResult.audioUrl, { method: 'HEAD' });
        if (!response.ok) {
          setError(`Audio URL inaccessible: ${transcriptionResult.audioUrl}`);
          return null;
        }
        return transcriptionResult;
      } catch (err) {
        setError(`Failed to transcribe audio: ${err.message}`);
        setFailedUpload({ audioBlob, language });
        return null;
      }
    },
    [user.uid]
  );

  const startRecording = useCallback(async () => {
    if (!selectedPatientId) {
      setError('No patient selected.');
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
          setError('Recorded audio is empty.');
          return;
        }

        let transcriptionResult;
        let transcribedText;
        let translatedText = null;
        let audioUrl;
        let audioUrlEn;
        let audioUrlKn = null;

        try {
          transcriptionResult = await transcribeAudio(audioBlob, 'en-US', user.uid);
          audioUrl = transcriptionResult.audioUrl;
          if (!audioUrl) {
            setError('Transcription succeeded, but no audio URL was returned.');
            return;
          }
          const response = await fetch(audioUrl, { method: 'HEAD' });
          if (!response.ok) {
            setError(`Audio URL inaccessible: ${audioUrl}`);
            return;
          }

          transcribedText = transcriptionResult.transcription || 'Transcription failed';
          audioUrlEn = await textToSpeechConvert(transcribedText, 'en-US');
          if (languagePreference === 'kn') {
            translatedText = await translateText(transcribedText, 'en', 'kn');
            audioUrlKn = await textToSpeechConvert(translatedText, 'kn-IN');
          }
        } catch (err) {
          setError(`Failed to process audio: ${err.message}`);
          setFailedUpload({ audioBlob, language: 'en-US' });
          return;
        }

        const message = {
          sender: 'doctor',
          text: transcribedText,
          translatedText,
          language: 'en',
          recordingLanguage: 'en',
          audioUrl,
          audioUrlEn,
          audioUrlKn,
          timestamp: new Date().toISOString(),
          doctorId,
          patientId: selectedPatientId,
        };

        try {
          const response = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
            body: JSON.stringify(message),
            credentials: 'include',
          });
          if (!response.ok) throw new Error(`Failed to save message: ${response.statusText}`);
          socketRef.current.emit('newMessage', message);
          setMessages((prev) => {
            if (!prev.some((msg) => msg.timestamp === message.timestamp && msg.text === message.text)) {
              return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            }
            return prev;
          });
        } catch (err) {
          setError(`Failed to send message: ${err.message}`);
        }
      };

      recorder.start();
      setRecording(true);
    } catch (err) {
      setError(`Failed to start recording: ${err.message}`);
    }
  }, [selectedPatientId, languagePreference, user.uid]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
  }, [mediaRecorder]);

  const sendMessage = useCallback(async () => {
    if (!newMessage.trim() || !selectedPatientId || !user?.uid || !doctorId) {
      setError('Please type a message and select a patient.');
      return;
    }

    let translatedText = null;
    let audioUrlEn;
    let audioUrlKn = null;

    try {
      audioUrlEn = await textToSpeechConvert(newMessage, 'en-US');
      if (languagePreference === 'kn') {
        translatedText = await translateText(newMessage, 'en', 'kn');
        audioUrlKn = await textToSpeechConvert(translatedText, 'kn-IN');
      }

      const message = {
        sender: 'doctor',
        text: newMessage,
        translatedText,
        language: 'en',
        recordingLanguage: 'en',
        audioUrl: null,
        audioUrlEn,
        audioUrlKn,
        timestamp: new Date().toISOString(),
        doctorId,
        patientId: selectedPatientId,
      };

      const response = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
        body: JSON.stringify(message),
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Failed to send message: ${response.statusText}`);
      socketRef.current.emit('newMessage', message);
      setMessages((prev) => {
        if (!prev.some((msg) => msg.timestamp === message.timestamp && msg.text === message.text)) {
          return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }
        return prev;
      });
      setNewMessage('');
    } catch (err) {
      setError(`Failed to send message: ${err.message}`);
    }
  }, [newMessage, selectedPatientId, user?.uid, doctorId, languagePreference]);

  const sendAction = useCallback(
    async () => {
      if (!selectedPatientId) {
        setError('No patient selected.');
        return;
      }

      if (actionType === 'Diagnosis' && !diagnosis.trim()) {
        setError('Please enter a diagnosis.');
        return;
      }

      if (actionType === 'Prescription') {
        const { medicine, dosage, frequency, duration } = prescription;
        if (!medicine.trim() || !dosage.trim() || !frequency.trim() || !duration.trim()) {
          setError('Please fill all prescription fields.');
          return;
        }
        const latestDiagnosisMessage = messages
          .filter((msg) => msg.sender === 'doctor' && msg.diagnosis)
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
        if (!latestDiagnosisMessage) {
          setError('Please provide a diagnosis first.');
          return;
        }
      }

      if (actionType === 'Combined' && (!diagnosis.trim() || !Object.values(prescription).every((v) => v.trim()))) {
        setError('Please fill all diagnosis and prescription fields.');
        return;
      }

      const prescriptionString =
        actionType === 'Prescription' || actionType === 'Combined'
          ? `${prescription.medicine}, ${prescription.dosage}, ${prescription.frequency}, ${prescription.duration}`
          : undefined;

      const message = {
        sender: 'doctor',
        ...(actionType === 'Diagnosis' || actionType === 'Combined' ? { diagnosis } : {}),
        ...(actionType === 'Prescription' || actionType === 'Combined'
          ? { prescription: { ...prescription } }
          : {}),
        timestamp: new Date().toISOString(),
        doctorId,
        patientId: selectedPatientId,
      };

      try {
        // Send message to chat
        const chatResponse = await fetch(`http://localhost:5005/chats/${selectedPatientId}/${doctorId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
          body: JSON.stringify(message),
          credentials: 'include',
        });
        if (!chatResponse.ok) throw new Error(`Failed to send message: ${chatResponse.statusText}`);
        socketRef.current.emit('newMessage', message);
        setMessages((prev) => {
          if (!prev.some((msg) => msg.timestamp === message.timestamp)) {
            return [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          }
          return prev;
        });

        // Update patient record
        await fetch(`http://localhost:5005/patients/${selectedPatientId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
          body: JSON.stringify({
            ...(actionType === 'Diagnosis' || actionType === 'Combined' ? { diagnosis } : {}),
            ...(actionType === 'Prescription' || actionType === 'Combined' ? { prescription: prescriptionString } : {}),
            doctorId,
          }),
          credentials: 'include',
        });

        // Notify admin
        const selectedPatient = patients.find((p) => p.patientId === selectedPatientId);
        const disease = actionType === 'Prescription' ? messages
          .filter((msg) => msg.sender === 'doctor' && msg.diagnosis)
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.diagnosis : diagnosis;
        await fetch('http://localhost:5005/admin_notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-uid': user.uid },
          body: JSON.stringify({
            patientId: selectedPatientId,
            patientName: selectedPatientName,
            age: selectedPatient?.age || 'N/A',
            sex: selectedPatient?.sex || 'N/A',
            description: 'N/A',
            disease: disease || 'N/A',
            medicine: (actionType === 'Prescription' || actionType === 'Combined') ? prescriptionString : undefined,
            doctorId,
          }),
          credentials: 'include',
        });

        setDiagnosis('');
        setPrescription({ medicine: '', dosage: '', frequency: '', duration: '' });
        setShowActionModal(false);
        setActionType('');
      } catch (err) {
        setError(`Failed to send action: ${err.message}`);
      }
    },
    [actionType, diagnosis, prescription, selectedPatientId, doctorId, user.uid, selectedPatientName, patients, messages]
  );

  const readAloud = useCallback(
    async (audioUrl, lang, fallbackText) => {
      try {
        if (!audioUrl && (!fallbackText || typeof fallbackText !== 'string' || fallbackText.trim() === '')) {
          setError('Cannot read aloud: No valid audio or text provided.');
          return;
        }
        const normalizedLang = lang === 'kn' ? 'kn-IN' : 'en-US';
        const audioToPlay = audioUrl || (await textToSpeechConvert(fallbackText.trim(), normalizedLang));
        audioRef.current.src = audioToPlay;
        audioRef.current.play();
      } catch (err) {
        setError(`Failed to read aloud: ${err.message}`);
      }
    },
    []
  );

  const dismissAlert = useCallback((alertId) => {
    setMissedDoseAlerts((prev) => prev.filter((alert) => alert.id !== alertId));
  }, []);

  const isValidPrescription = useCallback((prescription) => {
    return (
      prescription &&
      prescription.medicine &&
      prescription.dosage &&
      prescription.frequency &&
      prescription.duration
    );
  }, []);

  return (
    <div className="doctor-chat-container">
      <div className="chat-header">
        <button className="hamburger-button" onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <h2>{selectedPatientId ? `Chat with ${selectedPatientName}` : 'Doctor Dashboard'}</h2>
        <div className="header-actions">
          <button onClick={() => setDoctorProfile(doctorProfile)} className="profile-button">
            Profile
          </button>
          <button onClick={handleLogout} className="logout-button">
            Logout
          </button>
        </div>
      </div>
      <div className="chat-layout">
        <div className={`patient-sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Assigned Patients</h3>
            <button className="close-menu" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          {loadingPatients ? (
            <p className="loading-text">Loading...</p>
          ) : patients.length === 0 ? (
            <p className="no-patients">No patients assigned.</p>
          ) : (
            <ul className="patient-list">
              {patients.map((patient) => (
                <li
                  key={patient.patientId}
                  className={`patient-item ${selectedPatientId === patient.patientId ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedPatientId(patient.patientId);
                    setSelectedPatientName(patient.patientName);
                    setMissedDoseAlerts([]);
                    setMenuOpen(false);
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Select patient ${patient.patientName}`}
                >
                  <span>{patient.patientName}</span>
                  <small>{new Date(patient.timestamp).toLocaleDateString()}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="chat-content">
          {doctorProfile && (
            <div className="doctor-profile">
              <h3>Doctor Profile</h3>
              <p><strong>Name:</strong> {doctorProfile.name}</p>
              <p><strong>Doctor ID:</strong> {doctorProfile.doctorId}</p>
              <p><strong>Email:</strong> {doctorProfile.email}</p>
              <button onClick={() => setDoctorProfile(null)} className="close-section-button">
                Close
              </button>
            </div>
          )}
          {selectedPatientId ? (
            diagnosisPrompt === selectedPatientId ? (
              <div className="diagnosis-prompt">
                <h3>Chat with {selectedPatientName}</h3>
                <p>
                  {(() => {
                    const timestamps = patientMessageTimestamps[selectedPatientId];
                    if (!timestamps || !timestamps.firstMessageTime) {
                      return 'New patient (within 24 hours). ';
                    }
                    const hoursSinceLastMessage = (new Date() - new Date(timestamps.lastMessageTime)) / (1000 * 60 * 60);
                    if (hoursSinceLastMessage >= 168) {
                      return 'Last chat over 7 days ago. ';
                    }
                    return 'New message from patient. ';
                  })()}
                  Chat now?
                </p>
                <div className="prompt-buttons">
                  <button onClick={() => handleDiagnosisDecision(true)} className="accept-button">
                    Yes
                  </button>
                  <button onClick={() => handleDiagnosisDecision(false)} className="decline-button">
                    No
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-main">
                {missedDoseAlerts.length > 0 && (
                  <div className="missed-dose-alerts">
                    <h3>Missed Dose Alerts</h3>
                    {missedDoseAlerts.map((alert) => (
                      <div key={alert.id} className="alert-item">
                        <p>{alert.message || `Patient missed doses.`}</p>
                        <button onClick={() => dismissAlert(alert.id)} className="dismiss-button">
                          Dismiss
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="messages-container">
                  {loadingMessages ? (
                    <p className="loading-text">Loading messages...</p>
                  ) : messages.length === 0 ? (
                    <p className="no-messages">No messages yet.</p>
                  ) : (
                    messages.map((msg, index) => (
                      <div
                        key={`${msg.timestamp}-${index}`}
                        className={`message ${msg.sender === 'doctor' ? 'doctor-message' : 'patient-message'}`}
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
                                  {(msg.audioUrlEn || msg.audioUrlKn) && (
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
                                          onClick={() =>
                                            readAloud(msg.audioUrlEn, 'en', msg.translatedText || msg.text)
                                          }
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
                              {msg.text && (
                                <>
                                  {languagePreference === 'en' ? (
                                    <p className="primary-text">{msg.text}</p>
                                  ) : (
                                    <>
                                      <p className="primary-text">{msg.translatedText || msg.text}</p>
                                      {msg.text && <p className="translated-text">English: {msg.text}</p>}
                                    </>
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
                                  {(msg.audioUrlEn || msg.audioUrlKn) && (
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
                                </>
                              )}
                              {(msg.diagnosis || msg.prescription) && (
                                <div className="recommendation-item">
                                  {msg.diagnosis ? (
                                    <div>
                                      <strong>Diagnosis:</strong> {msg.diagnosis}
                                      <button
                                        onClick={() => readAloud(null, 'en', msg.diagnosis)}
                                        className="read-aloud-button"
                                      >
                                        🔊
                                      </button>
                                    </div>
                                  ) : (
                                    <p className="missing-field">Diagnosis not provided.</p>
                                  )}
                                  {msg.prescription && isValidPrescription(msg.prescription) ? (
                                    <div>
                                      <strong>Prescription:</strong>{' '}
                                      {`${msg.prescription.medicine}, ${msg.prescription.dosage}, ${msg.prescription.frequency}, ${msg.prescription.duration}`}
                                    </div>
                                  ) : (
                                    <p className="missing-field">Prescription not provided.</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                          <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>
                {error && (
                  <div className="error-message">
                    {error}
                    {failedUpload && (
                      <button
                        onClick={() => retryUpload(failedUpload.audioBlob, failedUpload.language)}
                        className="retry-button"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                )}
                <div className="controls">
                  <div className="recording-buttons">
                    <button
                      onClick={startRecording}
                      disabled={recording}
                      className={recording ? 'disabled-button' : 'start-button'}
                    >
                      🎙️ Record
                    </button>
                    <button
                      onClick={stopRecording}
                      disabled={!recording}
                      className={!recording ? 'disabled-button' : 'stop-button'}
                    >
                      🛑 Stop
                    </button>
                    <button
                      onClick={() => setShowActionModal(true)}
                      className="action-button"
                    >
                      ⚕️ Diagnosis/Prescription
                    </button>
                  </div>
                  <div className="text-input-container">
                    <input
                      type="text"
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      placeholder="Type a message (English only)..."
                      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                      aria-label="Type a message to the patient"
                    />
                    <button onClick={sendMessage} className="send-button">
                      Send
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="no-patient-selected">
              <p>Select a patient to start chatting.</p>
            </div>
          )}
        </div>
      </div>
      {showActionModal && (
        <div className="action-modal">
          <div className="modal-content">
            <h3>{actionType ? `${actionType} Entry` : 'Select an Action'}</h3>
            <div className="action-type-selection">
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                aria-label="Select action type (Diagnosis, Prescription, or Combined)"
              >
                <option value="">Select an action...</option>
                <option value="Diagnosis">Diagnosis Only</option>
                <option value="Prescription">Prescription Only</option>
                <option value="Combined">Diagnosis and Prescription</option>
              </select>
              {(actionType === 'Diagnosis' || actionType === 'Combined') && (
                <textarea
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="Enter diagnosis..."
                  aria-label="Enter patient diagnosis"
                />
              )}
              {(actionType === 'Prescription' || actionType === 'Combined') && (
                <>
                  <input
                    type="text"
                    value={prescription.medicine}
                    onChange={(e) => setPrescription({ ...prescription, medicine: e.target.value })}
                    placeholder="Medicine (e.g., Paracetamol)"
                    aria-label="Enter medicine name"
                  />
                  <input
                    type="text"
                    value={prescription.dosage}
                    onChange={(e) => setPrescription({ ...prescription, dosage: e.target.value })}
                    placeholder="Dosage (e.g., 500mg)"
                    aria-label="Enter dosage"
                  />
                  <input
                    type="text"
                    value={prescription.frequency}
                    onChange={(e) => setPrescription({ ...prescription, frequency: e.target.value })}
                    placeholder="Frequency (e.g., 08:00 AM and 06:00 PM)"
                    aria-label="Enter dosage frequency"
                  />
                  <input
                    type="text"
                    value={prescription.duration}
                    onChange={(e) => setPrescription({ ...prescription, duration: e.target.value })}
                    placeholder="Duration (e.g., 3 days)"
                    aria-label="Enter prescription duration"
                  />
                </>
              )}
            </div>
            <div className="modal-buttons">
              {actionType && (
                <button onClick={sendAction} className="submit-button">
                  Send {actionType}
                </button>
              )}
              <button
                onClick={() => {
                  setShowActionModal(false);
                  setActionType('');
                  setDiagnosis('');
                  setPrescription({ medicine: '', dosage: '', frequency: '', duration: '' });
                }}
                className="close-modal"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        .doctor-chat-container {
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
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 15px;
        }

        .profile-button {
          padding: 8px 20px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 25px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .profile-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
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

        .patient-sidebar {
          width: 0;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          padding: 0;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          overflow-y: auto;
          transition: width 0.3s ease, padding 0.3s ease;
        }

        .patient-sidebar.open {
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

        .loading-text,
        .no-patients {
          color: #A0A0A0;
          font-size: 1rem;
          text-align: center;
          margin-top: 20px;
        }

        .patient-list {
          list-style: none;
        }

        .patient-item {
          padding: 15px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          margin-bottom: 10px;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .patient-item:hover,
        .patient-item:focus {
          background: rgba(255, 255, 255, 0.2);
          transform: translateX(5px);
        }

        .patient-item.selected {
          background: #6E48AA;
          color: #FFFFFF;
        }

        .patient-item span {
          font-size: 1rem;
          font-weight: 500;
        }

        .patient-item small {
          display: block;
          font-size: 0.8rem;
          color: #B0B0B0;
          margin-top: 5px;
        }

        .chat-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 20px 30px;
          overflow-y: auto;
        }

        .doctor-profile {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 20px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .doctor-profile h3 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #FFFFFF;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .doctor-profile h3::before {
          content: '👨‍⚕️';
          font-size: 1.4rem;
        }

        .doctor-profile p {
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

        .diagnosis-prompt {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 30px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .diagnosis-prompt h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
          margin-bottom: 20px;
        }

        .diagnosis-prompt p {
          font-size: 1.2rem;
          color: #E0E0E0;
          margin-bottom: 20px;
          text-align: center;
        }

        .prompt-buttons {
          display: flex;
          gap: 15px;
        }

        .accept-button {
          padding: 10px 25px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .accept-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .decline-button {
          padding: 10px 25px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .decline-button:hover {
          background: #C0392B;
          transform: scale(1.05);
        }

        .chat-main {
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .missed-dose-alerts {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 20px;
          margin-bottom: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .missed-dose-alerts h3 {
          font-size: 1.4rem;
          font-weight: 600;
          color: #E74C3C;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .missed-dose-alerts h3::before {
          content: '⚠️';
          font-size: 1.4rem;
        }

        .alert-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(231, 76, 60, 0.1);
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 10px;
        }

        .alert-item p {
          font-size: 1rem;
          color: #E0E0E0;
        }

        .dismiss-button {
          padding: 6px 12px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .dismiss-button:hover {
          background: #C0392B;
          transform: scale(1.05);
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

        .no-messages,
        .loading-text {
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

        .recommendation-item {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          padding: 15px;
          margin-bottom: 10px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          font-size: 1rem;
          color: #E0E0E0;
        }

        .recommendation-item div {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .recommendation-item strong {
          color: #FFFFFF;
        }

        .missing-field {
          color: #E74C3C;
          font-style: italic;
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

        .action-button {
          padding: 8px 20px;
          background: #F39C12;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .action-button:hover {
          background: #E67E22;
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

        .text-input-container {
          display: flex;
          gap: 10px;
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

        .no-patient-selected {
          flex: 1;
          display: flex;
          justify-content: center;
          align-items: center;
          color: #A0A0A0;
          font-size: 1.2rem;
        }

        .action-modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 1000;
        }

        .modal-content {
          background: rgba(44, 26, 61, 0.95);
          backdrop-filter: blur(10px);
          padding: 30px;
          border-radius: 15px;
          width: 450px;
          max-width: 90%;
          display: flex;
          flex-direction: column;
          gap: 20px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .modal-content h3 {
          font-size: 1.5rem;
          color: #FFFFFF;
          margin-bottom: 10px;
        }

        .action-type-selection {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }

        .modal-content select,
        .modal-content input,
        .modal-content textarea {
          width: 100%;
          padding: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          color: #FFFFFF;
          font-size: 1rem;
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }

        .modal-content select:focus,
        .modal-content input:focus,
        .modal-content textarea:focus {
          outline: none;
          border-color: #6E48AA;
          box-shadow: 0 0 8px rgba(110, 72, 170, 0.3);
        }

        .modal-content textarea {
          min-height: 100px;
          resize: none;
        }

        .modal-buttons {
          display: flex;
          gap: 15px;
          justify-content: center;
        }

        .submit-button {
          padding: 10px 20px;
          background: #27AE60;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .submit-button:hover {
          background: #219653;
          transform: scale(1.05);
        }

        .close-modal {
          padding: 10px 20px;
          background: #E74C3C;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .close-modal:hover {
          background: #C0392B;
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

export default DoctorChat;