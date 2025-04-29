import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, onSnapshot, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase.js';
import { getAuth, signOut } from 'firebase/auth';
import Pusher from 'pusher-js';
import { transcribeAudio, translateText, textToSpeechConvert, playAudio } from '../services/speech.js';

function DoctorChat({ user, role, handleLogout, setError }) {
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
  const [failedUpload, setFailedUpload] = useState(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [diagnosisPrompt, setDiagnosisPrompt] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [languagePreference, setLanguagePreference] = useState('en');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showActionModal, setShowActionModal] = useState(false);
  const [actionType, setActionType] = useState('');
  const [patientMessageTimestamps, setPatientMessageTimestamps] = useState({});
  const [acceptedPatients, setAcceptedPatients] = useState({});
  const audioRef = useRef(new Audio());
  const messagesEndRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const navigate = useNavigate();

  const auth = getAuth();
  const apiBaseUrl = process.env.REACT_APP_API_URL || 'https://healthcare-app-vercel.vercel.app/api';

  // Flag to control whether admin/notify endpoint is called
  const shouldNotifyAdmin = true; // Set to false if you want to disable admin notifications

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    console.log('Scrolled to bottom of messages');
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    console.log('Checking role and user authentication:', { role, userUid: user?.uid });
    if (role !== 'doctor' || !user?.uid) {
      const errorMsg = 'Please log in as a doctor.';
      setError(errorMsg);
      console.error(errorMsg);
      navigate('/login', { replace: true });
      return;
    }

    const fetchDoctorId = async () => {
      console.log('Fetching doctor ID for user:', user.uid);
      try {
        const q = query(collection(db, 'doctors'), where('uid', '==', user.uid));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
          const errorMsg = 'Doctor profile not found.';
          setError(errorMsg);
          console.error(errorMsg);
          setLoadingPatients(false);
          return;
        }
        const doctorDoc = querySnapshot.docs[0];
        const doctorData = doctorDoc.data();
        setDoctorId(doctorData.doctorId);
        console.log('Doctor ID fetched successfully:', doctorData.doctorId);
      } catch (err) {
        const errorMsg = `Failed to fetch doctor profile: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch doctor profile error:', err);
        setLoadingPatients(false);
      }
    };

    fetchDoctorId();
  }, [role, user?.uid, navigate, setError]);

  useEffect(() => {
    console.log('Doctor ID updated, fetching patients:', doctorId);
    if (!doctorId) return;

    setLoadingPatients(true);
    const q = query(collection(db, 'doctor_assignments'), where('doctorId', '==', doctorId));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        console.log('Snapshot received for doctor assignments:', snapshot.size);
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
          console.log('Selected default patient:', assignedPatients[0]);
        }
      },
      (err) => {
        const errorMsg = `Failed to fetch patients: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch patients error:', err);
        setLoadingPatients(false);
      }
    );

    return () => {
      console.log('Unsubscribing from doctor assignments snapshot');
      unsubscribe();
    };
  }, [doctorId, selectedPatientId, setError]);

  useEffect(() => {
    console.log('Fetching accepted patients for doctor:', doctorId);
    if (!doctorId) return;

    const fetchAcceptedPatients = async () => {
      try {
        const acceptedRef = doc(db, 'doctor_accepted_patients', doctorId);
        const acceptedDoc = await getDoc(acceptedRef);
        if (acceptedDoc.exists()) {
          setAcceptedPatients(acceptedDoc.data().accepted || {});
          console.log('Accepted patients fetched:', acceptedDoc.data().accepted);
        } else {
          console.log('No accepted patients document found');
          setAcceptedPatients({});
        }
      } catch (err) {
        const errorMsg = `Failed to fetch accepted patients: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch accepted patients error:', err);
      }
    };

    fetchAcceptedPatients();
  }, [doctorId, setError]);

  const getIdToken = async () => {
    console.log('Attempting to get ID token for user:', user?.uid);
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        throw new Error('No authenticated user found');
      }
      const idToken = await currentUser.getIdToken();
      console.log('ID token retrieved successfully');
      return idToken;
    } catch (error) {
      const errorMsg = `Failed to get ID token: ${error.message}`;
      setError(errorMsg);
      console.error('Get ID token error:', error);
      throw error;
    }
  };

  useEffect(() => {
    console.log('Setting up Pusher and fetching data for patient:', selectedPatientId);
    if (!selectedPatientId || !user?.uid || !doctorId) return;

    // Initialize Pusher with proper configuration
    const pusher = new Pusher(process.env.REACT_APP_PUSHER_APP_ID || '2ed44c3ce3ef227d9924', {
      cluster: process.env.REACT_APP_PUSHER_CLUSTER || 'ap2',
      authEndpoint: `${apiBaseUrl}/pusher/auth`,
      auth: {
        headers: {
          'x-user-uid': user.uid,
          'Authorization': `Bearer ${user.uid}`,
        },
      },
    });

    const channelName = `chat-${selectedPatientId}-${doctorId}`;
    const channel = pusher.subscribe(channelName);
    console.log('Subscribed to Pusher channel:', channelName);

    channel.bind('pusher:subscription_succeeded', () => {
      console.log('Successfully subscribed to Pusher channel:', channelName);
    });

    channel.bind('pusher:subscription_error', (error) => {
      console.error('Pusher subscription error:', error);
      setError('Failed to subscribe to real-time updates. Please refresh the page.');
    });

    channel.bind('new-message', (message) => {
      console.log('New message received from Pusher:', message);
      setMessages((prev) => {
        // Check for duplicates using tempMessageId, timestamp, and content
        const isDuplicate = prev.some(
          (msg) =>
            (message.tempMessageId && msg.tempMessageId === message.tempMessageId) ||
            (msg.timestamp === message.timestamp &&
              msg.sender === message.sender &&
              msg.text === message.text &&
              msg.diagnosis === message.diagnosis &&
              JSON.stringify(msg.prescription) === JSON.stringify(message.prescription))
        );
        if (!isDuplicate) {
          const updatedMessages = [...prev, message].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
        console.log('Duplicate message ignored:', message);
        return prev;
      });
    });

    channel.bind('missedDoseAlert', (alert) => {
      console.log('Missed dose alert received from Pusher:', alert);
      if (alert.patientId === selectedPatientId) {
        setMissedDoseAlerts((prev) => [...prev, { ...alert, id: Date.now().toString() }]);
      }
    });

    const fetchMessages = async () => {
      console.log('Fetching messages for patient:', selectedPatientId, 'and doctor:', doctorId);
      setLoadingMessages(true);
      try {
        const idToken = await getIdToken();
        const response = await fetch(`${apiBaseUrl}/chats/${selectedPatientId}/${doctorId}`, {
          method: 'GET',
          headers: {
            'x-user-uid': user.uid,
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        });

        console.log('Fetch messages response status:', response.status);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text() || 'Failed to fetch messages'}`);
        }

        const data = await response.json();
        console.log('Fetched messages data:', data);
        const fetchedMessages = data.messages || [];
        setMessages(fetchedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));

        const patientMessages = fetchedMessages.filter((msg) => msg.sender === 'patient');
        if (patientMessages.length > 0) {
          setPatientMessageTimestamps((prev) => ({
            ...prev,
            [selectedPatientId]: {
              firstMessageTime: patientMessages[0].timestamp,
              lastMessageTime: patientMessages[patientMessages.length - 1].timestamp,
            },
          }));
          console.log('Updated patient message timestamps:', patientMessages);
        }
      } catch (err) {
        const errorMsg = `Error fetching messages: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch messages error:', err);
      } finally {
        setLoadingMessages(false);
        console.log('Finished loading messages');
      }
    };

    const fetchLanguagePreference = async () => {
      console.log('Fetching language preference for patient:', selectedPatientId);
      try {
        const patientRef = doc(db, 'patients', selectedPatientId);
        const patientDoc = await getDoc(patientRef);
        setLanguagePreference(patientDoc.exists() ? patientDoc.data().languagePreference || 'en' : 'en');
        console.log('Language preference fetched:', patientDoc.data()?.languagePreference || 'en');
      } catch (err) {
        const errorMsg = `Failed to fetch language preference: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch language preference error:', err);
      }
    };

    const fetchMissedDoseAlerts = async () => {
      console.log('Fetching missed dose alerts for patient:', selectedPatientId, 'and doctor:', doctorId);
      if (!selectedPatientId || !doctorId) {
        const errorMsg = 'Cannot fetch alerts: patientId or doctorId is missing.';
        setError(errorMsg);
        console.error(errorMsg);
        return;
      }

      try {
        const idToken = await getIdToken();
        const response = await fetch(`${apiBaseUrl}/admin/missed-doses/${selectedPatientId}/${doctorId}`, {
          method: 'GET',
          headers: {
            'x-user-uid': user.uid,
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        });

        console.log('Fetch alerts response status:', response.status);
        if (!response.ok) {
          const errorText = await response.text();
          console.error('Fetch alerts response error:', errorText);
          throw new Error(`HTTP ${response.status}: ${errorText || 'Failed to fetch alerts'}`);
        }

        const data = await response.json();
        console.log('Fetched alerts data:', data);
        const notifications = data.alerts || [];
        if (!Array.isArray(notifications)) {
          throw new Error('Invalid response format: Expected an array of notifications');
        }

        setMissedDoseAlerts(
          notifications
            .filter((n) => n.patientId === selectedPatientId)
            .map((n) => ({ ...n, id: n.id || Date.now().toString() }))
        );
        console.log('Updated missed dose alerts:', notifications);
      } catch (err) {
        const errorMsg = `Failed to fetch alerts: ${err.message}`;
        setError(errorMsg);
        console.error('Fetch alerts error:', err);
      }
    };

    fetchMessages();
    fetchLanguagePreference();
    fetchMissedDoseAlerts();

    return () => {
      console.log('Cleaning up Pusher subscription');
      pusher.unsubscribe(channelName);
      pusher.disconnect();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        console.log('Stopped media stream tracks');
      }
    };
  }, [selectedPatientId, user?.uid, doctorId, apiBaseUrl, setError]);

  useEffect(() => {
    console.log('Evaluating diagnosis prompt for patient:', selectedPatientId);
    if (!selectedPatientId || !patients.length) return;

    const patientAssignment = patients.find((p) => p.patientId === selectedPatientId);
    if (!patientAssignment) return;

    if (acceptedPatients[selectedPatientId]) {
      setDiagnosisPrompt(null);
      console.log('Diagnosis prompt cleared: Patient already accepted');
      return;
    }

    const timestamps = patientMessageTimestamps[selectedPatientId];
    const now = new Date();
    const assignmentTime = new Date(patientAssignment.timestamp);
    const hoursSinceAssignment = (now - assignmentTime) / (1000 * 60 * 60);

    if (!timestamps || !timestamps.firstMessageTime) {
      if (hoursSinceAssignment <= 24) {
        setDiagnosisPrompt(selectedPatientId);
        console.log('Diagnosis prompt set for new patient within 24 hours');
      } else {
        setDiagnosisPrompt(null);
        console.log('Diagnosis prompt cleared for old patient with no messages');
      }
      return;
    }

    const hoursSinceFirstMessage = (now - new Date(timestamps.firstMessageTime)) / (1000 * 60 * 60);
    const hoursSinceLastMessage = (now - new Date(timestamps.lastMessageTime)) / (1000 * 60 * 60);

    if (hoursSinceFirstMessage <= 24 || hoursSinceLastMessage >= 168) {
      setDiagnosisPrompt(selectedPatientId);
      console.log('Diagnosis prompt set due to new message or inactivity > 7 days');
    } else {
      setDiagnosisPrompt(null);
      console.log('Diagnosis prompt cleared due to active conversation');
    }
  }, [selectedPatientId, patients, patientMessageTimestamps, acceptedPatients]);

  const handleDiagnosisDecision = useCallback(
    async (accept) => {
      console.log('Handling diagnosis decision:', { accept, selectedPatientId });
      if (!selectedPatientId || !doctorId) {
        const errorMsg = 'No patient selected or doctor ID missing.';
        setError(errorMsg);
        console.error(errorMsg);
        return;
      }

      try {
        const idToken = await getIdToken();
        const response = await fetch(`${apiBaseUrl}/admin/accept-patient`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-uid': user.uid,
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            doctorId,
            patientId: selectedPatientId,
            accept,
          }),
          credentials: 'include',
        });

        if (!response.ok) {
          const errorText = await response.text();
          let userFriendlyMessage = `Failed to process patient decision: HTTP ${response.status}`;

          if (response.status === 405) {
            userFriendlyMessage = 'The server does not support this action. Please try again later or contact support.';
          } else if (response.status === 403) {
            userFriendlyMessage = 'You are not authorized to perform this action.';
          } else if (response.status === 404) {
            userFriendlyMessage = 'Patient or doctor assignment not found.';
          } else {
            userFriendlyMessage = `Failed to process patient decision: ${errorText || 'Unknown error'}`;
          }

          throw new Error(userFriendlyMessage);
        }

        const result = await response.json();
        console.log('Accept patient response:', result);

        if (accept) {
          setAcceptedPatients((prev) => ({
            ...prev,
            [selectedPatientId]: true,
          }));
          setDiagnosisPrompt(null);
          console.log('Patient accepted successfully:', selectedPatientId);
        } else {
          const declineMessage = {
            sender: 'doctor',
            text: 'Sorry, I am not available at the moment. Please chat with another doctor.',
            translatedText: languagePreference === 'kn' ? await translateText(
              'Sorry, I am not available at the moment. Please chat with another doctor.',
              'en',
              'kn',
              user.uid,
              idToken
            ) : null,
            language: 'en',
            recordingLanguage: 'en',
            timestamp: new Date().toISOString(),
            doctorId,
            patientId: selectedPatientId,
            tempMessageId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Updated tempMessageId
          };

          const messageResponse = await fetch(`${apiBaseUrl}/chats/${selectedPatientId}/${doctorId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-uid': user.uid,
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({ message: declineMessage, append: true }),
            credentials: 'include',
          });

          if (!messageResponse.ok) {
            throw new Error(`HTTP ${messageResponse.status}: ${await messageResponse.text()}`);
          }

          setPatients((prev) => prev.filter((p) => p.patientId !== selectedPatientId));
          setSelectedPatientId(null);
          setSelectedPatientName('');
          setDiagnosisPrompt(null);
          console.log('Patient declined and message sent:', declineMessage);
        }
      } catch (err) {
        const errorMsg = err.message || 'An unexpected error occurred while processing the patient decision.';
        setError(errorMsg);
        console.error('Diagnosis decision error:', err);
      }
    },
    [selectedPatientId, doctorId, user?.uid, languagePreference, apiBaseUrl, setError]
  );

  const retryUpload = useCallback(
    async (audioBlob, language) => {
      console.log('Retrying audio upload:', { audioBlob, language });
      try {
        setFailedUpload(null);
        setLoadingAudio(true);
        const idToken = await getIdToken();
        const transcriptionResult = await transcribeAudio(audioBlob, language, user.uid, idToken);
        if (!transcriptionResult.audioUrl) {
          const errorMsg = 'Transcription succeeded, but no audio URL was returned.';
          setError(errorMsg);
          console.error(errorMsg);
          return null;
        }
        console.log('Retry upload successful:', transcriptionResult);
        return transcriptionResult;
      } catch (err) {
        const errorMsg = `Failed to transcribe audio: ${err.message}`;
        setError(errorMsg);
        setFailedUpload({ audioBlob, language });
        console.error('Retry upload error:', err);
        return null;
      } finally {
        setLoadingAudio(false);
        console.log('Finished retrying audio upload');
      }
    },
    [user?.uid, setError]
  );

  const startRecording = useCallback(async () => {
    console.log('Starting recording for patient:', selectedPatientId);
    if (!selectedPatientId) {
      const errorMsg = 'No patient selected.';
      setError(errorMsg);
      console.error(errorMsg);
      return;
    }
    if (!user?.uid) {
      const errorMsg = 'User not authenticated.';
      setError(errorMsg);
      console.error(errorMsg);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      setMediaRecorder(recorder);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
        console.log('Audio chunk recorded:', e.data.size);
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size === 0) {
          const errorMsg = 'Recorded audio is empty.';
          setError(errorMsg);
          setLoadingAudio(false);
          console.error(errorMsg);
          return;
        }

        setLoadingAudio(true);
        let transcriptionResult;
        let transcribedText;
        let translatedText = null;
        let audioUrl;
        let audioUrlEn;
        let audioUrlKn = null;

        try {
          const idToken = await getIdToken();
          console.log('Transcribing audio with language:', 'en-US');
          transcriptionResult = await transcribeAudio(audioBlob, 'en-US', user.uid, idToken);
          audioUrl = transcriptionResult.audioUrl;
          if (!audioUrl) {
            const errorMsg = 'Transcription succeeded, but no audio URL was returned.';
            setError(errorMsg);
            setLoadingAudio(false);
            console.error(errorMsg);
            return;
          }

          transcribedText = transcriptionResult.transcription || 'Transcription failed';
          console.log('Transcription result:', transcribedText);
          audioUrlEn = await textToSpeechConvert(transcribedText, 'en-US', user.uid, idToken);
          if (languagePreference === 'kn') {
            translatedText = await translateText(transcribedText, 'en', 'kn', user.uid, idToken);
            audioUrlKn = await textToSpeechConvert(translatedText, 'kn-IN', user.uid, idToken);
            console.log('Translated text:', translatedText);
          }
        } catch (err) {
          const errorMsg = `Failed to process audio: ${err.message}`;
          setError(errorMsg);
          setFailedUpload({ audioBlob, language: 'en-US' });
          setLoadingAudio(false);
          console.error('Audio processing error:', err);
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
          tempMessageId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Updated tempMessageId
        };

        try {
          const idToken = await getIdToken();
          const response = await fetch(`${apiBaseUrl}/chats/${selectedPatientId}/${doctorId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-uid': user.uid,
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({ message, append: true }),
            credentials: 'include',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          console.log('Message sent successfully:', message);
        } catch (err) {
          const errorMsg = `Failed to send message: ${err.message}`;
          setError(errorMsg);
          console.error('Send message error:', err);
        } finally {
          setLoadingAudio(false);
          console.log('Finished processing audio recording');
        }
      };

      recorder.start();
      setRecording(true);
      console.log('Recording started');
    } catch (err) {
      const errorMsg = `Failed to start recording: ${err.message}`;
      setError(errorMsg);
      console.error('Recording error:', err);
    }
  }, [selectedPatientId, languagePreference, user?.uid, apiBaseUrl, doctorId, setError]);

  const stopRecording = useCallback(() => {
    console.log('Stopping recording');
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      console.log('Recording stopped and stream tracks cleared');
    }
  }, [mediaRecorder]);

  const sendMessage = useCallback(async () => {
    console.log('Sending message:', newMessage, 'to patient:', selectedPatientId);
    if (!newMessage.trim() || !selectedPatientId || !user?.uid || !doctorId) {
      const errorMsg = 'Please type a message and select a patient.';
      setError(errorMsg);
      console.error(errorMsg);
      return;
    }

    setLoadingAudio(false);
    const message = {
      sender: 'doctor',
      text: newMessage,
      translatedText: null,
      language: 'en',
      recordingLanguage: 'en',
      audioUrl: null,
      audioUrlEn: null,
      audioUrlKn: null,
      timestamp: new Date().toISOString(),
      doctorId,
      patientId: selectedPatientId,
      tempMessageId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Updated tempMessageId
    };

    try {
      const idToken = await getIdToken();
      const response = await fetch(`${apiBaseUrl}/chats/${selectedPatientId}/${doctorId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-uid': user.uid,
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ message, append: true }),
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      console.log('Message sent successfully:', message);
      setNewMessage('');
    } catch (err) {
      const errorMsg = `Failed to send message: ${err.message}`;
      setError(errorMsg);
      console.error('Send message error:', err);
    } finally {
      setLoadingAudio(false);
      console.log('Finished sending message');
    }
  }, [newMessage, selectedPatientId, user?.uid, doctorId, apiBaseUrl, setError]);

  const sendAction = useCallback(
    async () => {
      console.log('Sending action:', { actionType, diagnosis, prescription, selectedPatientId });
      if (!selectedPatientId || !doctorId) {
        const errorMsg = 'No patient selected or doctor ID missing.';
        setError(errorMsg);
        console.error(errorMsg);
        return;
      }

      if (actionType === 'Diagnosis' && !diagnosis.trim()) {
        const errorMsg = 'Please enter a diagnosis.';
        setError(errorMsg);
        console.error(errorMsg);
        return;
      }

      if (actionType === 'Combined' && (!diagnosis.trim() || !Object.values(prescription).every((v) => v.trim()))) {
        const errorMsg = 'Please fill all diagnosis and prescription fields.';
        setError(errorMsg);
        console.error(errorMsg);
        return;
      }

      const prescriptionString =
        actionType === 'Combined'
          ? `${prescription.medicine}, ${prescription.dosage}, ${prescription.frequency}, ${prescription.duration} days`
          : undefined;

      const tempMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; // Updated tempMessageId
      const message = {
        sender: 'doctor',
        ...(actionType === 'Diagnosis' || actionType === 'Combined' ? { diagnosis } : {}),
        ...(actionType === 'Combined' ? { prescription: { ...prescription } } : {}),
        timestamp: new Date().toISOString(),
        doctorId,
        patientId: selectedPatientId,
        tempMessageId,
      };

      try {
        const idToken = await getIdToken();
        console.log('Sending chat action to API');
        const chatResponse = await fetch(`${apiBaseUrl}/chats/${selectedPatientId}/${doctorId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-uid': user.uid,
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({ message, append: true }),
          credentials: 'include',
        });
        if (!chatResponse.ok) throw new Error(`HTTP ${chatResponse.status}: ${await chatResponse.text()}`);

        console.log('Chat action sent successfully');

        const recordData = {
          doctorId,
          patientId: selectedPatientId,
          ...(actionType === 'Diagnosis' || actionType === 'Combined' ? { diagnosis } : { diagnosis: null }),
          ...(actionType === 'Combined' ? { prescription } : { prescription: null }),
        };
        const recordResponse = await fetch(`${apiBaseUrl}/doctors/records`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-uid': user.uid,
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify(recordData),
          credentials: 'include',
        });
        if (!recordResponse.ok) {
          console.error('Record storage failed:', await recordResponse.text());
          throw new Error(`HTTP ${recordResponse.status}: ${await recordResponse.text()}`);
        }
        console.log('Record stored successfully:', recordData);

        if (shouldNotifyAdmin) {
          const selectedPatient = patients.find((p) => p.patientId === selectedPatientId);
          const disease = actionType === 'Combined' || actionType === 'Diagnosis' ? diagnosis : 'N/A';
          const notificationMessage = prescriptionString
            ? `Diagnosis: ${disease}, Prescription: ${prescriptionString}`
            : `Diagnosis: ${disease}`;

          console.log('Sending admin notification');
          const adminResponse = await fetch(`${apiBaseUrl}/admin/notify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-user-uid': user.uid,
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              patientId: selectedPatientId,
              patientName: selectedPatientName || 'Unknown',
              age: selectedPatient?.age || 'N/A',
              sex: selectedPatient?.sex || 'N/A',
              description: notificationMessage,
              disease: disease,
              message: notificationMessage,
              medicine: actionType === 'Combined' ? prescriptionString : undefined,
              doctorId,
            }),
            credentials: 'include',
          });
          if (!adminResponse.ok) throw new Error(`HTTP ${adminResponse.status}: ${await adminResponse.text()}`);
          console.log('Admin notification sent successfully');
        } else {
          console.log('Admin notification skipped due to shouldNotifyAdmin flag');
        }

        setDiagnosis('');
        setPrescription({ medicine: '', dosage: '', frequency: '', duration: '' });
        setShowActionModal(false);
        setActionType('');
        console.log('Action completed successfully:', { diagnosis, prescriptionString });
      } catch (err) {
        const errorMsg = `Failed to send action: ${err.message}`;
        setError(errorMsg);
        console.error('Send action error:', err);
      }
    },
    [actionType, diagnosis, prescription, selectedPatientId, doctorId, user?.uid, selectedPatientName, patients, apiBaseUrl, setError]
  );

  const readAloud = useCallback(
    async (audioUrl, audioUrlEn, audioUrlKn, lang, fallbackText, sender) => {
      console.log('Reading aloud:', { audioUrl, audioUrlEn, audioUrlKn, lang, fallbackText, sender });
      try {
        if (!audioUrl && !audioUrlEn && !audioUrlKn && (!fallbackText || typeof fallbackText !== 'string' || fallbackText.trim() === '')) {
          const errorMsg = 'Cannot read aloud: No valid audio or text provided.';
          setError(errorMsg);
          console.error(errorMsg);
          return;
        }

        const idToken = await getIdToken();
        const normalizedLang = lang === 'kn' ? 'kn-IN' : 'en-US';

        if (sender === 'patient') {
          if (lang === 'kn' && audioUrlKn) {
            await playAudio(audioUrlKn);
            console.log('Played audio from audioUrlKn:', audioUrlKn);
          } else if (audioUrlEn) {
            await playAudio(audioUrlEn);
            console.log('Played audio from audioUrlEn:', audioUrlEn);
          } else if (audioUrl) {
            await playAudio(audioUrl);
            console.log('Played audio from audioUrl as fallback:', audioUrl);
          } else {
            const generatedAudioUrl = await textToSpeechConvert(fallbackText.trim(), normalizedLang, user.uid, idToken);
            await playAudio(generatedAudioUrl);
            console.log('Generated and played audio for text:', fallbackText);
          }
        } else {
          if (lang === 'kn' && audioUrlKn) {
            await playAudio(audioUrlKn);
            console.log('Played audio from audioUrlKn:', audioUrlKn);
          } else if (audioUrlEn) {
            await playAudio(audioUrlEn);
            console.log('Played audio from audioUrlEn:', audioUrlEn);
          } else if (audioUrl) {
            await playAudio(audioUrl);
            console.log('Played audio from audioUrl:', audioUrl);
          } else {
            const generatedAudioUrl = await textToSpeechConvert(fallbackText.trim(), normalizedLang, user.uid, idToken);
            await playAudio(generatedAudioUrl);
            console.log('Generated and played audio for text:', fallbackText);
          }
        }
      } catch (err) {
        const errorMsg = `Failed to read aloud: ${err.message}`;
        setError(errorMsg);
        console.error('Read aloud error:', err);
      }
    },
    [user?.uid, setError]
  );

  const dismissAlert = useCallback((alertId) => {
    console.log('Dismissing alert:', alertId);
    setMissedDoseAlerts((prev) => prev.filter((alert) => alert.id !== alertId));
  }, []);

  const dismissError = useCallback(() => {
    console.log('Dismissing error');
    setError('');
    setFailedUpload(null);
  }, [setError]);

  const isValidPrescription = useCallback((prescription) => {
    console.log('Validating prescription:', prescription);
    return false;
  }, []);

  const onLogout = useCallback(async () => {
    console.log('Logging out user:', user?.uid);
    try {
      await signOut(auth);
      await fetch(`${apiBaseUrl}/misc/logout`, {
        method: 'POST',
        headers: {
          'x-user-uid': user?.uid,
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      if (handleLogout) handleLogout();
      navigate('/login', { replace: true });
      console.log('Logout successful');
    } catch (err) {
      const errorMsg = `Failed to log out: ${err.message}`;
      setError(errorMsg);
      console.error('Logout error:', err);
    }
  }, [auth, apiBaseUrl, user?.uid, handleLogout, navigate, setError]);

  const patientList = useMemo(() => (
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
            console.log('Selected patient:', patient);
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
  ), [patients, selectedPatientId]);

  return (
    <div className="doctor-chat-container">
      <div className="chat-header">
        <button className="hamburger-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle patient menu">
          ☰
        </button>
        <h2>{selectedPatientId ? `Chat with ${selectedPatientName}` : 'Doctor Dashboard'}</h2>
        <div className="header-actions">
          <button onClick={onLogout} className="logout-button" aria-label="Log out">
            Logout
          </button>
        </div>
      </div>
      <div className="chat-layout">
        <div className={`patient-sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Assigned Patients</h3>
            <button className="close-menu" onClick={() => setMenuOpen(false)} aria-label="Close patient menu">
              ✕
            </button>
          </div>
          {loadingPatients ? (
            <p className="loading-text">Loading...</p>
          ) : patients.length === 0 ? (
            <p className="no-patients">No patients assigned.</p>
          ) : (
            patientList
          )}
        </div>
        <div className="chat-content">
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
                  <button onClick={() => handleDiagnosisDecision(true)} className="accept-button" aria-label="Accept chat">
                    Yes
                  </button>
                  <button onClick={() => handleDiagnosisDecision(false)} className="decline-button" aria-label="Decline chat">
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
                        <button onClick={() => dismissAlert(alert.id)} className="dismiss-button" aria-label="Dismiss alert">
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
                            <div className="message-block">
                              {languagePreference === 'en' ? (
                                <>
                                  {msg.imageUrl && (
                                    <img
                                      src={msg.imageUrl}
                                      alt="Patient upload"
                                      className="chat-image"
                                      onError={() => console.error(`Failed to load image: ${msg.imageUrl}`)}
                                    />
                                  )}
                                  <p className="primary-text">{msg.text || 'No transcription'}</p>
                                  {msg.audioUrl && (
                                    <div className="audio-container">
                                      <audio controls aria-label="Patient audio message">
                                        <source src={msg.audioUrl} type="audio/webm" />
                                        Your browser does not support the audio element.
                                      </audio>
                                    </div>
                                  )}
                                  {(msg.audioUrl || msg.audioUrlEn) && (
                                    <div className="read-aloud-buttons">
                                      <button
                                        onClick={() => readAloud(msg.audioUrl, msg.audioUrlEn, msg.audioUrlKn, 'en', msg.text, msg.sender)}
                                        className="read-aloud-button"
                                        aria-label="Read aloud in English"
                                      >
                                        🔊 (English)
                                      </button>
                                    </div>
                                  )}
                                  {msg.audioUrl && (
                                    <a href={msg.audioUrl} download className="download-link">
                                      Download Audio
                                    </a>
                                  )}
                                </>
                              ) : (
                                <>
                                  {msg.imageUrl && (
                                    <img
                                      src={msg.imageUrl}
                                      alt="Patient upload"
                                      className="chat-image"
                                      onError={() => console.error(`Failed to load image: ${msg.imageUrl}`)}
                                    />
                                  )}
                                  <p className="primary-text">{msg.text || 'No transcription'}</p>
                                  {msg.translatedText && (
                                    <p className="translated-text">English: {msg.translatedText}</p>
                                  )}
                                  {msg.audioUrl && (
                                    <div className="audio-container">
                                      <audio controls aria-label="Patient audio message">
                                        <source src={msg.audioUrl} type="audio/webm" />
                                        Your browser does not support the audio element.
                                      </audio>
                                    </div>
                                  )}
                                  {(msg.audioUrl || msg.audioUrlEn || msg.audioUrlKn) && (
                                    <div className="read-aloud-buttons">
                                      {(msg.audioUrl || msg.audioUrlKn) && (
                                        <button
                                          onClick={() => readAloud(msg.audioUrl, msg.audioUrlEn, msg.audioUrlKn, 'kn', msg.text, msg.sender)}
                                          className="read-aloud-button"
                                          aria-label="Read aloud in Kannada"
                                        >
                                          🔊 (Kannada)
                                        </button>
                                      )}
                                      {(msg.audioUrl || msg.audioUrlEn) && (
                                        <button
                                          onClick={() => readAloud(msg.audioUrl, msg.audioUrlEn, msg.audioUrlKn, 'en', msg.translatedText || msg.text, msg.sender)}
                                          className="read-aloud-button"
                                          aria-label="Read aloud in English"
                                        >
                                          🔊 (English)
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {msg.audioUrl && (
                                    <a href={msg.audioUrl} download className="download-link">
                                      Download Audio
                                    </a>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                          {msg.sender === 'doctor' && (
                            <div className="message-block">
                              {msg.text && (
                                <>
                                  {languagePreference === 'kn' ? (
                                    <>
                                      <p className="primary-text">{msg.translatedText || msg.text}</p>
                                      <p className="translated-text">English: {msg.text}</p>
                                    </>
                                  ) : (
                                    <p className="primary-text">{msg.text}</p>
                                  )}
                                  {msg.audioUrl && (
                                    <div className="audio-container">
                                      <audio controls aria-label="Doctor audio message">
                                        <source src={msg.audioUrl} type="audio/webm" />
                                        Your browser does not support the audio element.
                                      </audio>
                                    </div>
                                  )}
                                  {(msg.audioUrlEn || msg.audioUrlKn) && (
                                    <div className="read-aloud-buttons">
                                      {msg.audioUrlKn && languagePreference === 'kn' && (
                                        <button
                                          onClick={() => readAloud(msg.audioUrl, msg.audioUrlEn, msg.audioUrlKn, 'kn', msg.translatedText || msg.text, msg.sender)}
                                          className="read-aloud-button"
                                          aria-label="Read aloud in Kannada"
                                        >
                                          🔊 (Kannada)
                                        </button>
                                      )}
                                      {msg.audioUrlEn && (
                                        <button
                                          onClick={() => readAloud(msg.audioUrl, msg.audioUrlEn, msg.audioUrlKn, 'en', msg.text, msg.sender)}
                                          className="read-aloud-button"
                                          aria-label="Read aloud in English"
                                        >
                                          🔊 (English)
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {msg.audioUrl && (
                                    <a href={msg.audioUrl} download className="download-link">
                                      Download Audio
                                    </a>
                                  )}
                                </>
                              )}
                              {(msg.diagnosis || msg.prescription) && (
                                <div className="recommendation-item">
                                  {msg.diagnosis ? (
                                    <div>
                                      <strong>Diagnosis:</strong> {msg.diagnosis}
                                      <button
                                        onClick={() => readAloud(null, null, null, 'en', msg.diagnosis, msg.sender)}
                                        className="read-aloud-button"
                                        aria-label="Read diagnosis aloud"
                                      >
                                        🔊
                                      </button>
                                    </div>
                                  ) : (
                                    <p className="missing-field">Diagnosis not provided.</p>
                                  )}
                                  {msg.prescription ? (
                                    <div>
                                      <strong>Presötscription:</strong>{' '}
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
                {failedUpload && (
                  <div className="error-container">
                    <p>Failed to upload audio. Would you like to retry?</p>
                    <button
                      onClick={() => retryUpload(failedUpload.audioBlob, failedUpload.language)}
                      className="retry-button"
                      aria-label="Retry audio upload"
                    >
                      Retry
                    </button>
                    <button onClick={dismissError} className="dismiss-error-button" aria-label="Dismiss error">
                      Dismiss
                    </button>
                  </div>
                )}
                {loadingAudio && <p className="loading-audio">Processing audio...</p>}
                <div className="controls">
                  <div className="recording-buttons">
                    <button
                      onClick={startRecording}
                      disabled={recording || loadingAudio || newMessage.trim().length > 0}
                      className={recording || loadingAudio || newMessage.trim().length > 0 ? 'disabled-button' : 'start-button'}
                      aria-label="Start recording"
                    >
                      🎙️ Record
                    </button>
                    <button
                      onClick={stopRecording}
                      disabled={!recording}
                      className={!recording ? 'disabled-button' : 'stop-button'}
                      aria-label="Stop recording"
                    >
                      🛑 Stop
                    </button>
                    <button
                      onClick={() => setShowActionModal(true)}
                      className="action-button"
                      aria-label="Open diagnosis/prescription modal"
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
                      disabled={loadingAudio || recording}
                    />
                    <button
                      onClick={sendMessage}
                      className="send-button"
                      disabled={loadingAudio || recording}
                      aria-label="Send message"
                    >
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
                <button onClick={sendAction} className="submit-button" aria-label={`Submit ${actionType}`}>
                  Send {actionType}
                </button>
              )}
              <button
                onClick={() => {
                  setShowActionModal(false);
                  setActionType('');
                  setDiagnosis('');
                  setPrescription({ medicine: '', dosage: '', frequency: '', duration: '' });
                  console.log('Modal closed and fields reset');
                }}
                className="close-modal"
                aria-label="Close modal"
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
          position: relative;
          z-index: 10;
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
          position: relative;
          z-index: 1;
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

        .chat-image {
          max-width: 100%;
          border-radius: 10px;
          margin-bottom: 10px;
          display: block;
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

        .error-container {
          background: rgba(231, 76, 60, 0.1);
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 20px;
          display: flex;
          gap: 10px;
          align-items: center;
          justify-content: center;
        }

        .error-container p {
          color: #E74C3C;
          font-size: 1rem;
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

        .dismiss-error-button {
          padding: 6px 12px;
          background: #6E48AA;
          color: #FFFFFF;
          border: none;
          border-radius: 20px;
          font-size: 0.9rem;
          cursor: pointer;
          transition: background 0.3s ease, transform 0.3s ease;
        }

        .dismiss-error-button:hover {
          background: #5A3E8B;
          transform: scale(1.05);
        }

        .loading-audio {
          color: #6E48AA;
          font-size: 0.9rem;
          text-align: center;
          margin-bottom: 20px;
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

        .text-input-container input:disabled {
          background: rgba(255, 255, 255, 0.05);
          color: #A0A0A0;
          cursor: not-allowed;
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

        .send-button:disabled {
          background: #666;
          color: #A0A0A0;
          cursor: not-allowed;
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

        .modal-content input,
        .modal-content select,
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